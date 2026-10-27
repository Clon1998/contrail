/** M3/M4: the log viewer — rows, expanding, copying, columns, task view, 100k lines. */
import { expect, test, type Page } from "@playwright/test";

async function openLogs(page: Page, cluster: string, service: string) {
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: cluster }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: service }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  return page.getByRole("list", { name: "Log events" });
}

/** Opens the time picker, types `text` (e.g. `1h`) and applies it with Enter. */
async function chooseWindow(page: Page, text: string) {
  await page.getByRole("button", { name: /^Time window:/ }).click();
  const input = page.getByRole("combobox", { name: "Time window" });
  await input.fill(text);
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
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
  // Packages are shortened like Spring Boot does; the tooltip keeps the full name.
  const logger = list.locator('[title^="com.example."]').first();
  await expect(logger).toBeVisible();
  await expect(logger).toHaveText(/^c\.e\./);
});

test("long messages wrap with W or the toolbar button", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const list = await openLogs(page, "demo-core", "payments-worker");
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const tallest = () =>
    list
      .getByRole("listitem")
      .evaluateAll((rows) => Math.max(...rows.map((r) => r.getBoundingClientRect().height)));
  const oneLine = await tallest();

  await page.keyboard.press("w");
  await expect(page.getByRole("button", { name: "Wrap lines" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(tallest).toBeGreaterThan(oneLine * 1.5);

  await page.getByRole("button", { name: "Wrap lines" }).click();
  await expect.poll(tallest).toBeLessThan(oneLine * 1.5);
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

test("the list keeps a place in the middle across Overview, Logs and tabs", async ({ page }) => {
  page.on("console", (m) => m.text().startsWith("DBG") && console.log(m.text()));
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(list.getByText("Ingested event #100000 ")).toBeVisible();
  const scroller = list.locator("..");
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  const row = list.getByRole("button", { name: /Ingested event #5\d{4} / }).nth(5);
  const name = (await row.innerText()).match(/Ingested event #\d+/)?.[0] ?? "";
  await row.click();
  const top = async () => (await row.boundingBox())?.y;
  const before = await top();
  console.log("DBG before", before, name, await scroller.evaluate((el) => el.scrollTop));

  const samePlace = async () => {
    const back = list.getByRole("button", { name: new RegExp(`${name} `) });
    await expect(back).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await back.boundingBox())?.y).toBe(before);
  };
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  await samePlace();

  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "legacy-gateway" }).click();
  await expect(page.getByRole("main", { name: "Service legacy-gateway" })).toBeVisible();
  await page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: /event-ingest/ })
    .click();
  await samePlace();
});

test("the list keeps its place and open rows across Overview, Logs and tabs", async ({ page }) => {
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(list.getByText("Ingested event #100000 ")).toBeVisible();
  await list.locator("..").evaluate((el) => {
    el.scrollTop = 0;
  });
  const first = list.getByRole("button", { name: /Ingested event #1 / }).first();
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");

  const backAtTheTop = async () => {
    await expect(list.getByRole("button", { name: /Ingested event #1 / }).first()).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  };
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  await backAtTheTop();

  // Another service's tab and back.
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "legacy-gateway" }).click();
  await expect(page.getByRole("main", { name: "Service legacy-gateway" })).toBeVisible();
  await page
    .getByRole("tablist", { name: "Open tabs" })
    .getByRole("tab", { name: /event-ingest/ })
    .click();
  await backAtTheTop();
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
  const picker = page.getByRole("button", { name: /^Time window:/ });
  await expect(picker).toHaveAccessibleName("Time window: Last 15 min");
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();

  await chooseWindow(page, "1h");
  await expect(picker).toHaveAccessibleName("Time window: Last 1 h");
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();
  await page.getByRole("button", { name: "Resume live tail" }).click();
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();

  // Typed: the last 2 days, previewed before Enter.
  await picker.click();
  const input = page.getByRole("combobox", { name: "Time window" });
  await input.fill("2d");
  await expect(page.getByRole("option", { name: /Last 2 days/ })).toContainText("opens paused");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Time window: Last 2 d");
  await expect(page.getByRole("status", { name: "Live tail: Paused" })).toBeVisible();

  // Typed: a fixed range.
  await chooseWindow(page, "yesterday 9-10");
  await expect(picker).toHaveAccessibleName("Time window: Yesterday 09:00 → 10:00");
  await expect(page.getByText("fixed range", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: /^Live tail/ })).toHaveCount(0);
});

test("the time picker: T opens it, it explains bad input, remembers windows, has a calendar", async ({
  page,
}) => {
  await openLogs(page, "demo-core", "orders-api");
  const picker = page.getByRole("button", { name: /^Time window:/ });

  // T opens the picker on the current window (15 min); Arrow Down moves on to the next one.
  await page.keyboard.press("t");
  const input = page.getByRole("combobox", { name: "Time window" });
  await expect(input).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveAccessibleName("Time window: Last 1 h");

  // What it can't read, it explains.
  await picker.click();
  await input.fill("soon");
  await expect(page.getByRole("status").filter({ hasText: "Try 15m, 3h" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A window chosen once shows up under "Recent".
  await chooseWindow(page, "3h");
  await picker.click();
  await expect(page.getByRole("option", { name: /Last 3 hours/ })).toBeVisible();

  // The calendar: one day, all of it.
  await page.getByRole("button", { name: "Calendar" }).click();
  const calendar = page.getByRole("group", { name: "Calendar" });
  await calendar.getByRole("button", { name: "Previous month" }).click();
  const month = new Date();
  month.setDate(1);
  month.setMonth(month.getMonth() - 1);
  const name = month.toLocaleString("en", { month: "long" });
  await calendar.getByRole("button", { name: `${name} 10, ${month.getFullYear()}` }).click();
  await calendar.getByRole("button", { name: "Apply" }).click();
  await expect(picker).toHaveAccessibleName(/^Time window: \w{3} 10(, \d{4})?$/);
  await expect(page.getByText("fixed range", { exact: true })).toBeVisible();
});

test("newest first: the newest event on top, new events arrive there", async ({ page }) => {
  // The shortcut works once the app is up.
  await expect(page.getByRole("tree", { name: "Clusters" })).toBeVisible();
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

test("rows near the viewport are loaded before they scroll into view", async ({ page }) => {
  // Row fetches take a second here: a row that wasn't prefetched shows "…" after the jump.
  await page.goto("/?rowsDelay=1000");
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(list.getByText("Ingested event #100000 ")).toBeVisible();
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await page.waitForTimeout(2_500); // the prefetch around the newest rows arrives

  // Jump 300 rows up and look at the first frames drawn afterwards (well within the delay).
  const placeholders = await list.locator("..").evaluate(async (scroller) => {
    const row = scroller.querySelector('[role="listitem"]');
    scroller.scrollTop -= 300 * (row?.clientHeight ?? 19);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = scroller.getBoundingClientRect();
    return [...scroller.querySelectorAll('[role="listitem"]')].filter((r) => {
      const rect = r.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom && r.textContent === "…";
    }).length;
  });
  expect(placeholders).toBe(0);
  await expect(list.getByText("Ingested event #99700 ")).toBeVisible();
});

test("live: new rows appear without a placeholder flash", async ({ page }) => {
  // Row fetches take 300 ms: a new row that had to be fetched would show "…" first.
  await page.goto("/?rowsDelay=300");
  await openLogs(page, "demo-core", "orders-api");
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  await page.waitForTimeout(1_000); // the initial rows are loaded

  const placeholderFrames = await page.evaluate(async () => {
    const scroller = document.querySelector('[aria-label="Log events"]')?.parentElement;
    if (!scroller) return -1;
    let frames = 0;
    const end = performance.now() + 2_500; // the fake adds an event per second
    while (performance.now() < end) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const box = scroller.getBoundingClientRect();
      const placeholder = [...scroller.querySelectorAll('[role="listitem"]')].some((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom && row.textContent === "…";
      });
      if (placeholder) frames++;
    }
    return frames;
  });
  expect(placeholderFrames).toBe(0);
});

test("a long window starts with the newest events; scrolling up loads older ones", async ({
  page,
}) => {
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await expect(list).toHaveAttribute("aria-rowcount", /^10000\d$/); // 15 min: everything
  await chooseWindow(page, "1h");
  // 1 h opens paused (the count stays put) with only the newest half loaded.
  await expect(list).toHaveAttribute("aria-rowcount", "50000");
  await expect(page.getByRole("button", { name: "Load older" })).toBeVisible();

  // At the top, the older half comes in and the line on screen stays put.
  const scroller = list.locator("..");
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(list).toHaveAttribute("aria-rowcount", "100000");
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);
  await expect(list.getByText("Ingested event #50001 ")).toBeVisible();
});

test("a long window that fits on screen loads its older events right away", async ({ page }) => {
  const list = await openLogs(page, "demo-edge", "legacy-gateway");
  const all = Number(await list.getAttribute("aria-rowcount"));
  await chooseWindow(page, "1h");
  await expect(list).toHaveAttribute("aria-rowcount", String(all));
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);
});

test("the end of the list says whether older events are loading, missing or all there", async ({
  page,
}) => {
  await page.goto("/?olderDelay=800");
  const list = await openLogs(page, "demo-edge", "event-ingest");
  await chooseWindow(page, "1h");
  await expect(list).toHaveAttribute("aria-rowcount", "50000");
  const marker = page.getByRole("status", { name: "Older events" });

  await list.locator("..").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(marker).toContainText("Loading older events");
  await expect(marker).toContainText("Start of the time window");
  await expect(list).toHaveAttribute("aria-rowcount", "100000");
});

test("with a search, the end of the list says the matches end there", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "payments-worker");
  await page.getByRole("textbox", { name: "Search logs" }).fill("settling");
  await expect(page.getByLabel("Match count")).toBeVisible();
  await list.locator("..").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole("status", { name: "Older events" })).toContainText(
    "No older matches · window starts",
  );
});

test("the live tail state explains itself in a tooltip", async ({ page }) => {
  await openLogs(page, "demo-core", "orders-api");
  const live = page.getByRole("status", { name: "Live tail: Live" });
  await live.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Following new events" })).toHaveCount(
    1,
  );

  await chooseWindow(page, "1h");
  await page.mouse.move(0, 0);
  await page.getByRole("status", { name: "Live tail: Paused" }).hover();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "longer than 15 minutes start paused" }),
  ).toHaveCount(1);
});

test("live: new rows fade in briefly", async ({ page }) => {
  const list = await openLogs(page, "demo-core", "orders-api");
  await expect(page.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  // The fake adds an event per second: one shows up marked fresh, and the mark goes away.
  await expect(list.locator('[data-fresh="true"]').first()).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Pause live tail" }).click();
  await expect(list.locator('[data-fresh="true"]')).toHaveCount(0, { timeout: 3_000 });
});

test("the timeline shows events over time; clicking or dragging focuses the list", async ({
  page,
}) => {
  await openLogs(page, "demo-core", "payments-worker");
  const chart = page.getByRole("img", { name: "Timeline of events" });
  await expect(chart).toBeVisible();
  await expect(page.getByRole("button", { name: /^Time window:/ })).toContainText("Last 15 min");

  // Hovering a bar tells its time and counts.
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + 3, box.y + box.height - 2);
  await expect(page.getByRole("tooltip")).toContainText("events");

  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 20, { steps: 5 });
  await page.mouse.up();
  // The list is focused on the dragged part; the time window stays as it was.
  const clear = page.getByRole("button", { name: "Show the whole time window" });
  await expect(clear).toBeVisible();
  await expect(page.getByRole("button", { name: /^Time window:/ })).toContainText("Last 15 min");
  await clear.click();
  await expect(clear).toHaveCount(0);

  // A click focuses the bar under it.
  await page.mouse.click(box.x + box.width - 3, box.y + box.height - 2);
  await expect(clear).toBeVisible();

  // It can be hidden (a setting).
  await page.getByRole("button", { name: "Timeline" }).click();
  await expect(chart).toHaveCount(0);
});
