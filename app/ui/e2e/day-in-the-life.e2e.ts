/**
 * M7 "Done when": a day in the life. An on-call developer logs in, finds the failing service,
 * narrows its logs down to one error and its trace, compares with a second service in another
 * tab, hides noise, exports the evidence and checks one task's logs.
 */
import { expect, test } from "@playwright/test";

test("a day in the life", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Connected to demo-dev")).toBeVisible();

  // Morning: the prod session expired overnight. Switch and log in.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("prod");
  await page.keyboard.press("Enter");
  await page.getByRole("banner").getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Connected to demo-prod")).toBeVisible({ timeout: 10_000 });

  // Back to dev, where the alert is: jump to the service with the palette.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("demo-dev");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tree", { name: "Clusters" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("dialog", { name: "Go to service" })
    .getByPlaceholder("Go to service…")
    .fill("payments");
  await page.getByRole("option", { name: /payments-worker/ }).click();
  const payments = page.getByRole("main", { name: "Service payments-worker" });
  await expect(payments.getByRole("region", { name: "Deployments" })).toBeVisible();

  // The logs: only errors, then the first one's details.
  await payments.getByRole("tab", { name: "Logs" }).click();
  await expect(payments.getByRole("status", { name: "Live tail: Live" })).toBeVisible();
  const search = payments.getByRole("textbox", { name: "Search logs" });
  await search.fill("level:ERROR");
  await expect(payments.getByLabel("Match count")).toContainText(/^\d+ of \d+$/);
  const list = payments.getByRole("list", { name: "Log events" });
  await list.getByRole("button").first().click();
  await expect(list.getByLabel("Fields")).toBeVisible();

  // Compare with the API in a second tab; the payments tab keeps its search.
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("dialog", { name: "Go to service" })
    .getByPlaceholder("Go to service…")
    .fill("orders");
  await page.getByRole("option", { name: /orders-api/ }).click();
  const orders = page.getByRole("main", { name: "Service orders-api" });
  await orders.getByRole("tab", { name: "Logs" }).click();
  await orders.getByRole("radio", { name: "highlight" }).click();
  await orders.getByRole("textbox", { name: "Search logs" }).fill("level>=WARN");
  await orders.getByRole("textbox", { name: "Search logs" }).press("Enter");
  await expect(orders.getByLabel("Match count")).toContainText(/^1 \/ \d+ matches$/);

  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  await tabs.getByRole("tab", { name: "payments-worker" }).click();
  await expect(search).toHaveValue("level:ERROR");

  // The known settlement retries are noise today. (Filter to them first: the list keeps growing,
  // and an applied search resets expanded rows, so wait for it before expanding one.)
  await search.fill('"Error while settling batch"');
  // Enter applies it now, not after the typing pause, which could otherwise end in the middle of
  // the clicks below.
  await search.press("Enter");
  // Applied once every row on screen is one of them (the count may still show the previous search).
  await expect(list.getByRole("button", { name: /^(?!.*Error while settling batch)/ })).toHaveCount(
    0,
  );
  await list.getByText("Error while settling batch", { exact: true }).first().click();
  await list.getByRole("button", { name: "Hide lines like this" }).click();
  await expect(payments.getByText("No events match the search.")).toBeVisible();

  // Evidence for the incident ticket.
  await search.fill("level>=WARN");
  await payments.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "JSON Lines (.jsonl)" }).click();
  await expect(payments.getByText(/^Exported \d+ events$/)).toBeVisible();

  // One task looks unhealthy: its logs alone.
  await payments.getByRole("tab", { name: "Overview" }).click();
  await payments
    .getByRole("button", { name: /^Logs of task / })
    .first()
    .click();
  await expect(payments.getByText(/· 1 stream$/)).toBeVisible();

  // Done: close the tabs.
  await tabs.getByRole("button", { name: "Close payments-worker" }).click();
  await tabs.getByRole("button", { name: "Close orders-api" }).click();
  await expect(tabs).toHaveCount(0);
});
