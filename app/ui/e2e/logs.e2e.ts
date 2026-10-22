/** M3/M4: the log viewer — rows, expanding, copying, columns, task view, 100k lines. */
import { expect, test, type Page } from "@playwright/test";

async function openLogs(page: Page, cluster: string, service: string) {
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: cluster }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: service }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  return page.getByRole("list", { name: "Log events" });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("plain-text logs with split stack traces joined, expanded with highlighting", async ({
  page,
}) => {
  const list = await openLogs(page, "demo-edge", "legacy-gateway");
  await expect(list).toHaveAttribute("aria-rowcount", "25");
  await expect(page.getByText("/ecs/legacy-gateway · 2 streams")).toBeVisible();
  // No stack trace frame shows up as a log line of its own.
  await expect(list.getByText(/^\s*at /)).toHaveCount(0);

  await list
    .getByRole("button", { name: /Polling failed/ })
    .first()
    .click();
  const trace = list.getByLabel("Stack trace");
  await expect(trace).toContainText("Caused by: java.net.SocketTimeoutException");
  await expect(list.getByLabel("Fields")).toContainText("process.thread.name");
});

test("ECS rows show fields, raw JSON and copy the JSON", async ({ page, browserName, context }) => {
  const list = await openLogs(page, "demo-core", "payments-worker");
  await list
    .getByRole("button", { name: /Error while settling batch/ })
    .first()
    .click();
  await expect(list.getByLabel("Stack trace")).toBeVisible();
  // Long traces start collapsed.
  await expect(list.getByRole("button", { name: /Show all \d+ lines/ })).toBeVisible();

  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only in Playwright");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await list.getByRole("button", { name: "Copy JSON" }).first().click();
  await expect(list.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)["log.level"]).toMatch(/ERROR|WARN/);
});

test("optional columns", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Logger" }).click();
  await page.keyboard.press("Escape");
  await expect(list.getByText(/^com\.example\./).first()).toBeVisible();
});

test("a task's logs from the task list, and back to all tasks", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-edge" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "legacy-gateway" }).click();
  await page
    .getByRole("button", { name: /^Logs of task / })
    .first()
    .click();

  await expect(page.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("/ecs/legacy-gateway · 1 stream")).toBeVisible();
  await page.getByRole("button", { name: "Show all tasks" }).click();
  await expect(page.getByText("/ecs/legacy-gateway · 2 streams")).toBeVisible();
});

test("100,000 lines: starts at the newest, scrolls to the oldest, jumps back", async ({ page }) => {
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(list).toHaveAttribute("aria-rowcount", "100000");
  await expect(list.getByText("Ingested event #100000 ")).toBeVisible();

  const scroller = list.locator("..");
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(list.getByText("Ingested event #1 ", { exact: false }).first()).toBeVisible();
  // Only a window of rows exists in the DOM.
  expect(await list.getByRole("listitem").count()).toBeLessThan(200);

  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(list.getByText("Ingested event #100000 ")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();
});
