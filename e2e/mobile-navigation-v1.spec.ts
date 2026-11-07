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
  await expect(page.locator('.mobileNav [data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");

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
  await expect(page.locator('.mobileNav [data-nav-tab="my-plan-preview"]')).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-plan-source="legacy-today"]')).toHaveCount(0);
  await page.reload();
  await waitUntilSynced(page);
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");

  // The first tab uses a separately restorable, clearly preview-only route.
  await page.locator('.mobileNav [data-nav-tab="my-plan-preview"]').click();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('[data-plan-source="legacy-today"]')).toBeVisible();
  await page.reload();
  await waitUntilSynced(page);
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('.mobileNav [data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Můj plán|My Plan/);
  // Browser history also preserves which of the two Today-backed views was chosen.
  await page.goBack();
  await expect(page).toHaveURL(/[?]view=Today$/);
  await expect(page.locator('.mobileNav button[data-nav-view="More"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await page.goForward();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(page.locator('.mobileNav [data-nav-tab="my-plan-preview"]')).toHaveAttribute("aria-current", "page");
});

test("an explicit Today URL never becomes the My Plan preview on initial load", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await expect(page.locator(".pageTitleRow h1")).toHaveText(/Dnes|Today/);
  await expect(page.locator('.mobileNav [data-nav-tab="my-plan-preview"]')).not.toHaveAttribute("aria-current", "page");
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

test("mobile calendar date strip offers one Tab stop with day/week arrow navigation", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  const dates = page.locator(".mobileCalendarDateStrip");
  const chosen = dates.locator('.mobileCalendarDateBubble[aria-pressed="true"]');
  await expect(chosen).toHaveCount(1);
  await expect(dates.locator('.mobileCalendarDateBubble[tabindex="0"]')).toHaveCount(1);
  await chosen.focus();
  await expect(chosen).toBeFocused();

  const initialDay = await chosen.getAttribute("data-date");
  expect(initialDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const move = (day: string, offset: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  await page.keyboard.press("ArrowRight");
  const nextDay = move(initialDay!, 1);
  const next = dates.locator(`[data-date="${nextDay}"]`);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("aria-pressed", "true");
  await expect(dates.locator('.mobileCalendarDateBubble[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("PageDown");
  const nextWeek = move(nextDay, 7);
  const week = dates.locator(`[data-date="${nextWeek}"]`);
  await expect(week).toBeFocused();
  await expect(week).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("ArrowLeft");
  const yesterday = dates.locator(`[data-date="${move(nextWeek, -1)}"]`);
  await expect(yesterday).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dates.locator(".mobileCalendarDateBubble:focus")).toHaveCount(0);
});

test("desktop v1 sidebar focuses selected view titles and preserves search focus", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const heading = page.locator(".appPane .pageTitleRow h1");

  // Main, direct secondary and footer routes use the same focus contract.
  await page.locator('aside nav [data-nav-view="Calendar"]').click();
  await expect(heading).toHaveText(/Kalendář|Calendar/);
  await expect(heading).toBeFocused();
  await page.locator('[data-desktop-v1-direct-views] [data-nav-view="Notes"]').click();
  await expect(heading).toHaveText(/Poznámky|Notes/);
  await expect(heading).toBeFocused();
  await page.locator("aside footer.sidebarActions button").filter({ hasText: /Nastavení|Settings/ }).click();
  await expect(heading).toHaveText(/Nastavení|Settings/);
  await expect(heading).toBeFocused();

  // A search-field navigation owns its own focus and is not stolen by Sidebar.
  const search = page.locator(".searchField input");
  await search.focus();
  await expect(search).toBeFocused();
  await expect(heading).toHaveText(/Hledání|Search/);

  // A long former screen must not leave the next heading behind the toolbar.
  await page.addStyleTag({ content: ".appPane .content { min-height: 2400px !important; }" });
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  await page.locator('aside nav [data-nav-view="Home"]').click();
  await expect(heading).toHaveText(/Domů|Home/);
  await expect(heading).toBeFocused();
  await expect.poll(() => heading.evaluate((el) => {
    const title = el.getBoundingClientRect();
    const toolbar = document.querySelector(".appPane .topbar")?.getBoundingClientRect();
    return title.top >= (toolbar?.bottom ?? 0) + 8 && title.bottom <= window.innerHeight - 8;
  })).toBe(true);
});

test("desktop v1 My Plan is a distinct, honest and restorable preview route", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await waitUntilSynced(page);

  const plan = page.locator('aside nav [data-nav-tab="my-plan-preview"]');
  const today = page.locator('aside nav button[data-nav-view="Today"]:not([data-nav-tab])');
  const heading = page.locator(".appPane .pageTitleRow h1");
  const notice = page.locator('[data-plan-source="legacy-today"]');
  await expect(plan).toHaveCount(1);
  await expect(today).toHaveCount(1);
  await expect(page.locator('aside nav button[data-nav-view="Today"]')).toHaveCount(1);
  await expect(plan).toHaveAttribute("data-nav-view", "MyPlanPreview");
  await expect(plan).toContainText(/Můj plán|My Plan/);
  await expect(plan).toHaveAttribute("aria-label", /development preview|vývojový náhled/);

  await plan.click();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(heading).toHaveText(/Můj plán|My Plan/);
  await expect(heading).toBeFocused();
  await expect(notice).toBeVisible();
  await expect(plan).toHaveAttribute("aria-current", "page");
  await expect(today).not.toHaveAttribute("aria-current", "page");

  // The desktop URL must restore the plan, not silently become legacy Today.
  await page.reload();
  await waitUntilSynced(page);
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(heading).toHaveText(/Můj plán|My Plan/);
  await expect(notice).toBeVisible();
  await expect(plan).toHaveAttribute("aria-current", "page");

  // Both tabs share today's legacy data but are different presentation routes.
  await today.click();
  await expect(page).toHaveURL(/[?]view=Today$/);
  await expect(heading).toHaveText(/Dnes|Today/);
  await expect(heading).toBeFocused();
  await expect(notice).toHaveCount(0);
  await expect(today).toHaveAttribute("aria-current", "page");
  await expect(plan).not.toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(heading).toHaveText(/Můj plán|My Plan/);
  await expect(notice).toBeVisible();
  await expect(plan).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/[?]view=Today$/);
  await expect(heading).toHaveText(/Dnes|Today/);
  await expect(today).toHaveAttribute("aria-current", "page");

  // Today → My Plan changes the route even though both share view=Today.
  await plan.click();
  await expect(page).toHaveURL(/[?]view=MyPlanPreview$/);
  await expect(heading).toBeFocused();
  await expect(plan).toHaveAttribute("aria-current", "page");
});

test("v1 preview Projects uses a circle in phone and desktop navigation, not a checkbox", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview is disabled by default");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);

  const phoneTab = page.locator('.mobileNav button[data-nav-view="Projects"]');
  const phoneGlyph = phoneTab.locator('svg[data-project-shape="circle"]');
  await expect(phoneTab).toHaveAttribute("aria-current", "page");
  await expect(phoneGlyph).toHaveCount(1);
  await expect(phoneGlyph.locator("circle")).toHaveCount(1);
  await expect(phoneGlyph.locator("rect")).toHaveCount(0);
  await expect(phoneGlyph).toHaveAttribute("aria-hidden", "true");
  await expect(phoneTab).not.toHaveAttribute("role", "checkbox");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('aside nav button[data-nav-view="Projects"] svg[data-project-shape="circle"]')).toHaveCount(1);
  const sidebarProject = page.locator('aside .sidebarProjects button[data-sidebar-project="e2e-project"]');
  await expect(sidebarProject).toBeVisible();
  const projectGlyph = sidebarProject.locator('svg[data-project-shape="circle"]');
  await expect(projectGlyph.locator("circle")).toHaveCount(1);
  await expect(projectGlyph).toHaveAttribute("aria-hidden", "true");
  await expect(sidebarProject).not.toHaveAttribute("role", "checkbox");
  // Selecting the sidebar project navigates; it must not toggle completion.
  await sidebarProject.click();
  await expect(page).toHaveURL(/[?]view=Projects&projectId=e2e-project$/);
});
