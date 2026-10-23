/** M7: tabs, export, field mapping, shortcuts. */
import { expect, test, type Page } from "@playwright/test";

async function openService(page: Page, cluster: string, service: string) {
  const tree = page.getByRole("tree", { name: "Clusters" });
  const clusterItem = tree.getByRole("treeitem", { name: cluster });
  if ((await clusterItem.getAttribute("aria-expanded")) !== "true") {
    await clusterItem.getByRole("button").first().click();
  }
  await tree.getByRole("treeitem", { name: service }).click();
  await expect(page.getByRole("main", { name: `Service ${service}` })).toBeVisible();
}

test("a field mapping changes what the message column shows", async ({ page }) => {
  await page.goto("/");
  await openService(page, "demo-core", "payments-worker");
  await page.getByRole("tab", { name: "Logs" }).click();
  const list = page.getByRole("list", { name: "Log events" });
  await expect(list.getByText("scheduling-1", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Field mapping" }).click();
  await page.getByRole("combobox", { name: "Message field" }).fill("process.thread.name");
  await page.getByRole("button", { name: "Save and reload" }).click();
  await expect(list.getByText("scheduling-1", { exact: true }).first()).toBeVisible();

  // Back to the defaults.
  await page.getByRole("button", { name: "Field mapping" }).click();
  await page.getByRole("button", { name: "Use defaults" }).click();
  await expect(list.getByText("scheduling-1", { exact: true })).toHaveCount(0);
});

test("tabs keep services open and switch with the keyboard", async ({ page }) => {
  await page.goto("/");
  await openService(page, "demo-core", "orders-api");
  await openService(page, "demo-core", "payments-worker");
  await openService(page, "demo-edge", "legacy-gateway");
  const tabs = page.getByRole("tablist", { name: "Open services" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+1`);
  await expect(page.getByRole("main", { name: "Service orders-api" })).toBeVisible();
  await page.keyboard.press("Control+Tab");
  await expect(page.getByRole("main", { name: "Service payments-worker" })).toBeVisible();

  await tabs.getByRole("button", { name: "Close payments-worker" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("main", { name: "Service legacy-gateway" })).toBeVisible();
});

test("export and the shortcuts overview", async ({ page }) => {
  await page.goto("/");
  await openService(page, "demo-edge", "legacy-gateway");
  await page.getByRole("tab", { name: "Logs" }).click();
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Raw lines (.log)" }).click();
  await expect(page.getByText(/^Exported \d+ events$/)).toBeVisible();

  await page.getByRole("list", { name: "Log events" }).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});
