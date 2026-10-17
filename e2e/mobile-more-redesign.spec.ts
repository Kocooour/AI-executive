import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

test.describe("mobile More sheet (E3)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("groups views, hides the capture FAB and highlights only More while open", async ({ page }) => {
    await page.goto("/?view=Calendar");
    await waitUntilSynced(page);
    const nav = page.locator(".mobileNav");
    await expect(nav.locator('button[data-nav-view="Calendar"]')).toHaveClass(/active/);
    await nav.locator('button[data-nav-view="More"]').click();
    const sheet = page.getByRole("dialog", { name: "Více" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".mobileMoreGroup")).toHaveCount(3);
    await expect(sheet.getByRole("heading", { name: "Plánování" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Filtry" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Systém" })).toBeVisible();
    await expect(sheet.locator('.mobileMoreItem[data-nav-view="Settings"]')).toBeVisible();
    await expect(page.locator(".mobileCaptureButton")).toHaveCount(0);
    await expect(nav.locator("button.active")).toHaveCount(1);
    await expect(nav.locator('button[data-nav-view="More"]')).toHaveClass(/active/);
    await expect(nav.locator('button[data-nav-view="Calendar"]')).not.toHaveClass(/active/);
    const calendarRect = await nav.locator('button[data-nav-view="Calendar"]').boundingBox();
    expect(calendarRect).not.toBeNull();
    await expect.poll(() => page.evaluate(({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest(".mobileMoreBackdrop")),
      { x: calendarRect!.x + calendarRect!.width / 2, y: calendarRect!.y + calendarRect!.height / 2 },
    )).toBe(true);
    await expect(sheet.getByRole("button", { name: "Zavřít nabídku" })).toHaveCount(1);
    await expect(sheet.locator(".mobileMoreGroup button")).toHaveCount(12);
    await sheet.locator('.mobileMoreItem[data-nav-view="Settings"]').click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".mobileCaptureButton")).toBeVisible();
    await expect(nav.locator('button[data-nav-view="More"]')).toHaveClass(/active/);
  });

  test("Escape closes, returns focus, and Tab stays in the open dialog", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    const trigger = page.locator('.mobileNav button[data-nav-view="More"]');
    await trigger.click();
    const sheet = page.locator(".mobileMore");
    const close = sheet.getByRole("button", { name: "Zavřít nabídku" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.locator(".mobileMoreItem").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("iPhone SE can reach each 44px target without clipping", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await waitUntilSynced(page);
    await page.locator('.mobileNav button[data-nav-view="More"]').click();
    const sheet = page.locator(".mobileMore");
    const rect = await sheet.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    for (const item of await sheet.locator("button").all()) {
      await item.scrollIntoViewIfNeeded();
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(667);
    }
  });
});
