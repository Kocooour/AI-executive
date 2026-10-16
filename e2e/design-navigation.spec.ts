import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { waitUntilSynced } from "./helpers";

// The first real use of the generated design system must survive switching workspaces, both
// themes and a 390px viewport. Workspaces are picked by id, not by their (localised) labels.
// No browser state or server data is mutated by these checks.

async function navigationColours(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".appShell")!;
    const topbar = document.querySelector(".appPane > .topbar")!;
    const active = document.querySelector("aside nav button[aria-current='page']")!;
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      shell.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    };
    const bar = getComputedStyle(topbar);
    return {
      bandImage: bar.backgroundImage,
      bandSize: bar.backgroundSize,
      workspaceColour: resolve("var(--workspace-color)"),
      activeBg: getComputedStyle(active).backgroundColor,
      workspaceSoft: resolve("var(--workspace-soft)"),
      accentSoft: resolve("var(--accent-soft)"),
    };
  });
}

async function scrollAndCheckBand(page: Page) {
  // A DOM-only spacer makes the page scrollable whatever the seeded data; nothing is saved.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "e2e-scroll-spacer";
    spacer.style.height = "3000px";
    document.querySelector(".content")!.append(spacer);
    window.scrollTo(0, 1500);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const top = await page.locator(".appPane > .topbar").boundingBox();
  expect(top).not.toBeNull();
  expect(top!.y).toBeGreaterThanOrEqual(-1);
  expect(top!.y).toBeLessThanOrEqual(1);
  await page.evaluate(() => { document.getElementById("e2e-scroll-spacer")?.remove(); window.scrollTo(0, 0); });
}

for (const theme of ["light", "dark"] as const) {
  test(`sidebar shows a workspace tile, colour band and matching active navigation (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    await waitUntilSynced(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const shell = page.locator(".appShell");
    await expect(shell).toHaveAttribute("data-workspace-tone", "personal");
    await expect(page.locator("aside .workspaceButton .workspaceTile")).toHaveAttribute("data-tone", "personal");

    const colours = await navigationColours(page);
    expect(colours.bandSize).toBe("100% 3px");
    // The band is a gradient of the workspace colour on the sticky top bar.
    expect(colours.bandImage).toContain(colours.workspaceColour);
    expect(colours.activeBg).toBe(colours.workspaceSoft);
    expect(colours.activeBg).not.toBe(colours.accentSoft);

    // Scrolled down, the band stays in view on the sticky top bar.
    await scrollAndCheckBand(page);

    await page.locator("aside .workspaceButton").click();
    await page.locator('aside .workspaceMenu button[data-workspace-id="all"]').click();
    await expect(shell).toHaveAttribute("data-workspace-tone", "all");
    await expect(page.locator("aside .workspaceButton .workspaceTile")).toHaveText("∗");
    await page.locator("aside .workspaceButton").click();
    await page.locator('aside .workspaceMenu button[data-workspace-id="personal"]').click();
    await expect(shell).toHaveAttribute("data-workspace-tone", "personal");
  });
}

test("iPhone workspace and bottom navigation remain readable and keyboard-accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(page.locator(".mobileWorkspaceButton")).toBeVisible();
  await expect(page.locator(".mobileWorkspaceButton .workspaceTile")).toHaveAttribute("data-tone", "personal");
  // On the phone too the top bar with the band and the workspace tile stays in view while scrolling.
  await scrollAndCheckBand(page);
  const bottom = page.locator(".mobileNav");
  await expect(bottom).toBeVisible();
  await expect(bottom.locator("button")).toHaveCount(5);
  for (const button of await bottom.locator("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await bottom.locator('button[data-nav-view="Today"]').click();
  await expect(bottom.locator('button[data-nav-view="Today"]')).toHaveAttribute("aria-current", "page");
  await page.locator(".mobileWorkspaceButton").click();
  await expect(page.locator(".mobileWorkspaceMenu")).toBeVisible();
  await page.locator('.mobileWorkspaceMenu button[data-workspace-id="all"]').click();
  await expect(page.locator(".appShell")).toHaveAttribute("data-workspace-tone", "all");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
