/**
 * README screenshots from the demo data (no real logs). Opt-in:
 *   SCREENSHOTS=1 pnpm exec playwright test screenshots --project=chromium
 * writes docs/screenshots/*.png.
 */
import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to update the README screenshots");
test.use({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `../../docs/screenshots/${name}.png` });

async function open(page: Page, cluster: string, service: string) {
  const tree = page.getByRole("tree", { name: "Clusters" });
  const item = tree.getByRole("treeitem", { name: cluster });
  if ((await item.getAttribute("aria-expanded")) !== "true") {
    await item.getByRole("button").first().click();
  }
  await tree.getByRole("treeitem", { name: service }).click();
}

test("README screenshots", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Connected to demo-dev")).toBeVisible();

  await open(page, "demo-core", "payments-worker");
  await expect(page.getByRole("region", { name: "Deployments" })).toBeVisible();
  await shot(page, "overview");

  // A Spring Boot line with its joined stack trace, expanded.
  await open(page, "demo-edge", "legacy-gateway");
  await page.getByRole("tab", { name: "Logs" }).click();
  const list = page.getByRole("list", { name: "Log events" });
  await list.getByText("Polling failed").first().click();
  await page.waitForTimeout(300);
  await shot(page, "logs");

  // ECS JSON logs searched in highlight mode.
  await open(page, "demo-core", "orders-api");
  await page.getByRole("tab", { name: "Logs" }).click();
  await page.getByRole("radio", { name: "highlight" }).click();
  await page.getByRole("textbox", { name: "Search logs" }).fill('"status change" level>=INFO');
  await page.getByRole("textbox", { name: "Search logs" }).press("Enter");
  await expect(page.getByLabel("Match count")).toContainText("matches");
  await shot(page, "search");
});
