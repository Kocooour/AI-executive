import { test, expect } from "./fixtures";
import { expectOnServer, seeded, waitUntilSynced } from "./helpers";

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
    await expect(page.getByRole("button", { name: "Zavřít", exact: true })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "← Zpět" })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "← Zpět" })).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "fixed");
    const detail = await page.locator("aside.inspectorDetail").boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: seeded.plainTask })).toBeVisible();
  });

  test("a completing save does not replace a newer inspector selection", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    const title = page.locator("aside.inspectorDetail .titleEdit");
    await title.fill(`${seeded.plainTask} upraveno`);
    await page.locator(".taskRow", { hasText: seeded.renameTask }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(seeded.renameTask);
    // Wait for A's blur save to finish; it must not reopen A over the selected B.
    await expectOnServer(page, (entity) => entity.title === `${seeded.plainTask} upraveno`, true);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(seeded.renameTask);
  });

  test("keyboard can enter the inspector and returns focus to the originating task", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const opener = page.locator(".taskRow", { hasText: seeded.plainTask })
      .first().getByRole("button", { name: seeded.plainTask });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Space is also provided by the native button's keyboard activation.
    await page.keyboard.press("Space");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
  });

  test("rapid inspector switches keep the final selection and clear context on close", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    await page.locator(".taskRow", { hasText: seeded.renameTask }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(seeded.renameTask);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await page.locator(".taskRow", { hasText: seeded.plainTask }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(seeded.plainTask);
  });


});
