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

  // A middle-button mousedown (what Contrail reacts to): Playwright's real middle click is
  // unreliable in WebKit.
  await warn.dispatchEvent("mousedown", { button: 1 });
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

test("pipeline status events: state badges, state chips and one document", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await page.getByRole("button", { name: "Fields" }).click();
  const states = page.getByRole("group", { name: "Pipeline states" });
  await expect(states.getByRole("button", { name: /^COMPLETED \d+/ })).toBeVisible();

  // A state chip filters by that state.
  await states.getByRole("button", { name: /^FAILED / }).click();
  await expect(page.getByRole("textbox", { name: "Search logs" })).toHaveValue("state:FAILED");
  await expect.poll(() => rowCount(page)).toBe(1);
  const row = list.getByRole("listitem").first();
  await expect(row.getByText("FAILED", { exact: true })).toBeVisible();

  // "Show this document" lists every event of its correlation ID.
  await row.getByRole("button").first().click();
  await page.getByRole("button", { name: "Show this document" }).click();
  await expect(page.getByRole("textbox", { name: "Search logs" })).toHaveValue(/^correlation:\S+$/);
  await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(1);
});

test("the Fields panel counts the matching events' values and filters by click", async ({
  page,
}) => {
  await openLogs(page, "demo-core", "orders-api");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  const search = page.getByRole("textbox", { name: "Search logs" });
  // F opens it (and closes it again).
  await page.keyboard.press("f");
  const panel = page.getByRole("complementary", { name: "Fields" });
  await expect(panel).toBeVisible();

  // A field's most common values, with counts; a click filters by one.
  const fields = panel.getByRole("region", { name: "All fields" });
  await fields.getByRole("textbox", { name: "Filter fields" }).fill("logger");
  await fields.getByRole("button", { name: /^log\.logger/ }).click();
  const values = fields.getByRole("list", { name: "Values of log.logger" });
  await values.getByRole("button", { name: /^com\.example\.cache\.CatalogCache \d+$/ }).click();
  await expect(search).toHaveValue("log.logger:com.example.cache.CatalogCache");
  // Counted again over the matches: only that value is left; a second click removes it.
  await expect(values.getByRole("button")).toHaveCount(1);
  await values.getByRole("button").click();
  await expect(search).toHaveValue("");
  // Alt+click excludes the value.
  await values.getByRole("button", { name: /^com\.example\.cache\.CatalogCache/ }).click({
    modifiers: ["Alt"],
  });
  await expect(search).toHaveValue("-log.logger:com.example.cache.CatalogCache");
  await expect(values.getByRole("button", { name: /CatalogCache/ })).toHaveCount(0);
  await search.press("Escape");

  // The pipeline overview: a state on a topic, the failure reasons, the documents.
  const pipeline = panel.getByRole("region", { name: "Pipeline" });
  const perTopic = pipeline.getByRole("list", { name: "States per topic" });
  await perTopic
    .getByRole("button", { name: /^example\.returns\.events\.v1 COMPLETED \d+$/ })
    .click();
  await expect(search).toHaveValue("state:COMPLETED topic:example.returns.events.v1");
  await expect(perTopic.getByRole("listitem")).toHaveCount(1);
  await search.press("Escape");

  const reasons = pipeline.getByRole("list", { name: "Failure reasons" });
  await reasons.getByRole("button").first().click();
  await expect(search).toHaveValue(/^state:FAILED pipeline\.message:"Processing failed: [^"]+"$/);
  await expect(pipeline.getByRole("group", { name: "Pipeline states" })).toContainText("FAILED");
  await search.press("Escape");

  const documents = pipeline.getByRole("list", { name: "Documents" });
  await documents.getByRole("button", { name: /Completed/ }).click();
  await documents
    .getByRole("list", { name: "Completed documents" })
    .getByRole("button")
    .first()
    .click();
  await expect(search).toHaveValue(/^correlation:\S+$/);

  // The panel stays open for this service while another tab is shown.
  await page
    .getByRole("tree", { name: "Clusters" })
    .getByRole("treeitem", { name: "billing-sync" })
    .click();
  await page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: "orders-api" })
    .click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("f");
  await expect(panel).toBeHidden();
});

test("trace a document across services, in a tab of its own", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await page.getByRole("button", { name: "Fields" }).click();
  await page
    .getByRole("group", { name: "Pipeline states" })
    .getByRole("button", { name: /^FAILED / })
    .click();
  await expect.poll(() => rowCount(page)).toBe(1);
  await list.getByRole("listitem").first().getByRole("button").first().click();
  await page.getByRole("button", { name: "Trace across services" }).click();

  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  await expect(tabs.getByRole("tab", { name: /^Trace / })).toHaveAttribute("aria-selected", "true");
  const trace = page.getByRole("main", { name: /^Trace / });
  // The current service is chosen; add another one of the cluster.
  await expect(trace.getByRole("checkbox", { name: "orders-api" })).toHaveAttribute(
    "data-state",
    "checked",
  );
  await trace.getByRole("checkbox", { name: "payments-worker" }).click();
  await trace.getByRole("button", { name: "Search 2 services" }).click();

  await expect(trace.getByRole("status", { name: "Trace outcome" })).toContainText("Failed");
  const timeline = trace.getByRole("list", { name: "Trace events" });
  await expect(timeline.getByRole("listitem").first()).toContainText("orders-api");

  // An event expands in place, with its fields.
  await timeline.getByRole("listitem").first().getByRole("button").first().click();
  await expect(timeline.getByLabel("Fields").first()).toBeVisible();

  // A service on the document's way shows only its events; pressed again, all of them.
  const step = trace
    .getByRole("group", { name: "Trace graph" })
    .getByRole("button", { name: /^service orders-api/ });
  const all = await timeline.getByRole("listitem").count();
  await step.click();
  await expect(step).toHaveAttribute("aria-pressed", "true");
  await expect(timeline.getByRole("listitem").first()).toContainText("orders-api");
  await step.click();
  await expect(timeline.getByRole("listitem")).toHaveCount(all);

  // "Open in …" opens that service's logs filtered to the document; the trace tab stays.
  await timeline
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Open in orders-api" })
    .click();
  await expect(page.getByRole("textbox", { name: "Search logs" })).toHaveValue(/^correlation:/);
  await tabs.getByRole("tab", { name: /^Trace / }).click();
  await expect(trace.getByRole("status", { name: "Trace outcome" })).toContainText("Failed");
  await expect(timeline.getByLabel("Fields").first()).toBeVisible();
});

test("trace an API request by its trace ID, without a document outcome", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "payments-worker");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await page.getByRole("textbox", { name: "Search logs" }).fill("POST");
  await expect(page.getByLabel("Match count")).toContainText(/^\d+ of \d+$/);
  await list.getByRole("listitem").first().getByRole("button").first().click();
  await page.getByRole("button", { name: "Trace across services" }).click();

  const trace = page.getByRole("main", { name: /^Trace / });
  await trace.getByRole("button", { name: "All (3)" }).click();
  await trace.getByRole("button", { name: "Search 3 services" }).click();
  const timeline = trace.getByRole("list", { name: "Trace events" });
  await expect(timeline.getByRole("listitem").first()).toBeVisible();
  // Only status events say how a document ended; a request has no outcome.
  await expect(trace.getByRole("status", { name: "Trace outcome" })).toHaveCount(0);
  await expect(
    trace.getByRole("list", { name: "Services on the way" }).getByRole("listitem"),
  ).not.toHaveCount(1);
});

test("a document's trace on the route graph, with the services it hasn't reached", async ({
  page,
}) => {
  // The second recorded demo document: stuck in audit-archiver, failed in search-feeder.
  const id = "8e306f7d530e13e9000000000382e103";
  const list = await openLogs(page, "demo-edge", "legacy-gateway");
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await page.getByRole("textbox", { name: "Search logs" }).fill(id);
  await expect.poll(() => rowCount(page)).toBe(2);
  await list.getByRole("listitem").first().getByRole("button").first().click();
  await page.getByRole("button", { name: "Trace across services" }).click();

  const trace = page.getByRole("main", { name: /^Trace / });
  await trace.getByRole("checkbox", { name: "event-ingest" }).click();
  await trace.getByRole("checkbox", { name: "event-enricher" }).click();
  await trace.getByRole("button", { name: "Search 3 services" }).click();

  // The way so far: ingest → topic → gateway and the transformer → next topic.
  const graph = trace.getByRole("group", { name: "Trace graph" });
  await expect(
    graph.getByRole("button", { name: "service event-ingest (PUBLISHED)" }),
  ).toBeVisible();
  await expect(graph.getByRole("button", { name: "topic demo.events", exact: true })).toBeVisible();
  await expect(
    graph.getByRole("button", { name: "service legacy-gateway (COMPLETED)" }),
  ).toBeVisible();
  await expect(graph.getByRole("button", { name: "topic demo.events.enriched" })).toBeVisible();
  // Nobody searched has read the enriched topic yet.
  await expect(trace.getByRole("status", { name: "Trace outcome" })).toContainText("Open");

  // The route scan adds the systems and the readers that weren't searched.
  await trace.getByRole("button", { name: "Find connected services" }).click();
  await expect(
    graph.getByRole("button", { name: "system Example Partner", exact: true }),
  ).toBeVisible();
  const archiver = graph.getByRole("button", { name: "service audit-archiver (no event)" });
  await expect(archiver).toContainText("not searched");
  // A sibling writer of the topic isn't on the document's way.
  await expect(graph.getByRole("button", { name: /service partner-poller/ })).toHaveCount(0);

  await archiver.click();
  await trace.getByRole("button", { name: "Search audit-archiver too" }).click();
  await expect(
    graph.getByRole("button", { name: "service audit-archiver (RETRYING)" }),
  ).toBeVisible();
  // The scan is kept: search-feeder waits on the enriched topic, not searched yet.
  await graph.getByRole("button", { name: /service search-feeder/ }).click();
  await trace.getByRole("button", { name: "Search search-feeder too" }).click();
  await expect(graph.getByRole("button", { name: "service search-feeder (FAILED)" })).toBeVisible();
  await expect(trace.getByRole("status", { name: "Trace outcome" })).toContainText("Failed");

  // A service on the graph shows only its events.
  const timeline = trace.getByRole("list", { name: "Trace events" });
  await graph.getByRole("button", { name: "service event-enricher (COMPLETED)" }).click();
  await expect(timeline.getByRole("listitem")).toHaveCount(4);
  await expect(timeline.getByRole("listitem").first()).toContainText("event-enricher");
  await graph.getByRole("button", { name: "service event-enricher (COMPLETED)" }).click();
  await expect(timeline.getByRole("listitem")).toHaveCount(12);
});

test("↑ and ↓ recall earlier searches with their flags, this service's first", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  const search = page.getByRole("textbox", { name: "Search logs" });
  const regex = page.getByRole("button", { name: "Regular expression" });

  await search.fill("timeout");
  await search.press("Enter");
  await regex.click();
  await search.fill("order \\d+");
  await search.press("Enter");
  await regex.click();
  await search.fill("level:ERROR");
  await search.press("Enter");

  await search.fill("draft");
  await search.press("ArrowUp");
  await expect(search).toHaveValue("level:ERROR");
  await search.press("ArrowUp");
  await expect(search).toHaveValue("order \\d+");
  await expect(regex).toHaveAttribute("aria-pressed", "true");
  await search.press("ArrowUp");
  await expect(search).toHaveValue("timeout");
  await expect(regex).toHaveAttribute("aria-pressed", "false");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  // Past the newest: what was typed before.
  await expect(search).toHaveValue("draft");
  // Cleared before leaving: leaving the box with a search set remembers it, and whether "draft"
  // was searched for yet depends on the typing pause (timing).
  await search.fill("");

  // Another service: its own searches first, then the ones from orders-api.
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "payments-worker" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  const other = page.getByRole("textbox", { name: "Search logs" });
  await other.fill("settled");
  await other.press("Enter");
  await other.fill("");
  await other.press("ArrowUp");
  await expect(other).toHaveValue("settled");
  await other.press("ArrowUp");
  await expect(other).toHaveValue("level:ERROR");
});

test("saved searches: for one service or all, applied and deleted", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  const search = page.getByRole("textbox", { name: "Search logs" });
  const menu = page.getByRole("button", { name: "Saved searches" });
  const form = page.getByRole("form", { name: "Save the search" });

  await search.fill("level:ERROR");
  await search.press("Enter");
  await menu.click();
  await form.getByLabel("Name").fill("Errors");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "For orders-api" })).toContainText("Errors");
  await page.keyboard.press("Escape");

  await search.fill("timeout");
  await search.press("Enter");
  await menu.click();
  await form.getByLabel("Name").fill("Timeouts");
  await form.getByLabel(/For all services/).check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "For all services" })).toContainText("Timeouts");

  // Applying one puts it in the search box.
  await page.getByRole("button", { name: /^Errors/ }).click();
  await expect(search).toHaveValue("level:ERROR");

  // Another service sees only the ones for all services.
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "payments-worker" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  await menu.click();
  await expect(page.getByRole("region", { name: "For all services" })).toContainText("Timeouts");
  await expect(page.getByRole("region", { name: "For payments-worker" })).toHaveCount(0);
  await expect(page.getByText("Errors")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete Timeouts" }).click();
  await expect(page.getByText("No saved searches yet.")).toBeVisible();
});

test("a saved search runs from ⌘K, opening its service", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  const search = page.getByRole("textbox", { name: "Search logs" });
  await search.fill("level:ERROR");
  await search.press("Enter");
  await page.getByRole("button", { name: "Saved searches" }).click();
  const form = page.getByRole("form", { name: "Save the search" });
  await form.getByLabel("Name").fill("Order errors");
  await form.getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Escape");

  // From another service, on its Overview.
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "payments-worker" }).click();
  await page.getByRole("tab", { name: "Overview" }).click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("dialog").getByRole("combobox").fill("order errors");
  await page.getByRole("option", { name: /Order errors/ }).click();

  await expect(page.getByRole("main", { name: "Service orders-api" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search logs" })).toHaveValue("level:ERROR");
});
