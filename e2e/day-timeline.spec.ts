import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { removeTasks, seedTasks, serverEntities, waitUntilSynced } from "./helpers";
import { zonedDateTimeToIso } from "../lib/local-dates";

// The day timeline: items are as tall as they last (60 px per hour on a wide screen), overlapping items
// stand side by side, and the same view is the day overview in Today and in Calendar. The calendar
// is a fixed mock of /api/calendar; tasks are seeded with unique titles and removed again.

const timezone = "Europe/Prague";
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const localToday = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const on = (time: string) => zonedDateTimeToIso(localToday(), time, timezone);

type MockEvent = { id: string; title: string; start: string; end: string };
async function mockCalendar(page: Page, events: MockEvent[]) {
  const now = Date.now();
  await page.route("**/api/calendar?**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sources: [{ id: "e2e-tl-src", workspaceId: "personal", provider: "ics", accountId: null, label: "E2E", status: "ready", configured: true, lastSyncAt: now, lastSuccessAt: now, lastError: "", eventCount: events.length, revision: 1 }],
      events: events.map((event) => ({ ...event, uid: event.id, recurring: false, sourceId: "e2e-tl-src", workspaceId: "personal", occurrenceKey: `${event.id}:${event.start}`, allDay: false, timezone, status: "confirmed", transparency: "OPAQUE", busy: true, private: false })),
    }) });
  });
}
const item = (page: Page, title: string) => page.locator("[data-timeline-item]", { hasText: title });
const box = async (page: Page, title: string) => {
  const rect = await item(page, title).evaluate((node) => (node.closest("li") as HTMLElement).getBoundingClientRect().toJSON());
  return rect as { x: number; y: number; width: number; height: number };
};

for (const width of [1280, 390]) {
  test(`Calendar: an event's height follows its length and overlapping events stand side by side at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const id = stamp();
    const events: MockEvent[] = [
      { id: `tl-60-${id}`, title: `Hodinová schůzka ${id}`, start: on("09:00"), end: on("10:00") },
      { id: `tl-90-${id}`, title: `Poradna ${id}`, start: on("11:00"), end: on("12:30") },
      { id: `tl-a-${id}`, title: `Souběh A ${id}`, start: on("14:00"), end: on("15:00") },
      { id: `tl-b-${id}`, title: `Souběh B ${id}`, start: on("14:30"), end: on("15:30") },
      { id: `tl-short-${id}`, title: `Krátký hovor ${id}`, start: on("16:00"), end: on("16:05") },
    ];
    await mockCalendar(page, events);
    await page.goto("/?view=Calendar");
    await waitUntilSynced(page);

    const sixty = await box(page, events[0].title);
    const ninety = await box(page, events[1].title);
    // 1 px per minute (0.8 on a phone): 90 minutes is 1.5 times as tall as 60.
    expect(ninety.height / sixty.height).toBeCloseTo(1.5, 1);
    expect(sixty.height).toBeCloseTo(60, 0);
    // Its position follows its start: 11:00 is two hours below 09:00.
    expect(ninety.y - sixty.y).toBeCloseTo(120, 0);

    // The accessible name carries title, time range and length.
    await expect(item(page, events[1].title)).toHaveAttribute("aria-label", new RegExp(`^${events[1].title}, 0?11:00–0?12:30, 90 min`));
    await expect(item(page, events[1].title)).toHaveAttribute("data-timeline-minutes", "90");

    // Two overlapping events sit next to each other, both visible, neither wider than half the lane.
    const a = await box(page, events[2].title);
    const b = await box(page, events[3].title);
    expect(b.x).toBeGreaterThan(a.x + a.width / 2);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
    expect(a.y).toBeLessThan(b.y);
    expect(a.width).toBeCloseTo(b.width, 0);
    await expect(item(page, events[2].title)).toBeVisible();
    await expect(item(page, events[3].title)).toBeVisible();

    // A five-minute event keeps a readable minimum height.
    const short = await box(page, events[4].title);
    expect(short.height).toBeGreaterThanOrEqual(22);
    expect(short.height).toBeLessThan(30);

    // No horizontal scroll, on the phone too.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // The items are a list in start order.
    const order = await page.locator("[data-day-timeline] [data-timeline-item]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-timeline-item")));
    expect(order).toEqual(events.map((event) => `event:${event.id}`));
    if (process.env.E4_SHOTS) await page.screenshot({ path: `${process.env.E4_SHOTS}/calendar-${width}.png`, fullPage: true });
  });
}

test("Today and Calendar: a task made from an event is as tall as its estimate; tasks without a time are rows sized by estimate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = stamp();
  const event: MockEvent = { id: `tl-task-${id}`, title: `Workshop ${id}`, start: on("13:00"), end: on("14:00") };
  const long = { id: `e2e-tl-long-${id}`, title: `Dlouhý úkol ${id}`, properties: { today: true, estimatedMinutes: 120 } };
  const none = { id: `e2e-tl-none-${id}`, title: `Úkol bez odhadu ${id}`, properties: { today: true } };
  const brief = { id: `e2e-tl-brief-${id}`, title: `Krátký úkol ${id}`, properties: { today: true, estimatedMinutes: 15 } };
  const eve = { id: `e2e-tl-eve-${id}`, title: `Večerní úkol ${id}`, properties: { today: true, when: localToday(), evening: true } };
  await mockCalendar(page, [event]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  try {
    await seedTasks(page, [long, none, brief, eve]);
    await page.reload();
    await waitUntilSynced(page);

    // Untimed rows: height follows the estimate within the clamp; no estimate gets the minimum.
    const longRow = page.locator(`[data-untimed-task="${long.id}"]`);
    const noneRow = page.locator(`[data-untimed-task="${none.id}"]`);
    await expect(longRow).toContainText("120 min");
    await expect(noneRow).toContainText("bez odhadu");
    const longHeight = (await longRow.boundingBox())!.height, noneHeight = (await noneRow.boundingBox())!.height;
    expect(longHeight).toBeGreaterThanOrEqual(119);
    expect(longHeight).toBeGreaterThan(noneHeight * 2);
    expect(noneHeight).toBeGreaterThanOrEqual(44);
    await expect(longRow.getByRole("button", { name: `Dokončit ${long.title}` })).toBeVisible();

    // "Ano": the event becomes a task of its length and stays on the axis, now as that task.
    await item(page, event.title).click();
    // "Je to úkol?" is asked only before the event is over; later the panel offers "Vytvořit úkol".
    await page.locator("[data-timeline-panel]").locator("[data-event-answer='yes'], [data-event-create-task]").first().click();
    await expect.poll(async () => (await serverEntities(page)).some((entity) => entity.title === event.title && entity.properties?.calendarEventId === event.id)).toBe(true);
    await expect(item(page, event.title)).toHaveAttribute("data-timeline-kind", "task");
    await expect(item(page, event.title)).toHaveAttribute("data-timeline-minutes", "60");
    await page.keyboard.press("Escape");

    // Today: the same day as an overview above the working list, which is unchanged.
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    const section = page.locator(".dayTimelineSection");
    await expect(section.getByRole("heading", { name: "Průběh dne" })).toBeVisible();
    await expect(section.locator("[data-timeline-item]", { hasText: event.title })).toHaveAttribute("data-timeline-kind", "task");
    await expect(page.locator(".taskRow", { hasText: long.title })).toBeVisible();
    // Never twice: the event's task is on the axis only, yet the header still counts it (3 tasks).
    await expect(page.locator(".taskRow", { hasText: event.title })).toHaveCount(0);
    const listed = await page.locator(".taskRowList .taskRow").count();
    await expect(page.locator("[data-today-summary]")).toContainText(new RegExp(`^${listed + 1} úkol`));
    // Complete and open stay reachable from its timeline panel.
    await section.locator("[data-timeline-item]", { hasText: event.title }).click();
    await expect(page.locator("[data-timeline-panel] [data-event-complete]")).toBeVisible();
    await expect(page.locator("[data-timeline-panel]").getByRole("button", { name: `Otevřít úkol ${event.title}` })).toBeVisible();
    await expect(page.locator("[data-timeline-panel] .deferChip")).toBeVisible();
    await page.keyboard.press("Escape");
    // List rows are as tall as their estimate (44-240 px) with a quiet label.
    const listLong = page.locator(".taskRow", { hasText: long.title }), listNone = page.locator(".taskRow", { hasText: none.title });
    await expect(listLong.locator("[data-row-estimate]")).toHaveText("120 min");
    await expect(listNone.locator("[data-row-estimate]")).toHaveText("bez odhadu");
    expect((await listLong.boundingBox())!.height).toBeGreaterThanOrEqual(119);
    expect((await listNone.boundingBox())!.height).toBeLessThan(60);
    // One evening group heading with one id, although a task left the list above it.
    await expect(page.locator("#today-evening-heading")).toHaveCount(1);
    await expect(page.locator(".eveningHeading")).toHaveCount(1);
    // The keyboard moves past the visible rows only (the event's task is not one of them).
    const regular = async () => (await page.locator(".taskRowList .taskRow:not(.eveningHeading ~ .taskRow) .taskRowOpen").allTextContents()).filter((text) => text.includes(id));
    const before = await regular();
    const at = before.indexOf(long.title);
    expect(at).toBeGreaterThanOrEqual(0);
    if (at < before.length - 1) {
      await listLong.locator(".dragHandle").focus();
      await page.keyboard.press("ArrowDown");
      await expect.poll(regular).toEqual(before.map((title, index) => index === at ? before[at + 1] : index === at + 1 ? long.title : title));
    }
    // A phone: the time cell shares the first line, so rows are about one line tall and only the estimate makes them taller.
    await page.setViewportSize({ width: 390, height: 844 });
    const heightOf = async (title: string) => (await page.locator(".taskRow", { hasText: title }).boundingBox())!.height;
    const phone = { long: await heightOf(long.title), none: await heightOf(none.title), brief: await heightOf(brief.title) };
    if (process.env.E4_SHOTS) console.log("PHONE_ROWS", JSON.stringify(phone));
    expect(phone.long).toBeGreaterThanOrEqual(119);
    expect(phone.none).toBeLessThan(62);
    expect(phone.brief).toBeLessThan(62);
    expect(phone.long).toBeGreaterThan(phone.brief * 1.8);
    if (process.env.E4_SHOTS) await page.screenshot({ path: `${process.env.E4_SHOTS}/today-390.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    if (process.env.E4_SHOTS) await page.screenshot({ path: `${process.env.E4_SHOTS}/today-1280.png`, fullPage: true });

    // Deferred to tomorrow, the event's task leaves Today altogether: not on the axis, not in the list.
    await section.locator("[data-timeline-item]", { hasText: event.title }).click();
    await page.locator("[data-timeline-panel] .deferChip").click();
    await page.locator('[data-defer-choice="tomorrow"]').click();
    await expect(section.locator("[data-timeline-item]", { hasText: event.title })).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: event.title })).toHaveCount(0);
  } finally {
    const created = (await serverEntities(page)).filter((entity) => entity.type === "task" && entity.title.includes(id)).map((entity) => entity.id);
    await removeTasks(page, [...new Set([long.id, none.id, brief.id, eve.id, ...created])]);
    await page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const now = Date.now();
      const entities = snapshot.entities.map((row: { id: string; properties: Record<string, unknown>; updatedAt: number }) => {
        if (row.id !== "workspace:personal" || !row.properties.calendarDecisions) return row;
        const { calendarDecisions: _gone, ...properties } = row.properties;
        return { ...row, properties, updatedAt: Math.max(now, row.updatedAt + 1) };
      });
      await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities, relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    });
  }
});
