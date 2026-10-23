/** M6: session search — query types, modes, navigation, chips, click-to-filter, noise. */
import { expect, test, type Page } from "@playwright/test";

async function openLogs(page: Page, cluster: string, service: string, url = "/") {
  await page.goto(url);
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: cluster }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: service }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  const list = page.getByRole("list", { name: "Log events" });
  await expect(list).toBeVisible();
  return list;
}

async function rowCount(page: Page) {
  return Number(await page.getByRole("list", { name: "Log events" }).getAttribute("aria-rowcount"));
}

test("free text, level and negation narrow the list", async ({ page }) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  const search = page.getByRole("textbox", { name: "Search logs" });
  const all = await rowCount(page);

  await search.fill("shipment");
  await expect.poll(() => rowCount(page)).toBeLessThan(all);
  const shipments = await rowCount(page);
  await expect(page.getByLabel("Match count")).toContainText(`${shipments} of`);
  // Matching words are marked.
  await expect(page.locator("mark").first()).toHaveText(/shipment/i);

  await search.fill("shipment level>=WARN");
  await expect.poll(() => rowCount(page)).toBeLessThan(shipments);

  await search.fill("-shipment");
  await expect.poll(() => rowCount(page)).toBeLessThan(all);
  // (The live tail keeps adding rows, so counts are compared loosely.)
  await expect(page.getByRole("list", { name: "Log events" }).getByText(/shipment/i)).toHaveCount(
    0,
  );
});

test("field globs and click-to-filter", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  const search = page.getByRole("textbox", { name: "Search logs" });
  await search.fill("log.logger:*StatusManager*");
  await expect.poll(() => rowCount(page)).toBeGreaterThan(0);

  await search.fill("");
  await list.getByRole("button").first().click();
  // Clicking a field value adds key:value to the search.
  await list.getByLabel("Fields").getByRole("button", { name: "DEMO" }).click();
  await expect(search).toHaveValue("service.environment:DEMO");
});

test("invalid queries explain themselves", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  await page.getByRole("textbox", { name: "Search logs" }).fill("level:LOUD");
  await expect(page.getByRole("alert")).toContainText('unknown level "LOUD"');
  await expect(page.getByRole("alert")).toContainText("TRACE, DEBUG, INFO, WARN, ERROR");
});

test("highlight mode marks matches and steps through them", async ({ page }) => {
  await openLogs(page, "demo-core", "payments-worker");
  // A live event arriving in between would change the count: pause the tail first.
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();
  const all = await rowCount(page);
  await page.getByRole("radio", { name: "highlight" }).click();
  const search = page.getByRole("textbox", { name: "Search logs" });
  await search.fill("settling");
  await expect(page.getByLabel("Match count")).toContainText("matches");
  expect(await rowCount(page)).toBe(all);

  await search.press("Enter");
  await expect(page.getByLabel("Match count")).toContainText(/^1 \//);
  await page.keyboard.press("F3");
  await expect(page.getByLabel("Match count")).toContainText(/^2 \//);
  await page.keyboard.press("Shift+F3");
  await expect(page.getByLabel("Match count")).toContainText(/^1 \//);
});

test("level chips hide levels", async ({ page }) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  const all = await rowCount(page);
  const levels = page.getByRole("group", { name: "Levels" });
  await levels.getByRole("button", { name: /^INFO / }).click();
  await expect.poll(() => rowCount(page)).toBeLessThan(all);
  await levels.getByRole("button", { name: /^INFO / }).click();
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(all);
});

test("level chips: middle click shows only that level, right click offers more", async ({
  page,
}) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  const all = await rowCount(page);
  const levels = page.getByRole("group", { name: "Levels" });
  const warn = levels.getByRole("button", { name: /^WARN / });

  await warn.click({ button: "middle" });
  await expect(warn).toHaveAttribute("aria-pressed", "true");
  await expect(levels.getByRole("button", { name: /^INFO / })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect.poll(() => rowCount(page)).toBeLessThan(all);

  await levels.getByRole("button", { name: /^INFO / }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "INFO and above" }).click();
  await expect(levels.getByRole("button", { name: /^ERROR / })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(levels.getByRole("button", { name: /^DEBUG / })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await warn.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show all levels" }).click();
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(all);
});

test("hide noise from a line and show it again", async ({ page }) => {
  const list = await openLogs(page, "demo-edge", "legacy-gateway");
  const all = await rowCount(page);
  await list
    .getByRole("button", { name: /GET \/actuator\/health/ })
    .first()
    .click();
  await list.getByRole("button", { name: "Hide lines like this" }).click();
  await expect.poll(() => rowCount(page)).toBeLessThan(all);

  await page.getByRole("button", { name: "Noise" }).click();
  await page.getByRole("button", { name: /Show lines like GET \/actuator\/health/ }).click();
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(all);
});

test("regex mode reads the whole search as one expression", async ({ page }) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  const all = await rowCount(page);
  await page.getByRole("button", { name: "Regular expression" }).click();
  const search = page.getByRole("textbox", { name: "Search logs" });
  await search.fill("(");
  await expect(search).toHaveAttribute("aria-invalid", "true");
  // Spaces are part of the expression, not separate terms.
  await search.fill("GET /\\S+ ");
  await expect(search).toHaveAttribute("aria-invalid", "false");
  await expect.poll(() => rowCount(page)).toBeLessThan(all);
  await expect.poll(() => rowCount(page)).toBeGreaterThan(0);
});

test("the search options use the app's checkboxes", async ({ page }) => {
  await openLogs(page, "demo-edge", "legacy-gateway");
  const wholeLine = page.getByRole("checkbox", { name: "whole line" });
  await wholeLine.click();
  await expect(wholeLine).toHaveAttribute("data-state", "checked");

  await page.getByRole("button", { name: "Noise" }).click();
  const hide = page.getByRole("checkbox", { name: "Hide lines containing these texts" });
  await expect(hide).toHaveAttribute("data-state", "checked");
});

test("changing the search swaps the rows without a placeholder flash", async ({ page }) => {
  // Row fetches take a second: rows that had to be fetched after the change would show "…".
  const list = await openLogs(page, "demo-edge", "legacy-gateway", "/?rowsDelay=1000");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  // All rows on screen are loaded.
  await expect(list.getByText("…", { exact: true })).toHaveCount(0, { timeout: 5_000 });

  const watch = page.evaluate(async () => {
    const scroller = document.querySelector('[aria-label="Log events"]')?.parentElement;
    let frames = 0;
    const end = performance.now() + 2_500;
    while (performance.now() < end) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (
        scroller &&
        [...scroller.querySelectorAll('[role="listitem"]')].some((row) => row.textContent === "…")
      ) {
        frames++;
      }
    }
    return frames;
  });
  await page.waitForTimeout(100); // the frame watch is running
  await page.getByRole("textbox", { name: "Search logs" }).fill("GET");
  expect(await watch).toBe(0);
  await expect(page.getByLabel("Match count")).toBeVisible();
});
