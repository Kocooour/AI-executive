import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

test("UI-01c: unavailable project URL falls back to a safe list with an indistinguishable notice", async ({ page }) => {
  await page.goto("/?view=Projects&projectId=ui01c-unavailable-project");
  await waitUntilSynced(page);
  const notice = page.getByTestId("navigation-unavailable");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Odkaz nelze otevřít");
  await expect(notice).not.toContainText("ui01c-unavailable-project");
  await expect(page).not.toHaveURL(/projectId=/);
  await expect(page.locator(".projectPage")).toHaveCount(0);
  await notice.getByRole("button", { name: "Skrýt upozornění" }).click();
  await expect(notice).toHaveCount(0);
});

test("UI-01c: invalid typed URL cannot open an inspector or disclose a target", async ({ page }) => {
  await page.goto("/?view=Today&taskId=ui01c-one&taskId=ui01c-two");
  await waitUntilSynced(page);
  const notice = page.getByTestId("navigation-unavailable");
  await expect(notice).toBeVisible();
  await expect(page.locator("aside.detail")).toHaveCount(0);
  await expect(notice).not.toContainText("ui01c-one");
  await expect(notice).not.toContainText("ui01c-two");
  await expect(page).not.toHaveURL(/taskId=/);
  await page.locator('.mobileNav button[data-nav-view="Projects"]:visible').count().then(async (count) => {
    if (count) await page.locator('.mobileNav button[data-nav-view="Projects"]:visible').click();
    else await page.locator('aside nav button[data-nav-view="Projects"]').click();
  });
  await expect(notice).toHaveCount(0);
});

test("UI-01c: browser Back to a no-longer-available task shows a generic notice", async ({ page }) => {
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await page.evaluate(() => {
    window.history.pushState(null, "", "?view=Today&taskId=ui01c-missing-history");
    window.history.pushState(null, "", "?view=Today");
  });
  await page.goBack();
  const notice = page.getByTestId("navigation-unavailable");
  await expect(notice).toBeVisible();
  await expect(notice).not.toContainText("ui01c-missing-history");
  await expect(page.locator("aside.detail")).toHaveCount(0);
  await expect(page).not.toHaveURL(/taskId=/);
});
