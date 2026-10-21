import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";
import { zonedDateTimeToIso } from "../lib/local-dates";

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
    await expect(suggested.getByRole("button", { name: "Přijmout" })).toBeVisible();
    await expect(plan.locator('[data-plan-group="fixed"] button', { hasText: "Přijmout" })).toHaveCount(0);
    await suggested.locator(".whyNow summary").click();
    await expect(suggested.locator(".whyNow")).toHaveAttribute("open", "");
    await expect(suggested.locator(".whyNow li")).toHaveCount(1);
    if (width === 390) {
      const minHeight = await suggested.getByRole("button", { name: "Přijmout" })
        .evaluate((button) => button.getBoundingClientRect().height);
      expect(minHeight).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });

  test("Today calendar includes early, late and all-day events at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const timezone = "Europe/Prague";
    const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const today = [localParts.year, localParts.month, localParts.day].join("-");
    const addDay = (date: string, days: number) => {
      const at = new Date(date + "T12:00:00Z");
      at.setUTCDate(at.getUTCDate() + days);
      return at.toISOString().slice(0, 10);
    };
    const yesterday = addDay(today, -1);
    const tomorrow = addDay(today, 1);
    const on = (date: string, hour: string) => zonedDateTimeToIso(date, hour, timezone);
    const event = (id: string, title: string, start: string, end: string, busy: boolean, allDay = false) =>
      ({ id, title, start, end, busy, allDay, timezone, sourceId: "today-mock-source",
        workspaceId: "personal", status: "confirmed", private: false });
    const events = [
      event("early", "Morning meeting outside work hours", on(today, "07:00"), on(today, "07:30"), true),
      event("midday", "Open midday calendar slot", on(today, "12:00"), on(today, "12:30"), false),
      event("late", "Evening meeting outside work hours", on(today, "19:00"), on(today, "20:00"), true),
      event("all-day", "All-day birthday", `${today}T00:00:00.000Z`, `${tomorrow}T00:00:00.000Z`, true, true),
      event("overnight", "Previous evening crossing midnight", on(yesterday, "23:30"), on(today, "00:30"), true),
      event("tomorrow", "Tomorrow must not appear", on(tomorrow, "09:00"), on(tomorrow, "10:00"), true),
    ];
    await page.route("**/api/calendar?**", async (route) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          sources: [{
            id: "today-mock-source", workspaceId: "personal", provider: "ics",
            label: "Synthetic calendar", status: "ready", configured: true,
            lastSyncAt: Date.now(), lastSuccessAt: Date.now(), lastError: "",
            eventCount: events.length, revision: 1,
          }],
          events,
        }),
      });
    });
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    const section = page.locator(".todayCalendarCommitments");
    await expect(section.getByRole("heading", { name: "Události v kalendáři" })).toBeVisible();
    const agenda = section.locator(".calendarAgenda");
    await expect(agenda.locator(":scope > div")).toHaveCount(5);
    await expect(agenda).toContainText("Morning meeting outside work hours");
    await expect(agenda).toContainText("Evening meeting outside work hours");
    await expect(agenda).toContainText("Open midday calendar slot");
    await expect(agenda).toContainText("All-day birthday");
    await expect(agenda).toContainText("Previous evening crossing midnight");
    await expect(agenda).not.toContainText("Tomorrow must not appear");
    await expect(agenda.locator(".free", { hasText: "Open midday calendar slot" }))
      .toContainText("volný čas");
    const allDayEvent = agenda.locator(":scope > div", { hasText: "All-day birthday" });
    await expect(allDayEvent.locator("span")).toHaveText("Celý den");

    // Today displays only the portion after local midnight, not yesterday's 23:30 start.
    const overnightEvent = agenda.locator(":scope > div", { hasText: "Previous evening crossing midnight" });
    await expect(overnightEvent.locator("span")).toHaveText(/^0?0:00–0?0:30$/);
    await expect(overnightEvent.locator("small")).toContainText("Pokračuje z předchozího dne");
    const morningEvent = agenda.locator(":scope > div", { hasText: "Morning meeting outside work hours" });
    await expect(morningEvent.locator("span")).toHaveText(/^0?7:00–0?7:30$/);

    // This repair must not change the existing Home workday-only agenda.
    await page.goto("/?view=Home");
    await expect(page.locator(".view-home .calendarAgenda")).toContainText("Open midday calendar slot");
    await expect(page.locator(".view-home .calendarAgenda")).not.toContainText("Evening meeting outside work hours");
    await expect(page.locator(".view-home .calendarAgenda")).not.toContainText("Morning meeting outside work hours");
    if (width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });

}
