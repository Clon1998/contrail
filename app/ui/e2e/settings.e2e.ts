/** M2.5: the settings dialog (colour mode, accent, timestamps). */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DemoReadOnly/demo.user")).toBeVisible();
});

test("colour mode and accent apply immediately and stay selected", async ({ page }) => {
  const html = page.locator("html");
  await expect(html).toHaveClass(/dark/);

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("radio", { name: "Light" }).click();
  await expect(html).not.toHaveClass(/dark/);
  await dialog.getByRole("radio", { name: "Rose" }).click();
  await expect(html).toHaveAttribute("data-accent", "rose");

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(dialog.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dialog.getByRole("radio", { name: "Rose" })).toHaveAttribute("aria-checked", "true");
});

test("system colour mode follows the operating system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("radio", { name: "System" })
    .click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
});
