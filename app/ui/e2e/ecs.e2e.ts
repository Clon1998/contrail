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
  // The service itself is a node, selected at first.
  await expect(
    graph.getByRole("button", { name: "service event-ingest (this service)" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(graph.getByRole("button", { name: "system Example Partner" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "topic demo.events" })).toBeVisible();
  // Settings only on request.
  await expect(routes).not.toContainText("sftp.example.com");
  await graph.getByRole("button", { name: "topic demo.events" }).click();
  const details = routes.getByRole("region", { name: "Route details" });
  await expect(details.getByRole("region", { name: "Input" })).toContainText("sftp");
  await expect(details).toContainText("sftp.example.com");

  await expect(routes).toContainText("Input service");
  await routes.getByRole("button", { name: "Find connected services" }).click();
  // The readers of its topic follow with their consumer groups; another writer of the topic sits
  // next to it.
  await expect(graph.getByRole("button", { name: "service audit-archiver" })).toContainText(
    "group audit-archiver",
  );
  await expect(graph.getByRole("button", { name: "service partner-poller" })).toBeVisible();
  await graph.getByRole("button", { name: "service legacy-gateway" }).click();
  await routes.getByRole("button", { name: "Open legacy-gateway" }).click();

  const gateway = page.getByRole("main", { name: "Service legacy-gateway" });
  const gatewayRoutes = gateway.getByRole("region", { name: "Routes" });
  const gatewayGraph = gatewayRoutes.getByRole("group", { name: "Route graph" });
  await expect(
    gatewayGraph.getByRole("button", { name: "system Example Partner API (disabled)" }),
  ).toBeVisible();
  // Its own consumer group once, not on every topic.
  await expect(gatewayRoutes).toContainText(
    "Output service: reads Kafka topics as consumer group legacy-gateway",
  );
  // The cluster's scan is kept: the writers of its topics come before them right away, and
  // another reader sits next to it.
  await expect(gatewayGraph.getByRole("button", { name: "service event-ingest" })).toBeVisible();
  await expect(gatewayGraph.getByRole("button", { name: "service audit-archiver" })).toContainText(
    "group audit-archiver",
  );
  await expect(
    gatewayGraph.getByRole("button", { name: "service legacy-gateway (this service)" }),
  ).toContainText("this service");

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

  // Back on the first tab, its connected services are still there.
  await page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: "event-ingest" })
    .click();
  const ingestGraph = page
    .getByRole("main", { name: "Service event-ingest" })
    .getByRole("group", { name: "Route graph" });
  await expect(ingestGraph.getByRole("button", { name: "service audit-archiver" })).toBeVisible();
});

test("a cluster's route map, with a transformer found in its startup logs", async ({ page }) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-edge" }).hover();
  await tree.getByRole("button", { name: "Route map of demo-edge" }).click();

  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  await expect(tabs.getByRole("tab", { name: "Routes demo-edge" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const map = page.getByRole("main", { name: "Route map demo-edge" });
  const graph = map.getByRole("group", { name: "Cluster route map" });
  await expect(graph.getByRole("button", { name: "service event-ingest" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "service search-feeder" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "topic orders.created" })).toBeVisible();
  // The transformer has no routes, but its startup lines say what it reads and writes.
  const enricher = graph.getByRole("button", { name: "service event-enricher" });
  await expect(enricher).toContainText("transformer");
  await expect(map.getByText(/services? ha(s|ve) no routes/)).toHaveCount(0);
  await enricher.click();
  const details = map.getByRole("region", { name: "Node details" });
  await expect(details).toContainText("from the startup logs of task");
  await expect(details).toContainText("demo.events: event-enricher ×3");

  // Entered by hand, its topics take the place of what the logs say.
  await details.getByRole("button", { name: "Override topics" }).click();
  const form = map.getByRole("form", { name: "Transformer" });
  await expect(form.getByLabel("Reads")).toHaveValue("demo.events");
  await form.getByLabel("Writes").fill("demo.events.enriched, demo.events.audit");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(graph.getByRole("button", { name: "topic demo.events.audit" })).toBeVisible();
  await expect(details).toContainText("topics entered by hand");
  await enricher.click();

  // Finding a service keeps what lies on its paths: the way to it, not its siblings.
  await map.getByRole("searchbox", { name: "Find in the route map" }).fill("search-feeder");
  await expect(graph.getByRole("button", { name: "service event-enricher" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "service event-ingest" })).toBeVisible();
  await expect(graph.getByRole("button", { name: "service legacy-gateway" })).toHaveCount(0);

  // A service opens from the map; the map stays in its tab.
  await graph.getByRole("button", { name: "service search-feeder" }).click();
  await map.getByRole("button", { name: "Open search-feeder" }).click();
  await expect(page.getByRole("main", { name: "Service search-feeder" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "Routes demo-edge" })).toBeVisible();
});

test("the route map: colours, settings, search by setting and narrowing to one side", async ({
  page,
}) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-edge" }).hover();
  await tree.getByRole("button", { name: "Route map of demo-edge" }).click();
  const map = page.getByRole("main", { name: "Route map demo-edge" });
  const graph = map.getByRole("group", { name: "Cluster route map" });
  const node = (name: string) => graph.getByRole("button", { name, exact: true });

  // Selecting a service shows its routes with their settings; secrets stay hidden.
  await node("service legacy-gateway").click();
  const details = map.getByRole("region", { name: "Node details" });
  const routes = details.getByRole("list", { name: "Routes of legacy-gateway" });
  await expect(routes).toContainText("billing/queue/ORDER_IN");
  await expect(routes).toContainText("secret");
  await expect(routes).not.toContainText("demo-not-a-secret");
  await expect(map.getByText("feeds into the selection")).toBeVisible();

  // The details open beside the map; a node at its right edge moves into view, and back when
  // they close, unless the map was moved by hand meanwhile.
  await page.keyboard.press("Escape");
  const catalog = node("system Product Catalog");
  const x = async () => (await catalog.boundingBox())?.x ?? Number.NaN;
  const before = await x();
  const inView = async () => {
    const area = await graph.boundingBox();
    const box = await catalog.boundingBox();
    return area && box ? box.x + box.width <= area.x + area.width : false;
  };
  await catalog.click();
  await expect(details).toBeVisible();
  await expect.poll(inView).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(async () => Math.round(Math.abs((await x()) - before))).toBeLessThan(2);

  await catalog.click();
  await expect.poll(inView).toBe(true);
  await map.getByRole("button", { name: "Zoom out" }).click();
  await page.waitForTimeout(400);
  const moved = await x();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect(Math.abs((await x()) - moved)).toBeLessThan(2);
  await map.getByRole("button", { name: "Fit the map" }).click();

  // Esc or the toolbar button clears the selection.
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await node("service legacy-gateway").click();
  await map.getByRole("button", { name: "Clear selection" }).click();
  await expect(details).toHaveCount(0);

  // A setting finds its route: the partner's host leads to the input service writing its topic,
  // not to the other writer of that topic or its source.
  const search = map.getByRole("searchbox", { name: "Find in the route map" });
  await search.fill("sftp.example");
  await expect(node("system Example Partner")).toContainText("host: sftp.example");
  await expect(node("service event-ingest")).toBeVisible();
  await expect(node("service partner-poller")).toHaveCount(0);
  await expect(node("system Order Portal")).toHaveCount(0);

  // Enter and Shift+Enter step through the matches.
  await search.fill("example.com");
  const count = map.getByLabel("Matches");
  await expect(count).toHaveText(/^– \/ \d+$/);
  await search.press("Enter");
  await expect(count).toHaveText(/^1 \/ \d+$/);
  await search.press("Enter");
  await expect(count).toHaveText(/^2 \/ \d+$/);
  await search.press("Shift+Enter");
  await expect(count).toHaveText(/^1 \/ \d+$/);
  await search.fill("");
  // "/" goes to the search from the map.
  await search.blur();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.blur();

  // Switched-off routes can be hidden.
  await expect(node("system Example Partner API (disabled)")).toBeVisible();
  await map.getByRole("button", { name: "Hide disabled" }).click();
  await expect(node("system Example Partner API (disabled)")).toHaveCount(0);
  await expect(node("system Archive")).toBeVisible();
  await map.getByRole("button", { name: "Show disabled" }).click();
  await expect(node("system Example Partner API (disabled)")).toBeVisible();

  // The whole map can be saved as an image.
  for (const format of ["PNG image (.png)", "SVG image (.svg)"]) {
    await map.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: format }).click();
    await expect(map.getByRole("status").filter({ hasText: "Saved the map" })).toBeVisible();
  }

  // Right-click narrows the map to what feeds into a node.
  await node("service search-feeder").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Only what feeds into it" }).click();
  await expect(map.getByText("Only what feeds into")).toBeVisible();
  await expect(node("service event-enricher")).toBeVisible();
  await expect(node("service audit-archiver")).toHaveCount(0);
  await expect(node("system Product Catalog")).toHaveCount(0);
  await map.getByRole("button", { name: "Show the whole map" }).click();
  await expect(node("service audit-archiver")).toBeVisible();
});

test("the route map comes back as it was after another tab", async ({ page }) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-edge" }).hover();
  await tree.getByRole("button", { name: "Route map of demo-edge" }).click();
  const map = page.getByRole("main", { name: "Route map demo-edge" });
  const graph = map.getByRole("group", { name: "Cluster route map" });
  const gateway = graph.getByRole("button", { name: "service legacy-gateway", exact: true });

  await map.getByRole("searchbox", { name: "Find in the route map" }).fill("demo");
  await gateway.click();
  await map.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(400);
  const before = await gateway.boundingBox();

  await tree.getByRole("treeitem", { name: "demo-edge" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "legacy-gateway" }).click();
  await expect(page.getByRole("main", { name: "Service legacy-gateway" })).toBeVisible();
  await page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: /Routes/ })
    .click();

  await expect(map.getByRole("searchbox", { name: "Find in the route map" })).toHaveValue("demo");
  await expect(map.getByRole("region", { name: "Node details" })).toContainText("legacy-gateway");
  await expect
    .poll(async () => {
      const after = await gateway.boundingBox();
      return after && before
        ? Math.round(Math.abs(after.x - before.x) + Math.abs(after.y - before.y))
        : -1;
    })
    .toBeLessThan(2);
});
