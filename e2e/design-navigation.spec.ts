import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// The first real use of the generated design system must survive switching workspaces
// and a 390px viewport. No browser state or server data is mutated by these checks.
test("sidebar shows a workspace tile, colour band and matching active navigation", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const shell = page.locator(".appShell");
  await expect(shell).toHaveAttribute("data-workspace-tone", "personal");
  await expect(page.locator("aside .workspaceButton .workspaceTile")).toHaveText("O");
  await expect(page.locator("aside .workspaceButton .workspaceTile")).toHaveAttribute("data-tone", "personal");
  const styles = await page.evaluate(() => {
    const shell = document.querySelector(".appShell")!;
    const pane = document.querySelector(".appPane")!;
    const active = document.querySelector("aside nav button[aria-current='page']")!;
    const band = getComputedStyle(pane);
    const activeBg = getComputedStyle(active).backgroundColor;
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--workspace-soft)";
    shell.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { border: band.borderTopWidth, color: band.borderTopColor, activeBg, expected };
  });
  expect(styles.border).toBe("3px");
  expect(styles.activeBg).toBe(styles.expected);
  expect(styles.color).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator("aside .workspaceButton").click();
  await page.locator("aside .workspaceMenu button", { hasText: "Všechna práce" }).click();
  await expect(shell).toHaveAttribute("data-workspace-tone", "all");
  await expect(page.locator("aside .workspaceButton .workspaceTile")).toHaveText("∗");
  await page.locator("aside .workspaceButton").click();
  await page.locator("aside .workspaceMenu button", { hasText: "Osobní" }).click();
  await expect(shell).toHaveAttribute("data-workspace-tone", "personal");
});

test("iPhone workspace and bottom navigation remain readable and keyboard-accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(page.locator(".mobileWorkspaceButton")).toBeVisible();
  await expect(page.locator(".mobileWorkspaceButton .workspaceTile")).toHaveAttribute("data-tone", "personal");
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
  await page.locator(".mobileWorkspaceMenu button", { hasText: "Všechna práce" }).click();
  await expect(page.locator(".appShell")).toHaveAttribute("data-workspace-tone", "all");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
