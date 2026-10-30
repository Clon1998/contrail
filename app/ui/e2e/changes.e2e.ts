/** M22: changes to ECS, only while allowed in the settings (read-only by default). */
import { expect, test, type Page } from "@playwright/test";

async function openOrders(page: Page) {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-core" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "orders-api" }).click();
  return page.getByRole("main", { name: "Service orders-api" });
}

async function allowChanges(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "AWS" }).click();
  await dialog.getByRole("checkbox", { name: "Allow changes to AWS" }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("read-only by default: no ways to change a service", async ({ page }) => {
  const view = await openOrders(page);
  await expect(view.getByRole("region", { name: "Tasks" })).toBeVisible();
  await view.getByRole("button", { name: "Service actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Open in ECS console" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Update service…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(view.getByRole("checkbox", { name: /Pick task/ })).toHaveCount(0);
});

test("stop picked tasks with a reason, after a confirmation", async ({ page }) => {
  const view = await openOrders(page);
  await allowChanges(page);
  const tasks = view.getByRole("region", { name: "Tasks" });
  const first = tasks.getByRole("checkbox", { name: /Pick task/ }).first();
  const picked = ((await first.getAttribute("aria-label")) ?? "").replace("Pick task ", "");
  await first.check();
  await tasks.getByRole("button", { name: "Stop 1 task…" }).click();

  const dialog = page.getByRole("dialog", { name: "Stop 1 task?" });
  await expect(dialog.getByRole("list", { name: "Tasks to stop" })).toContainText(picked);
  await dialog.getByRole("textbox").fill("stuck consumer");
  await dialog.getByRole("button", { name: "Stop 1 task" }).click();
  await expect(dialog).toBeHidden();

  // Stopped: it leaves the running tasks, and shows the reason among the stopped ones.
  await expect(tasks.getByRole("row", { name: `Task ${picked}` })).toContainText(
    "Task stopped by user: stuck consumer",
  );
});

test("quick update: desired count and revision, listed before they apply", async ({ page }) => {
  const view = await openOrders(page);
  await allowChanges(page);
  await view.getByRole("button", { name: "Service actions" }).click();
  await page.getByRole("menuitem", { name: "Update service…" }).click();
  const dialog = page.getByRole("dialog", { name: "Update orders-api" });
  const changes = dialog.getByRole("region", { name: "Changes" });
  await expect(changes).toContainText("Nothing changes yet.");
  await expect(dialog.getByRole("button", { name: "Update service" })).toBeDisabled();

  await dialog.getByRole("spinbutton", { name: "Desired count" }).fill("5");
  await dialog.getByRole("combobox", { name: "Task definition revision" }).click();
  const older = page.getByRole("option").nth(1);
  const revision = (await older.innerText()).trim();
  await older.click();
  await expect(changes).toContainText("Desired count");
  await expect(changes).toContainText("5");
  await expect(changes).toContainText(revision);
  await dialog.getByRole("button", { name: "Update service" }).click();
  await expect(dialog).toBeHidden();

  // The new deployment is the primary one; the event says so.
  await expect(view.getByText(`has begun a deployment of ${revision}.`)).toBeVisible();
  // The header counts against the new desired count.
  await expect(view.locator("header").getByText(/of 5 running/)).toBeVisible();
});
