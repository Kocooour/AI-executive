import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { waitUntilSynced } from "./helpers";

// Keyboard focus uses the design-system focus-ring token everywhere, including the controls that
// hide the browser outline, and touch controls are at least 44px. Nothing is saved.

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--focus-ring)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
}

// Focus as the keyboard does: a key press first, so the focus counts as :focus-visible.
async function keyboardFocus(page: Page, target: Locator) {
  await page.keyboard.press("Shift");
  await target.focus();
}

async function outline(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, colour: style.outlineColor, shadow: style.boxShadow };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`keyboard focus shows the focus ring on fields, search and buttons (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const ring = await focusRing(page);

    // The add field of a list: the ring, not the old 8% outline.
    await keyboardFocus(page, page.locator(".capture input").first());
    expect(await outline(page.locator(".capture input").first())).toMatchObject({ style: "solid", width: "2px", colour: ring });

    // Search: the bare input has no outline, the field around it shows the ring.
    await keyboardFocus(page, page.locator(".searchField input"));
    expect((await outline(page.locator(".searchField input"))).style).toBe("none");
    expect(await outline(page.locator(".searchField"))).toMatchObject({ style: "solid", width: "2px", colour: ring });

    // An ordinary button uses the shared rule.
    const settingsTab = page.locator(".settingsTabs button").first();
    await page.goto("/?view=Settings");
    await waitUntilSynced(page);
    await keyboardFocus(page, settingsTab);
    expect(await outline(settingsTab)).toMatchObject({ style: "solid", width: "2px", colour: ring });
  });
}

test("the task title shows focus as an underline in the focus colour", async ({ page }) => {
  await page.goto("/?task=e2e-plain");
  const title = page.locator("input.titleEdit");
  await expect(title).toBeVisible();
  const ring = await focusRing(page);
  await keyboardFocus(page, title);
  const focused = await outline(title);
  expect(focused.style).toBe("none");
  expect(focused.shadow).toContain(ring);
  expect(await title.evaluate((element) => getComputedStyle(element).borderBottomColor)).toBe(ring);
});

test("every item of the phone More sheet is a 44px target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  await page.locator('.mobileNav button[data-nav-view="More"]').click();
  const items = page.locator(".mobileMore button");
  await expect(items.first()).toBeVisible();
  for (const item of await items.all()) {
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test.describe("touch screen with the sidebar", () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test("sidebar controls are 44px targets", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.locator("aside .secondaryNav summary").click();
    const controls = page.locator("aside nav button, aside .sidebarActions button, aside .secondaryNav summary, aside .secondaryNav button");
    expect(await controls.count()).toBeGreaterThan(5);
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box!.height, await control.innerText()).toBeGreaterThanOrEqual(44);
    }
  });
});
