/** The settings dialog: theme, accent, sizes, log settings. */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DemoReadOnly/demo.user")).toBeVisible();
});

test("theme and accent apply immediately and stay selected", async ({ page }) => {
  const html = page.locator("html");
  await expect(html).toHaveClass(/dark/);

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const theme = dialog.getByRole("group", { name: "Theme" });
  await theme.getByRole("button", { name: "Light" }).click();
  await expect(html).not.toHaveClass(/dark/);
  await dialog.getByRole("button", { name: "Rose" }).click();
  await expect(html).toHaveAttribute("data-accent", "rose");

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Rose" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("system theme follows the operating system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "System" })
    .click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("UI size scales the whole interface", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("combobox", { name: "UI size" }).click();
  await page.getByRole("option", { name: "125%" }).click();
  await expect(page.locator("html")).toHaveAttribute("style", /font-size: 125%/);
});

test("the default log window is a log setting", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Logs" }).click();
  const window = dialog.getByRole("group", { name: "Default time window" });
  await window.getByRole("button", { name: "1 h" }).click();
  await expect(window.getByRole("button", { name: "1 h" })).toHaveAttribute("aria-pressed", "true");
});
