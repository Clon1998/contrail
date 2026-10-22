/** M3: a service's backfilled logs in the (debug) Logs tab. */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-edge" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "legacy-gateway" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
});

test("plain-text logs are parsed, with split stack traces joined", async ({ page }) => {
  const list = page.getByRole("list", { name: "Log events" });
  await expect(list.getByRole("listitem")).toHaveCount(25);
  await expect(page.getByText("/ecs/legacy-gateway · 2 streams")).toBeVisible();

  // No stack trace frame shows up as a log line of its own.
  await expect(list.getByText(/^\s*at /)).toHaveCount(0);

  await list.getByText("Polling failed").first().click();
  const trace = list.getByLabel("Stack trace");
  await expect(trace).toContainText("Caused by: java.net.SocketTimeoutException");
  await expect(list.getByText("process.thread.name")).toBeVisible();
});

test("the time window can be changed", async ({ page }) => {
  const window = page.getByRole("radiogroup", { name: "Time window" });
  await expect(window.getByRole("radio", { name: "15 min" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await window.getByRole("radio", { name: "1 h" }).click();
  await expect(window.getByRole("radio", { name: "1 h" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("list", { name: "Log events" })).toBeVisible();
});
