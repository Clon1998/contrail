/** M14: shareable contrail:// links and CloudWatch console links (demo data). */
import { expect, test, type Page } from "@playwright/test";

const CORE = "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core";

function link(params: Record<string, string>) {
  return `contrail://open?${new URLSearchParams(params).toString()}`;
}

async function openWith(page: Page, url: string) {
  await page.goto(`/?link=${encodeURIComponent(url)}`);
}

test("a copied link opens the same service, window and search", async ({
  page,
  browserName,
  context,
}) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only in Playwright");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-core" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "payments-worker" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  const search = page.getByRole("textbox", { name: "Search logs" });
  await search.fill("level:ERROR");
  await search.press("Enter");

  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("menuitem", { name: /Copy link/ }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^contrail:\/\/open\?profile=demo-dev&/);

  // A teammate opens it: a fresh start of the app with that link.
  await openWith(page, copied);
  await expect(page.getByRole("main", { name: "Service payments-worker" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search logs" })).toHaveValue("level:ERROR");
  await expect(page.getByRole("button", { name: /^Time window:/ })).toContainText("Last 15 min");
});

test("a link to a profile that needs a login waits for it", async ({ page }) => {
  await openWith(
    page,
    link({
      profile: "demo-prod",
      cluster: CORE.replace("111122223333", "333344445555"),
      service: "orders-api",
      last: "60",
    }),
  );
  const notice = page.getByRole("region", { name: "Shared link" });
  await expect(notice).toContainText("once you're logged in to demo-prod");
  await page.getByRole("banner").getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("main", { name: "Service orders-api" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Time window:/ })).toContainText("1 h");
  await expect(notice).toHaveCount(0);
});

test("a link for a profile that isn't configured says so", async ({ page }) => {
  await openWith(
    page,
    link({ profile: "team-prod", cluster: CORE, service: "orders-api", last: "15" }),
  );
  const notice = page.getByRole("region", { name: "Shared link" });
  await expect(notice).toContainText('profile "team-prod", which isn\'t in your AWS config');
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);

  await openWith(page, "contrail://open?profile=demo-dev&service=orders-api&last=15");
  await expect(page.getByRole("region", { name: "Shared link" })).toContainText(
    "the link has no cluster",
  );
});

test("the view and a single line open in the CloudWatch console", async ({ page }) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-core" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "orders-api" }).click();
  await page.getByRole("tab", { name: "Logs" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("menuitem", { name: "Open in CloudWatch console" }).click();
  await expect(page.getByRole("status").filter({ hasText: /failed|not/ })).toHaveCount(0);

  const list = page.getByRole("list", { name: "Log events" });
  await list.getByRole("button").first().click();
  await expect(list.getByRole("button", { name: "CloudWatch console" })).toBeVisible();
});

test("a service opens in the ECS console", async ({ page }) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "Clusters" });
  await tree.getByRole("treeitem", { name: "demo-core" }).getByRole("button").first().click();
  await tree.getByRole("treeitem", { name: "orders-api" }).click();
  await page.getByRole("button", { name: "Service actions" }).click();
  await page.getByRole("menuitem", { name: "Open in ECS console" }).click();
  const opened = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<string[]> };
        }
      ).__TAURI_INTERNALS__.invoke("fake_opened_console"),
    );
  await expect
    .poll(opened)
    .toEqual([expect.stringMatching(/\/ecs\/v2\/clusters\/demo-core\/services\/orders-api\//)]);
});
