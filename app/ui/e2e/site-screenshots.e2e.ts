/**
 * Screenshots for the website (`site/`), taken from the real UI against the fake backend.
 * Skipped in the normal e2e run; regenerate them after visible UI changes with
 * `pnpm screenshots` (writes `site/src/assets/screenshots/<name>-<light|dark>.png` and the
 * social preview card `site/public/og.png`).
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const OUT = "../../site/src/assets/screenshots";

test.skip(!process.env.SCREENSHOTS, "only with SCREENSHOTS=1 (pnpm screenshots)");
// One browser is enough: the pictures should look the same every time.
test.skip(({ browserName }) => browserName !== "chromium", "Chromium only");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function openService(page: Page, cluster: string, service: string) {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: cluster }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: service }).click();
  return page.getByRole("main", { name: `Service ${service}` });
}

/** Opens a service's logs and stops the live tail, so the rows hold still for the picture. */
async function openLogs(page: Page, cluster: string, service: string) {
  const view = await openService(page, cluster, service);
  await view.getByRole("tab", { name: "Logs" }).click();
  await page.getByRole("button", { name: "Pause live tail" }).click();
  return view;
}

/** Switches the app's theme in the settings (it starts dark, not following the OS). */
async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("group", { name: "Theme" }).getByRole("button", { name: theme }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Closing gives the focus back to the settings button, which would show its tooltip.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Takes the shot twice, in light and dark mode, with transitions settled and no hover. */
async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await setTheme(page, scheme === "light" ? "Light" : "Dark");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
  }
}

/** The payments service's logs, a screenful of them (plain ECS JSON with stack traces). */
async function paymentsLogs(page: Page) {
  const view = await openLogs(page, "demo-core", "payments-worker");
  await expect(
    view.getByRole("list", { name: "Log events" }).getByRole("listitem"),
  ).not.toHaveCount(0);
}

test("log view", async ({ page }) => {
  await paymentsLogs(page);
  await shoot(page, "logs");
});

test("service overview", async ({ page }) => {
  const view = await openService(page, "demo-core", "payments-worker");
  await expect(view.getByRole("region", { name: "Deployments" })).toBeVisible();
  await shoot(page, "overview");
});

test("search", async ({ page }) => {
  const view = await openLogs(page, "demo-edge", "legacy-gateway");
  await view.getByRole("textbox", { name: "Search logs" }).fill("shipment level>=INFO");
  await expect(view.getByLabel("Match count")).toContainText(/^\d+ of \d+$/);
  await shoot(page, "search");
});

/**
 * One shot per step of the tracing guide (site/src/content/docs/guides/tracing.mdx): an API
 * request followed by its trace ID (payments-worker calls orders-api; billing-sync logs the same
 * demo trace IDs).
 */
test("trace across services", async ({ page }) => {
  const view = await openLogs(page, "demo-core", "payments-worker");
  const list = view.getByRole("list", { name: "Log events" });
  await view.getByRole("textbox", { name: "Search logs" }).fill("POST");
  await expect(view.getByLabel("Match count")).toContainText(/^\d+ of \d+$/);
  await list.getByRole("listitem").first().getByRole("button").first().click();
  const start = page.getByRole("button", { name: "Trace across services" });
  await expect(start).toBeVisible();
  await shoot(page, "trace-start");

  await start.click();
  const trace = page.getByRole("main", { name: /^Trace / });
  await trace.getByRole("checkbox", { name: "orders-api" }).click();
  await trace.getByRole("checkbox", { name: "billing-sync" }).click();
  await shoot(page, "trace-services");

  await trace.getByRole("button", { name: "Search 3 services" }).click();
  await expect(
    trace.getByRole("list", { name: "Services on the way" }).getByRole("listitem"),
  ).toHaveCount(3);
  // The first event expanded, so the picture shows an event next to the way the request took.
  const events = trace.getByRole("list", { name: "Trace events" }).getByRole("listitem");
  await events.first().getByRole("button").first().click();
  await shoot(page, "trace");
});

/**
 * The picture link previews show (Slack, Teams…): 1200×630, the logo and claim next to a crop
 * of the app in dark mode.
 */
test("social preview card", async ({ page }) => {
  await paymentsLogs(page);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const shot = (await page.screenshot()).toString("base64");
  const logo = readFileSync("../../assets/icon.svg").toString("base64");

  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(`
    <style>
      body { margin: 0; width: 1200px; height: 630px; overflow: hidden; color: #fff;
        font-family: -apple-system, "Segoe UI", Inter, sans-serif;
        background: radial-gradient(ellipse at 20% 0%, #0c4a6e, #05080f 70%); }
      .text { position: absolute; left: 72px; top: 96px; width: 470px; }
      .brand { display: flex; align-items: center; gap: 18px; font-size: 44px; font-weight: 700; }
      .brand img { width: 84px; height: 84px; margin: -10px; }
      h1 { margin: 40px 0 0; font-size: 50px; line-height: 1.1; letter-spacing: -0.02em; }
      h1 span { color: #bae6fd; }
      p { margin: 28px 0 0; font-size: 24px; line-height: 1.4; color: #c3cfdb; }
      .shot { position: absolute; left: 600px; top: 120px; width: 900px; border-radius: 14px;
        border: 1px solid #1e3a52; box-shadow: 0 30px 80px rgb(0 0 0 / 0.5); }
    </style>
    <div class="text">
      <div class="brand"><img src="data:image/svg+xml;base64,${logo}">Contrail</div>
      <h1>Your ECS logs, <span>live and readable.</span></h1>
      <p>Desktop log viewer for AWS ECS on macOS, Windows and Linux. Free and open source.</p>
    </div>
    <img class="shot" src="data:image/png;base64,${shot}">`);
  await page.screenshot({ path: "../../site/public/og.png" });
});
