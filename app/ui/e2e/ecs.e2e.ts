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
