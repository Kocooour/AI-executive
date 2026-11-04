import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { removeTasks, seedTasks, waitUntilSynced } from "./helpers";
import { addCalendarDays, calendarLocalDayRange } from "../lib/calendar-event-display";
import { zonedDateTimeToIso } from "../lib/local-dates";

const zone = "Europe/Prague";
const today = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
async function mockDays(page: Page, dates: string[], failOnceOnDay?: string) {
  const reads: Array<{ from: number; to: number; workspaceId: string }> = [];
  const failWindow = failOnceOnDay ? calendarLocalDayRange(failOnceOnDay, 1, zone) : null;
  let failedOnce = false;
  const now = Date.now();
  const events = dates.map((day, i) => ({
    id: `ui04a-${i}`, uid: `ui04a-${i}`, title: `Událost dne ${i}`,
    start: zonedDateTimeToIso(day, "10:00", zone), end: zonedDateTimeToIso(day, "11:00", zone),
    sourceId: "ui04a-source", workspaceId: "personal", occurrenceKey: `ui04a-${i}`,
    recurring: false, allDay: false, timezone: zone, status: "confirmed",
    transparency: "OPAQUE", busy: true, private: false,
  }));
  await page.route("**/api/calendar?**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const query = new URL(route.request().url()).searchParams;
    const from = Number(query.get("from")), to = Number(query.get("to"));
    const workspaceId = query.get("workspaceId") || "";
    reads.push({ from, to, workspaceId });
    if (failWindow && from === failWindow.start && to === failWindow.end && !failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service temporarily unavailable" }) });
      return;
    }
    // Match the real server's half-open time window. Unrelated days are NOT
    // returned just because the test fixture knows those events.
    const filtered = events.filter((event) =>
      event.workspaceId === workspaceId && Date.parse(event.end) > from && Date.parse(event.start) < to);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sources: [{ id: "ui04a-source", workspaceId: "personal", provider: "ics", accountId: null,
        label: "E2E", status: "ready", configured: true, lastSyncAt: now, lastSuccessAt: now,
        lastError: "", eventCount: events.length, revision: 1 }],
      events: filtered,
    }) });
  });
  return reads;
}

test("phone day bubbles select one civil day, mute earlier dates and never reuse today's capacity", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  const base = today(), past = addCalendarDays(base, -2), next = addCalendarDays(base, 1);
  const far = addCalendarDays(base, 21);
  await page.setViewportSize({ width: 390, height: 844 });
  const reads = await mockDays(page, [past, base, next, far]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  const picker = page.locator(".mobileCalendarPicker");
  await expect(picker).toBeVisible();
  await expect(page.locator(".mobileCalendarDay")).toBeVisible();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", base);
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-0"]')).toHaveCount(0);
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toHaveCount(0);
  await expect(picker.locator(`[data-date="${past}"]`)).toHaveAttribute("data-past", "true");

  await picker.locator(`[data-date="${next}"]`).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", next);
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toHaveCount(0);
  await expect(page.getByText(/Jiný než dnešní den|Outside today/)).toBeVisible();
  await expect(page.locator(".calendarFreshness")).not.toContainText(/voln|free hours/i);

  await picker.locator(`[data-date="${past}"]`).click();
  const selectedPast = picker.locator(`[data-date="${past}"]`);
  await expect(selectedPast).toHaveAttribute("aria-pressed", "true");
  await expect(selectedPast).not.toHaveAttribute("data-past", "true");
  expect(await selectedPast.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(139, 92, 246)");
  await expect(page.locator('[data-timeline-item="event:ui04a-0"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toHaveCount(0);
  const pastRange = calendarLocalDayRange(past, 1, zone);
  await expect.poll(() => reads.some((r) =>
    r.workspaceId === "personal" && r.from <= pastRange.start && r.to >= pastRange.end)).toBe(true);

  await picker.getByRole("button", { name: /Dnes|Today/ }).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", base);
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toBeVisible();
  // +21 days is outside the default initial +14-day fetch but inside the
  // server's recurrence cache. Each week jump requests a real selected day.
  for (let week = 0; week < 3; week += 1)
    await picker.getByRole("button", { name: /Následující týden|Next week/ }).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", far);
  await expect(page.locator('[data-timeline-item="event:ui04a-3"]')).toBeVisible();
  const farRange = calendarLocalDayRange(far, 1, zone);
  await expect.poll(() => reads.some((r) =>
    r.workspaceId === "personal" && r.from === farRange.start && r.to === farRange.end)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("the gated calendar keeps the desktop overview and future agenda intact", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockDays(page, [today(), addCalendarDays(today(), 1)]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await expect(page.locator(".mobileCalendarPicker")).toHaveCount(0);
  await expect(page.locator("#calendar-today-title")).toBeVisible();
  await expect(page.locator("#calendar-near-term-title")).toBeVisible();
});

test("day fetch errors never masquerade as an empty day; retry re-requests its exact window", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  const base = today(), target = addCalendarDays(base, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  const reads = await mockDays(page, [base, target], target);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await page.locator(`[data-date="${target}"]`).click();
  await expect(page.locator('[data-calendar-day-state="error"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toHaveCount(0);
  await page.locator('[data-calendar-day-state="error"] button').click();
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toBeVisible();
  await expect(page.locator('[data-calendar-day-state="error"]')).toHaveCount(0);
  const range = calendarLocalDayRange(target, 1, zone);
  await expect.poll(() => reads.filter((r) => r.from === range.start && r.to === range.end).length).toBeGreaterThanOrEqual(2);
});

test("selected day excludes adjacent all-day VALUE=DATE entries even when SQL UTC-overlap includes them", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  const selected = addCalendarDays(today(), 1);
  const previous = addCalendarDays(selected, -1);
  const next = addCalendarDays(selected, 1);
  const afterNext = addCalendarDays(selected, 2);
  const fixtures = [
    { id: "all-day-previous", start: `${previous}T00:00:00.000Z`, end: `${selected}T00:00:00.000Z`, allDay: true },
    { id: "all-day-selected", start: `${selected}T00:00:00.000Z`, end: `${next}T00:00:00.000Z`, allDay: true },
    { id: "all-day-next", start: `${next}T00:00:00.000Z`, end: `${afterNext}T00:00:00.000Z`, allDay: true },
    { id: "timed-overnight", start: zonedDateTimeToIso(previous, "23:30", zone),
      end: zonedDateTimeToIso(selected, "01:30", zone), allDay: false },
  ].map((item) => ({
    ...item, uid: item.id, title: item.id, sourceId: "ui04a-source", workspaceId: "personal",
    occurrenceKey: item.id, recurring: false, timezone: zone, status: "confirmed", busy: true, private: false,
  }));
  const reads: Array<{ from: number; to: number; ids: string[] }> = [];
  await page.route("**/api/calendar?**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const query = new URL(route.request().url()).searchParams;
    const from = Number(query.get("from")), to = Number(query.get("to"));
    const events = fixtures.filter((item) =>
      Date.parse(item.end) > from && Date.parse(item.start) < to);
    reads.push({ from, to, ids: events.map((item) => item.id) });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sources: [{ id: "ui04a-source", workspaceId: "personal", provider: "ics",
        label: "E2E", status: "ready", configured: true, lastSyncAt: Date.now(),
        lastSuccessAt: Date.now(), lastError: "", eventCount: fixtures.length, revision: 1 }],
      events,
    }) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await page.locator(`[data-date="${selected}"]`).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", selected);
  const range = calendarLocalDayRange(selected, 1, zone);
  await expect.poll(() => reads.some((read) =>
    read.from === range.start && read.to === range.end && read.ids.includes("all-day-previous"))).toBe(true);
  await expect(page.locator('[data-timeline-item="event:all-day-selected"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:timed-overnight"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:all-day-previous"]')).toHaveCount(0);
  await expect(page.locator('[data-timeline-item="event:all-day-next"]')).toHaveCount(0);
});

test("Today's skipped-plan chip stays on Today and never appears on another selected calendar day", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  const base = today(), tomorrow = addCalendarDays(base, 1);
  const stamp = Date.now().toString(36);
  const nowTask = { id: `e2e-ui04a-skip-now-${stamp}`, title: `Today's skipped plan ${stamp}`,
    properties: { today: true, planningFeedback: { date: base, decision: "dismissed" } } };
  const laterTask = { id: `e2e-ui04a-skip-next-${stamp}`, title: `Future task with today's feedback ${stamp}`,
    properties: { when: tomorrow, planningFeedback: { date: base, decision: "dismissed" } } };
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDays(page, [base, tomorrow]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  try {
    await seedTasks(page, [nowTask, laterTask]);
    // Supply a known-valid Today's plan. Without it TodayTimeCell would
    // return null even in the buggy code, yielding a false positive.
    await page.route("**/api/day-plan?**", async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const date = query.get("date") || base;
      const workspaceId = query.get("workspaceId") || "personal";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        revision: 1, date, workspaceId, timezone: zone,
        calendar: "ready", freeMinutes: 480, requiredMinutes: 0, overloaded: false,
        existingBlocks: [], planBlocks: [], unscheduled: [],
      }) });
    });
    await page.reload();
    await waitUntilSynced(page);
    const todayRow = page.locator(`[data-untimed-task="${nowTask.id}"]`);
    await expect(todayRow).toBeVisible();
    await expect(todayRow.locator("[data-time-cell]")).toHaveAttribute("data-time-kind", "skipped");

    await page.locator(`[data-date="${tomorrow}"]`).click();
    await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", tomorrow);
    const futureRow = page.locator(`[data-untimed-task="${laterTask.id}"]`);
    await expect(futureRow).toBeVisible();
    await expect(futureRow.locator("[data-time-cell]")).toHaveCount(0);
    await expect(futureRow).not.toContainText(/Dnes neplánov|Not planned today/i);

    await page.locator(".mobileCalendarTodayJump").click();
    await expect(todayRow.locator("[data-time-cell]")).toHaveAttribute("data-time-kind", "skipped");
  } finally {
    await page.unroute("**/api/day-plan?**");
    await removeTasks(page, [nowTask.id, laterTask.id]);
  }
});
