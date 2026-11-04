import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// This UI-only scenario is opt-in, like the preview build itself.
// It must never assert that the legacy Today data is the authorized target My Plan.
test("Lumi Design v1 preview shows four phone tabs, a visible source notice and all More destinations", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  const tabs = page.locator(".mobileNav button");
  await expect(tabs).toHaveCount(4);
  await expect(tabs).toHaveText([/Můj plán|My Plan/, /Kalendář|Calendar/, /Projekty|Projects/, /Více|More/]);
  await expect(page.locator('[data-plan-source="legacy-today"]')).toBeVisible();
  await expect(page.locator('[data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");

  await page.locator('.mobileNav button[data-nav-view="Calendar"]').click();
  await expect(page.locator('.mobileNav button[data-nav-view="Calendar"]')).toHaveAttribute("aria-current", "page");
  await page.locator('.mobileNav button[data-nav-view="Projects"]').click();
  await expect(page.locator('.mobileNav button[data-nav-view="Projects"]')).toHaveAttribute("aria-current", "page");
  await page.locator('.mobileNav button[data-nav-tab="my-plan-preview"]').click();
  await expect(page.locator('[data-plan-source="legacy-today"]')).toBeVisible();

  await page.locator('.mobileNav button[data-nav-view="More"]').click();
  await expect(page.locator('.mobileMore[role="dialog"]')).toBeVisible();
  for (const view of ["Home", "Inbox", "Today", "Upcoming", "Notes", "Areas", "Settings"])
    await expect(page.locator(`.mobileMore button[data-nav-view="${view}"]`)).toHaveCount(1);
  await expect(page.locator('.mobileNav button[data-nav-view="Search"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator('.mobileMore[role="dialog"]')).toHaveCount(0);
});
