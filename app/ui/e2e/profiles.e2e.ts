/** M1: profiles, session states, region override and the SSO login flow (demo data). */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DemoReadOnly/demo.user")).toBeVisible();
});

test("starts connected on the first usable profile", async ({ page }) => {
  const switcher = page.getByRole("combobox", { name: "AWS profile" });
  await expect(switcher).toContainText("demo-dev");
  await expect(switcher).toContainText("111122223333");
  await expect(page.getByText("Connected to demo-dev")).toBeVisible();
  await expect(page.getByText("Demo", { exact: true })).toBeVisible();
});

test("keyboard: open the switcher, search and log in to an expired profile", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("prod");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect(page.getByText("Log in to demo-prod")).toBeVisible();
  await page.getByRole("button", { name: "Log in" }).click();

  // While the CLI waits for the browser, its output is shown.
  await expect(page.getByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Login output" })).toContainText(
    "open the SSO authorization page",
  );

  await expect(page.getByText("Connected to demo-prod")).toBeVisible();
  await expect(page.getByRole("region", { name: "Login output" })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "AWS profile" })).toContainText("333344445555");
});

test("search matches parts of account IDs, not scattered digits", async ({ page }) => {
  await page.getByRole("combobox", { name: "AWS profile" }).click();
  const search = page.getByPlaceholder("Search profiles or account IDs…");
  await search.fill("33334444");
  // demo-staging (222233334444) and demo-prod (333344445555)
  await expect(page.getByRole("option")).toHaveCount(2);
  await search.fill("333344445555");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("demo-prod");
});

test("region override defaults to the profile's region", async ({ page }) => {
  const region = page.getByRole("combobox", { name: "Region" });
  await expect(region).toContainText("eu-central-1");
  await region.click();
  await page.getByRole("option", { name: "us-west-2" }).click();
  await expect(region).toContainText("us-west-2");
});
