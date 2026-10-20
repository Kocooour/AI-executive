import { test, expect } from "./fixtures";
import { seeded, waitUntilSynced } from "./helpers";

test.describe("B2 responsive detail inspector", () => {
  test("desktop keeps the working list usable beside the detail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    await expect(page.locator(".appShell")).toHaveClass(/inspectorOpen/);
    await expect(page.locator(".appPane")).toBeVisible();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "sticky");
    await expect(page.locator(".taskRow", { hasText: seeded.plainTask })).toBeVisible();
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
  });

  test("tablet presents a full content detail with a back action", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    await expect(page.locator(".appPane")).toBeHidden();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.locator(".inspectorBackLabel")).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "relative");
    await page.locator(".inspectorClose").click();
    await expect(page.locator(".appPane")).toBeVisible();
  });

  test("iPhone shows a full-screen detail and returns to the list", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "fixed");
    const detail = await page.locator("aside.inspectorDetail").boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: seeded.plainTask })).toBeVisible();
  });
});
