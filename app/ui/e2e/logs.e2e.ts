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
  const picker = page.getByRole("combobox", { name: "Task" });
  await expect(picker).toContainText("task ");
  await picker.click();
  await page.getByRole("option", { name: "All tasks" }).click();
  await expect(page.getByText("/ecs/legacy-gateway · 2 streams")).toBeVisible();
});

test("pick one task in the logs toolbar", async ({ page }) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  await expect(page.getByText("/ecs/legacy-gateway · 2 streams")).toBeVisible();

  await page.getByRole("combobox", { name: "Task" }).click();
  // Running tasks first, with their status.
  await page
    .getByRole("option", { name: /RUNNING/ })
    .first()
    .click();
  await expect(page.getByText("/ecs/legacy-gateway · 1 stream")).toBeVisible();
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

test("live: new events arrive, pause stops them, resume continues", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  // The fake backend adds an event per second.
  await expect
    .poll(async () => Number(await list.getAttribute("aria-rowcount")), { timeout: 5_000 })
    .toBeGreaterThan(25);

  await page.getByRole("button", { name: "Pause live tail" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();
  const paused = Number(await list.getAttribute("aria-rowcount"));
  await page.waitForTimeout(1_500);
  expect(Number(await list.getAttribute("aria-rowcount"))).toBe(paused);

  await page.getByRole("button", { name: "Resume live tail" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  await expect
    .poll(async () => Number(await list.getAttribute("aria-rowcount")), { timeout: 5_000 })
    .toBeGreaterThan(paused);
});

test("live: following stops when scrolled up and resumes with Jump to latest", async ({ page }) => {
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  await list.locator("..").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  // New events (the generated view grows while live) don't pull the list down.
  const before = Number(await list.getAttribute("aria-rowcount"));
  await expect
    .poll(async () => Number(await list.getAttribute("aria-rowcount")), { timeout: 5_000 })
    .toBeGreaterThan(before);
  await expect(list.getByText("Ingested event #1 ", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();
});

test("time windows: longer ones open paused, a fixed range isn't followed", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  const windows = page.getByRole("radiogroup", { name: "Time window" });
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();

  await windows.getByRole("radio", { name: "1 h" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();
  await page.getByRole("button", { name: "Resume live tail" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();

  // Custom: the last 2 days.
  await windows.getByRole("radio", { name: "Custom" }).click();
  const relative = page.getByRole("form", { name: "Relative time window" });
  await relative.getByLabel("Amount").fill("2");
  await relative.getByRole("radio", { name: "d" }).click();
  await relative.getByRole("button", { name: "Apply" }).click();
  await expect(windows.getByRole("radio", { name: "2 d" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();

  // Custom: a fixed range.
  await windows.getByRole("radio", { name: "2 d" }).click();
  const range = page.getByRole("form", { name: "Fixed time range" });
  await range.getByLabel("From").fill("2026-01-15T09:00");
  await range.getByLabel("To").fill("2026-01-15T10:00");
  await range.getByRole("button", { name: "Apply" }).click();
  await expect(windows.getByRole("radio", { name: "01-15 09:00 – 01-15 10:00" })).toBeVisible();
  await expect(page.getByText("fixed range", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: /^Live tail/ })).toHaveCount(0);
});

test("newest first: the newest event on top, new events arrive there", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Logs" }).click();
  await dialog.getByRole("checkbox", { name: "Newest first" }).click();
  await page.keyboard.press("Escape");

  const list = await openLogs(page, "demo-edge", "event-ingest");
  const top = list.locator('[aria-posinset="1"]');
  await expect(top).toContainText("Ingested event #100000 ");
  // Live events (the generated view grows) appear at the top while following.
  await expect(top).not.toContainText("Ingested event #100000 ", { timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();

  // Scrolled away, rows added on top don't move what's being read.
  const scroller = list.locator("..");
  await scroller.evaluate((el) => {
    el.scrollTop = 2_000;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const readLine = () =>
    scroller.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + 100)?.textContent ?? "";
    });
  const before = await readLine();
  const rows = Number(await list.getAttribute("aria-rowcount"));
  await expect
    .poll(async () => Number(await list.getAttribute("aria-rowcount")), { timeout: 5_000 })
    .toBeGreaterThan(rows);
  expect(await readLine()).toBe(before);
});
