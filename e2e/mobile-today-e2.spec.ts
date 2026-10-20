import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// Preview-only route fixture: no write requests or synthetic task IDs are sent to the
// canonical store. The server's day-plan response is the UI's trusted read model.
for (const width of [390, 1280]) {
  test(`Today separates existing, approved, proposed and unscheduled work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/day-plan?**", async (route) => {
      const request = new URL(route.request().url());
      const date = request.searchParams.get("date") || "2026-10-20";
      const workspaceId = request.searchParams.get("workspaceId") || "personal";
      const at = (time: string) => `${date}T${time}:00+02:00`;
      const shared = { estimatedMinutes: 30, reason: "today", estimateSource: "explicit",
        estimateSamples: 0, preferredMinute: null, timeSamples: 0, whyNow: ["due_today"] };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: 1, date, workspaceId, timezone: "Europe/Prague",
          calendar: "ready", freeMinutes: 120, requiredMinutes: 120, overloaded: false,
          existingBlocks: [
            { ...shared, taskId: "today-fixed", title: "Existing fixed commitment",
              start: at("09:00"), end: at("09:30"), planningSource: "manual" },
            { ...shared, taskId: "today-approved", title: "Approved work",
              start: at("10:00"), end: at("10:30"), planningSource: "albert-day-plan" },
          ],
          planBlocks: [
            { ...shared, taskId: "today-suggested", title: "Pending owner approval",
              start: at("11:00"), end: at("11:30") },
          ],
          unscheduled: [
            { ...shared, taskId: "today-unscheduled", title: "No suitable time" },
          ],
        }),
      });
    });

    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    await expect(page.getByRole("heading", { name: "Dnes", level: 1 })).toBeVisible();
    const plan = page.locator(".dayPlanCard");
    await expect(plan.locator(".dayPlanGroup")).toHaveCount(4);
    const expected = [
      { kind: "fixed", heading: "Pevně naplánováno", title: "Existing fixed commitment" },
      { kind: "approved", heading: "Schválené pracovní bloky", title: "Approved work" },
      { kind: "suggested", heading: "Návrhy ke schválení", title: "Pending owner approval" },
      { kind: "unscheduled", heading: "Úkoly bez času", title: "No suitable time" },
    ];
    for (const group of expected) {
      const region = plan.locator(`.dayPlanGroup[data-plan-group="${group.kind}"]`);
      await expect(region).toHaveAttribute("aria-label", group.heading);
      await expect(region.getByRole("heading", { name: group.heading, level: 3 })).toBeVisible();
      await expect(region.locator(".dayPlanBlock")).toHaveCount(1);
      await expect(region.locator(".dayPlanBlock")).toContainText(group.title);
    }
    const suggested = plan.locator('[data-plan-group="suggested"]');
    await expect(suggested.getByRole("button", { name: "Přijmout blok" })).toBeVisible();
    await expect(plan.locator('[data-plan-group="fixed"] button', { hasText: "Přijmout blok" })).toHaveCount(0);
    await suggested.locator(".whyNow summary").click();
    await expect(suggested.locator(".whyNow")).toHaveAttribute("open", "");
    await expect(suggested.locator(".whyNow li")).toHaveCount(1);
    if (width === 390) {
      const minHeight = await suggested.getByRole("button", { name: "Přijmout blok" })
        .evaluate((button) => button.getBoundingClientRect().height);
      expect(minHeight).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });
}
