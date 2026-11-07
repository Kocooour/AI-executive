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
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Můj plán|My Plan/);
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
  // More → Today is distinct from the first tab, including after reload.
  await page.locator('.mobileMore button[data-nav-view="Today"]').click();
  await expect(page).toHaveURL(/[?]view=Today$/);
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await expect(page.locator('[data-nav-tab="my-plan-preview"]')).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-plan-source="legacy-today"]')).toHaveCount(0);
  await page.reload();
  await waitUntilSynced(page);
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");

  // The first tab uses a separately restorable, clearly preview-only route.
  await page.locator('[data-nav-tab="my-plan-preview"]').click();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('[data-plan-source="legacy-today"]')).toBeVisible();
  await page.reload();
  await waitUntilSynced(page);
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('[data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Můj plán|My Plan/);
  // Browser history also preserves which of the two Today-backed views was chosen.
  await page.goBack();
  await expect(page).toHaveURL(/[?]view=Today$/);
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await page.goForward();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('[data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");
});

test("an explicit Today URL never becomes the My Plan preview on initial load", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await expect(page.locator('[data-nav-tab="my-plan-preview"]')).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/[?]view=Today$/);
});

test("mobile v1 More focuses the selected destination instead of its closed trigger", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const trigger = page.locator('.mobileNav button[data-nav-view="More"]');
  await trigger.click();
  const more = page.getByRole("dialog", { name: /Více|More/ });
  await expect(more.getByRole("button", { name: /Zavřít nabídku|Close menu/ })).toBeFocused();
  await more.locator('[data-nav-view="Settings"]').click();
  await expect(more).toHaveCount(0);
  await expect(page.locator(".pageTitleRow h1")).toBeFocused();
  await expect(trigger).not.toBeFocused();

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(more).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // A long scrolled source must not leave the destination title off-screen.
  // Preview-only layout extension keeps both source and target tall enough
  // that the browser cannot silently clamp the old scroll to the new height.
  await page.addStyleTag({ content: ".appPane .content { min-height: 2400px !important; }" });
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  await trigger.click();
  await more.locator('[data-nav-view="Today"]').click();
  await expect(more).toHaveCount(0);
  const heading = page.locator(".appPane .pageTitleRow h1");
  await expect(heading).toBeFocused();
  await expect.poll(() => heading.evaluate((element) => {
    const title = element.getBoundingClientRect();
    const toolbar = document.querySelector(".appPane .topbar")?.getBoundingClientRect();
    const mobileNav = document.querySelector(".mobileNav")?.getBoundingClientRect();
    return title.top >= (toolbar?.bottom ?? 0) + 8 &&
      title.bottom <= (mobileNav?.top ?? window.innerHeight) - 8;
  })).toBe(true);

});
