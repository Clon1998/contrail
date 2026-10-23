/** M2: cluster → service navigation, the service overview, the ⌘K palette and favorites. */
import { expect, test, type Page } from "@playwright/test";

async function openTreeService(page: Page, cluster: string, service: string) {
  const tree = page.getByRole("tree", { name: "Clusters" });
  const node = tree.getByRole("treeitem", { name: cluster });
  if ((await node.getAttribute("aria-expanded")) !== "true") {
    await node.getByRole("button").first().click();
  }
  await tree.getByRole("treeitem", { name: service }).click();
  return page.getByRole("main", { name: `Service ${service}` });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Clusters" })).toBeVisible();
});

test("tree → crash-looping service shows why its tasks stopped", async ({ page }) => {
  const view = await openTreeService(page, "demo-core", "payments-worker");

  await expect(view.getByRole("region", { name: "Deployments" })).toContainText(
    "payments-worker:17",
  );
  const tasks = view.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByText("EssentialContainerExited")).toHaveCount(2);
  await expect(tasks.getByText("exit 1")).toHaveCount(2);
  await expect(tasks.getByText("CannotPullContainerError: ref not found")).toBeVisible();

  await tasks.getByRole("button", { name: "Hide stopped" }).click();
  await expect(tasks.getByText("exit 1")).toHaveCount(0);
});

test("each task shows the image it runs", async ({ page }) => {
  const view = await openTreeService(page, "demo-core", "orders-api");
  const tasks = view.getByRole("region", { name: "Tasks" });
  const image = tasks.getByRole("row").nth(1).getByRole("cell", { name: "1.14.2" });
  await expect(image).toBeVisible();
  await image.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "sha256:" })).toHaveCount(1);
});

test("a rollout in progress shows both deployments", async ({ page }) => {
  const view = await openTreeService(page, "demo-core", "billing-sync");
  const deployments = view.getByRole("region", { name: "Deployments" });
  await expect(deployments.getByRole("row")).toHaveCount(3); // header + 2
  await expect(deployments).toContainText("IN_PROGRESS");
  await expect(deployments).toContainText("billing-sync:7");
});

test("a long task definition fits: cut at the front, revision visible", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const view = await openTreeService(page, "demo-edge", "event-ingest");
  const name = "EventIngestStackDemoEdgeIngestTaskDefinition4F2A9C1E:5";
  const deployments = view.getByRole("region", { name: "Deployments" });
  await expect(deployments.getByTitle(name)).toBeVisible();

  // Nothing in the overview scrolls sideways.
  const overview = view.getByRole("tabpanel", { name: "Overview" });
  const overflow = await overview.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The name is cut at the front: its right edge (the revision) is inside the cell.
  const cell = deployments.getByTitle(name);
  const clipped = await cell.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(true);
});

test("the overview lists environment variables, masking secret-looking values", async ({
  page,
}) => {
  const view = await openTreeService(page, "demo-core", "orders-api");
  const env = view.getByRole("region", { name: "Environment" });
  await expect(env.getByRole("row", { name: /SPRING_PROFILES_ACTIVE/ })).toContainText("demo");

  const password = env.getByRole("row", { name: /DB_PASSWORD/ });
  await expect(password).not.toContainText("demo-not-a-secret");
  await password.getByRole("button", { name: "Show value" }).click();
  await expect(password).toContainText("demo-not-a-secret");

  // Secrets show only where they come from.
  await expect(env.getByRole("row", { name: /API_TOKEN/ })).toContainText(
    "parameter/demo/orders-api",
  );

  // A secret's value is read on request, and can be hidden again.
  const token = env.getByRole("row", { name: /API_TOKEN/ });
  await token.getByRole("button", { name: "Reveal" }).click();
  await expect(token).toContainText("demo-api-token-not-a-real-secret");
  await token.getByRole("button", { name: "Hide value" }).click();
  await expect(token).not.toContainText("demo-api-token-not-a-real-secret");

  await env.getByRole("searchbox", { name: "Filter variables" }).fill("server");
  await expect(env.getByRole("row", { name: /SERVER_PORT/ })).toBeVisible();
  await expect(env.getByRole("row", { name: /SPRING_PROFILES_ACTIVE/ })).toHaveCount(0);
});

test("⌘K jumps to a service in a collapsed cluster", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByRole("dialog", { name: "Go to service" });
  await palette.getByPlaceholder("Go to service…").fill("gateway");
  await palette.getByRole("option", { name: /legacy-gateway/ }).click();

  const view = page.getByRole("main", { name: "Service legacy-gateway" });
  await expect(view).toContainText("EC2");
  // The tree follows: the cluster opened and the service is selected.
  await expect(page.getByRole("treeitem", { name: "legacy-gateway" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("recent services work across profiles", async ({ page }) => {
  await openTreeService(page, "demo-edge", "event-ingest");

  await page.getByRole("combobox", { name: "AWS profile" }).click();
  await page.getByRole("option", { name: /demo-staging/ }).click();
  await expect(page.getByRole("combobox", { name: "AWS profile" })).toContainText("demo-staging");

  await page.keyboard.press("ControlOrMeta+K");
  const recent = page.getByRole("dialog", { name: "Go to service" }).getByRole("group", {
    name: "Recent",
  });
  await recent.getByRole("option", { name: /event-ingest/ }).click();

  await expect(page.getByRole("combobox", { name: "AWS profile" })).toContainText("demo-dev");
  await expect(page.getByRole("main", { name: "Service event-ingest" })).toBeVisible();
});

test("favorites are pinned to the sidebar", async ({ page }) => {
  const view = await openTreeService(page, "demo-core", "orders-api");
  await view.getByRole("button", { name: "Add to favorites" }).click();

  const favorites = page.getByRole("region", { name: "Favorites" });
  await expect(favorites).toContainText("orders-api");

  await openTreeService(page, "demo-edge", "event-ingest");
  await favorites.getByRole("button", { name: /orders-api/ }).click();
  await expect(page.getByRole("main", { name: "Service orders-api" })).toBeVisible();

  await page.getByRole("button", { name: "Remove from favorites" }).click();
  await expect(favorites).toBeHidden();
});

test("an expired profile gets its tree after logging in", async ({ page }) => {
  await page.getByRole("combobox", { name: "AWS profile" }).click();
  await page.getByRole("option", { name: /demo-prod/ }).click();
  await expect(page.getByRole("tree", { name: "Clusters" })).toBeHidden();

  await page.getByRole("banner").getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("tree", { name: "Clusters" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "demo-core" })).toBeVisible();
});

test("routes of a routing-framework service as a graph, and the services on the same topic", async ({
  page,
}) => {
  const view = await openTreeService(page, "demo-edge", "event-ingest");
  const routes = view.getByRole("region", { name: "Routes" });
  const graph = routes.getByRole("group", { name: "Route graph" });
  await expect(graph.getByRole("button", { name: "system Example Partner" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "topic demo.events" })).toBeVisible();
  // Settings only on request.
  await expect(routes).not.toContainText("sftp.example.com");
  await graph.getByRole("button", { name: "topic demo.events" }).click();
  const details = routes.getByRole("region", { name: "Route details" });
  await expect(details.getByRole("region", { name: "Input" })).toContainText("sftp");
  await expect(details).toContainText("sftp.example.com");

  await routes.getByRole("button", { name: "Find connected services" }).click();
  await graph.getByRole("button", { name: "service legacy-gateway" }).click();
  await routes.getByRole("button", { name: "Open legacy-gateway" }).click();

  const gateway = page.getByRole("main", { name: "Service legacy-gateway" });
  const gatewayRoutes = gateway.getByRole("region", { name: "Routes" });
  const gatewayGraph = gatewayRoutes.getByRole("group", { name: "Route graph" });
  await expect(
    gatewayGraph.getByRole("button", { name: "system Example Partner API (disabled)" }),
  ).toBeVisible();
  // Its own consumer group once, not on every topic.
  await expect(gatewayRoutes).toContainText("Reads its topics as consumer group legacy-gateway");
  // The other reader of the same topic, its group and where it sends the data.
  await gatewayRoutes.getByRole("button", { name: "Find connected services" }).click();
  await expect(gatewayGraph.getByRole("button", { name: "service audit-archiver" })).toContainText(
    "group audit-archiver",
  );
  await expect(gatewayGraph.getByRole("button", { name: "system Search Index" })).toBeVisible();

  // Three routes write to one system: one node, its shared connection once, the queues per route.
  await expect(gatewayGraph.getByRole("button", { name: "system Billing" })).toHaveCount(1);
  await gatewayGraph.getByRole("button", { name: "system Billing" }).click();
  const billing = gatewayRoutes.getByRole("region", { name: "Route details" });
  const shared = billing.getByRole("region", { name: "Shared settings" });
  await expect(shared).toContainText("brokerurl");
  await expect(shared).toContainText("secret:demo/billing-mq");
  const perRoute = billing.getByRole("table", { name: "Routes to this system" });
  await expect(perRoute.getByRole("row", { name: /shipments\.dispatched/ })).toContainText(
    "billing/queue/SHIPMENT_IN",
  );
  // A password from Secrets Manager: its value only on Reveal.
  await shared.getByRole("button", { name: "Reveal" }).click();
  await expect(shared).toContainText("not-a-real-secret");

  // Credentials in endpoint settings are masked.
  await gatewayGraph.getByRole("button", { name: "topic demo.events" }).click();
  await expect(gatewayRoutes.getByRole("region", { name: "Output 2" })).toContainText("disabled");
  await expect(gatewayRoutes).not.toContainText("demo-not-a-secret");
});
