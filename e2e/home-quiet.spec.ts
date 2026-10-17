import { test, expect } from "./fixtures";
import { heading, seeded, waitUntilSynced } from "./helpers";

// The quiet Home of docs/design-system: a plain title, no status chips while all is well, and
// every recommendation says why, from what and when on its own line (docs/UX-UI.md, LUMI-UX-001).

test("Home has a plain title and shows only states that need something", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(heading(page)).toHaveText("Domů");
  await expect(page.locator(".pageSubtitle, .eyebrow, .homeStatus")).toHaveCount(0);
  // Synced: no sync line. The test instance has no calendar, so that one line is shown with a way to fix it.
  await expect(page.locator(".homeNotice.homeSync")).toHaveCount(0);
  await expect(page.locator(".homeNotice", { hasText: "Kalendář není připojen" }).getByRole("button", { name: "Připojit" })).toBeVisible();
});

test("a recommendation shows reason, source and evaluation time without opening anything", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem", { hasText: seeded.overdueTask }).first();
  await expect(item).toBeVisible();
  const why = item.locator(".attentionWhy");
  await expect(why).toBeVisible();
  await expect(why).toContainText("uplynul");
  await expect(why).toContainText("zaznamenaný termín");
  await expect(why.locator(".attentionTime")).toContainText("vyhodnoceno");
  // Source ids and revisions stay one step away, in the item's own Zdroje.
  await expect(item.locator(".attentionSources")).toBeHidden();
  await item.locator(".attentionMore summary").click();
  await expect(item.locator(".attentionSources")).toBeVisible();
});

test("snooze and dismiss appear on hover and keyboard focus", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem").first();
  await expect(item).toBeVisible();
  const actions = item.locator(".attentionActions");
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await item.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Shift");
  await item.getByRole("button", { name: "Odložit o 24 h" }).focus();
  await expect(actions).toHaveCSS("opacity", "1");
});

test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("snooze and dismiss are always visible", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const item = page.locator(".attentionItem").first();
    await expect(item.locator(".attentionActions")).toHaveCSS("opacity", "1");
    await expect(item.getByRole("button", { name: "Skrýt" })).toBeVisible();
  });
});
