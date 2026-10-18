import { test, expect } from "./fixtures";
import { seeded, waitUntilSynced } from "./helpers";

test("working lists show one right-side value and no repeated view subtitles", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const row = page.locator(".taskRow", { hasText: seeded.plainTask }).first();
  await expect(row).toBeVisible();
  await expect(row.locator(".taskRowMain strong")).toContainText(seeded.plainTask);
  await expect(row.locator("small")).toHaveCount(0);
  await expect(row.locator(".check")).toHaveAttribute("aria-label", `Dokončit ${seeded.plainTask}`);

  await page.goto("/?view=Projects");
  await expect(page.locator(".taskRow[data-entity-type='project']").first()).toHaveAttribute("data-entity-type", "project");
  await expect(page.locator(".taskRow[data-entity-type='project'] .taskRowMeta").first()).toContainText(/\\d+ úkol/);
  await expect(page.locator(".taskRow[data-entity-type='project'] small")).toHaveCount(0);

  await page.goto("/?view=Notes");
  const title = `B4 note ${Date.now()}`;
  const input = page.locator(".capture input");
  await input.fill(title);
  await input.press("Enter");
  const note = page.locator(".taskRow[data-entity-type='note']", { hasText: title });
  await expect(note).toBeVisible();
  await expect(note.locator(".taskRowMeta[data-meta-kind='date']")).toBeVisible();
  await expect(note.locator("small")).toHaveCount(0);
});

test("workspace source remains visible in aggregate view on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator(".mobileWorkspaceButton").click();
  await page.locator('.mobileWorkspaceMenu [data-workspace-id="all"]').click();
  const row = page.locator(".taskRow").first();
  await expect(row).toBeVisible();
  await expect(row.locator(".workspaceBadge")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
