import { test, expect } from "./fixtures";
import { removeTasks, seedTasks, waitUntilSynced } from "./helpers";
import { zonedDateTimeToIso } from "../lib/local-dates";

// The server's day-plan response is the UI's trusted read model; the fixture below replaces it for
// four tasks that exist in the store (seeded with unique titles and removed again at the end). Since
// D2 the plan is not a separate card: each Today row has a time cell (docs/proposals §5.3).
for (const width of [390, 1280]) {
  test(`Today separates existing, approved, proposed and unscheduled work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const stamp = `${Date.now()}-${width}`;
    const tasks = {
      fixed: { id: `e2e-e2-fixed-${stamp}`, title: `Existing fixed commitment ${stamp}` },
      approved: { id: `e2e-e2-approved-${stamp}`, title: `Approved work ${stamp}` },
      suggested: { id: `e2e-e2-suggested-${stamp}`, title: `Pending owner approval ${stamp}` },
      unscheduled: { id: `e2e-e2-unscheduled-${stamp}`, title: `No suitable time ${stamp}` },
    };
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    await seedTasks(page, Object.values(tasks).map((task) => ({ ...task, properties: { today: true } })));
    try {
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
              { ...shared, taskId: tasks.fixed.id, title: tasks.fixed.title,
                start: at("09:00"), end: at("09:30"), planningSource: "manual" },
              { ...shared, taskId: tasks.approved.id, title: tasks.approved.title,
                start: at("10:00"), end: at("10:30"), planningSource: "albert-day-plan" },
            ],
            planBlocks: [
              { ...shared, taskId: tasks.suggested.id, title: tasks.suggested.title,
                start: at("11:00"), end: at("11:30") },
            ],
            unscheduled: [
              { ...shared, taskId: tasks.unscheduled.id, title: tasks.unscheduled.title },
            ],
          }),
        });
      });

      await page.goto("/?view=Today");
      await waitUntilSynced(page);
      await expect(page.getByRole("heading", { name: "Dnes", level: 1 })).toBeVisible();
      // No separate plan list: the plan is the time cell of each row.
      await expect(page.locator(".dayPlanCard, .dayPlanGroup")).toHaveCount(0);
      const row = (task: { title: string }) => page.locator(".taskRow", { hasText: task.title });
      const cell = (task: { title: string }) => row(task).locator("[data-time-cell]");
      const range = /^\d{2}:\d{2}–\d{2}:\d{2}$/;
      const expected = [
        { task: tasks.fixed, kind: "existing", state: "Již naplánováno" },
        { task: tasks.approved, kind: "existing", state: "Schválený blok" },
        { task: tasks.suggested, kind: "proposed", state: "Navržený blok" },
        { task: tasks.unscheduled, kind: "unscheduled", state: "Bez vhodného bloku" },
      ];
      for (const group of expected) {
        await expect(row(group.task)).toHaveCount(1);
        await expect(cell(group.task)).toHaveAttribute("data-time-kind", group.kind);
        if (group.kind === "unscheduled") await expect(cell(group.task)).toHaveText("—");
        else await expect(cell(group.task)).toHaveText(range);
        // The status is written out (in the label of the cell and in its menu), not only styled.
        await expect(cell(group.task)).toHaveAttribute("aria-label", new RegExp(`^${group.state}`));
      }
      // A proposal is muted with a dotted underline; accepted blocks are plain text.
      await expect(cell(tasks.suggested)).toHaveCSS("text-decoration-style", "dotted");
      await expect(cell(tasks.fixed)).not.toHaveCSS("text-decoration-style", "dotted");

      // Menus: Přijmout only for the proposal; the reasons are listed.
      await cell(tasks.fixed).click();
      let menu = page.locator(`[data-time-menu="${tasks.fixed.id}"]`);
      await expect(menu).toContainText("Již naplánováno");
      await expect(menu.getByRole("button", { name: "Přijmout" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await cell(tasks.suggested).click();
      menu = page.locator(`[data-time-menu="${tasks.suggested.id}"]`);
      await expect(menu).toContainText("Navržený blok");
      const accept = menu.getByRole("button", { name: "Přijmout" });
      await expect(accept).toBeVisible();
      await expect(menu.getByRole("button", { name: "Jiný čas" })).toBeVisible();
      await expect(menu.getByRole("button", { name: "Zítra" })).toBeVisible();
      await expect(menu.getByRole("button", { name: "Neplánovat" })).toBeVisible();
      await expect(menu.locator(".timeMenuWhy li")).toHaveCount(1);
      if (width === 390) {
        const minHeight = await accept.evaluate((button) => button.getBoundingClientRect().height);
        expect(minHeight).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(cell(tasks.suggested)).toBeFocused();
      await cell(tasks.unscheduled).click();
      menu = page.locator(`[data-time-menu="${tasks.unscheduled.id}"]`);
      await expect(menu).toContainText("Bez vhodného bloku");
      await expect(menu.getByRole("button", { name: "Přijmout" })).toHaveCount(0);
      await expect(menu.getByRole("button", { name: "Zítra" })).toBeVisible();
    } finally {
      await page.unroute("**/api/day-plan?**");
      await removeTasks(page, Object.values(tasks).map((task) => task.id));
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
    await expect(section.getByRole("heading", { name: "Průběh dne" })).toBeVisible();
    // The timeline lists the timed events by start; all-day events are a strip above the axis.
    const timed = section.locator(".dayTimelineItems [data-timeline-item]");
    await expect(timed).toHaveCount(4);
    const allDay = section.locator(".dayTimelineAllDay [data-timeline-item]");
    await expect(allDay).toHaveCount(1);
    await expect(allDay).toContainText("All-day birthday");
    await expect(allDay).toContainText("Celý den");
    const named = (title: string) => section.locator("[data-timeline-item]", { hasText: title });
    await expect(named("Morning meeting outside work hours")).toBeVisible();
    await expect(named("Evening meeting outside work hours")).toBeVisible();
    await expect(named("Open midday calendar slot")).toBeVisible();
    await expect(section).not.toContainText("Tomorrow must not appear");
    await expect(named("Open midday calendar slot")).toHaveAttribute("aria-label", /volný čas/);

    // Today displays only the portion after local midnight, not yesterday's 23:30 start.
    await expect(named("Previous evening crossing midnight")).toHaveAttribute("aria-label", /^Previous evening crossing midnight, 0?0:00–0?0:30, 30 min/);
    await expect(named("Previous evening crossing midnight")).toHaveAttribute("aria-label", /Pokračuje z předchozího dne/);
    await named("Previous evening crossing midnight").click();
    await expect(section.locator("[data-timeline-panel]")).toContainText("Pokračuje z předchozího dne");
    await page.keyboard.press("Escape");
    await expect(named("Morning meeting outside work hours")).toHaveAttribute("aria-label", /^Morning meeting outside work hours, 0?7:00–0?7:30, 30 min/);

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
