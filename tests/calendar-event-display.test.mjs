import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays, calendarEventDisplay, calendarEventOverlapsLocalDay, calendarEventOverlapsLocalDays, calendarEventOverlapsLocalRange, calendarLocalDayRange } from "../lib/calendar-event-display.ts";

test("an overnight event is clipped to the displayed local day and says it continues", () => {
  const display = calendarEventDisplay({
    start: "2026-10-19T21:00:00Z", end: "2026-10-20T00:00:00Z", allDay: false,
  }, { language: "en", timezone: "Europe/Prague", day: "2026-10-20" });

  assert.equal(display.time, "00:00–02:00");
  assert.equal(display.continuesFromPreviousDay, true);
  assert.equal(display.continuesIntoNextDay, false);
});

test("a day-spanning event marks both boundaries of its local-day slice", () => {
  const display = calendarEventDisplay({
    start: "2026-10-19T21:00:00Z", end: "2026-10-21T02:00:00Z", allDay: false,
  }, { language: "en", timezone: "Europe/Prague", day: "2026-10-20" });

  assert.equal(display.time, "00:00–00:00");
  assert.equal(display.continuesFromPreviousDay, true);
  assert.equal(display.continuesIntoNextDay, true);
  assert.equal(display.coversWholeDay, true);
});

test("all-day events expose their inclusive date range without an off-by-one end date", () => {
  const display = calendarEventDisplay({
    start: "2026-10-22T00:00:00Z", end: "2026-10-24T00:00:00Z", allDay: true,
  }, { language: "en", timezone: "UTC" });

  assert.equal(display.date, "Thu 22 Oct–Fri 23 Oct");
  assert.equal(display.detail, "Thu 22 Oct–Fri 23 Oct");
});

test("all-day event dates do not move with the viewer's time zone", () => {
  const display = calendarEventDisplay({
    start: "2026-10-22T00:00:00Z", end: "2026-10-24T00:00:00Z", allDay: true,
  }, { language: "en", timezone: "America/Los_Angeles" });

  assert.equal(display.date, "Thu 22 Oct–Fri 23 Oct");
});

test("all-day end is exclusive in Prague too", () => {
  const display = calendarEventDisplay({
    start: "2026-10-22T00:00:00Z", end: "2026-10-24T00:00:00Z", allDay: true,
  }, { language: "cs", timezone: "Europe/Prague" });

  assert.equal(display.date, "čt 22. 10.–pá 23. 10.");
});

test("all-day membership follows date-only bounds, not the viewer's instant offset", () => {
  const event = { start: "2026-10-22T00:00:00Z", end: "2026-10-24T00:00:00Z", allDay: true };

  assert.equal(calendarEventOverlapsLocalDay(event, "2026-10-21", "America/Los_Angeles"), false);
  assert.equal(calendarEventOverlapsLocalDay(event, "2026-10-22", "America/Los_Angeles"), true);
  assert.equal(calendarEventOverlapsLocalDay(event, "2026-10-23", "Europe/Prague"), true);
  assert.equal(calendarEventOverlapsLocalDay(event, "2026-10-24", "Europe/Prague"), false);
  assert.equal(calendarEventOverlapsLocalDays(event, "2026-10-18", 7, "Europe/Prague"), true);
  assert.equal(calendarEventOverlapsLocalDays(event, "2026-10-24", 7, "Europe/Prague"), false);
});

test("near-term calendar range covers tomorrow through day seven and keeps continuing events", () => {
  const today = "2026-10-19";
  const range = calendarLocalDayRange(addCalendarDays(today, 1), 7, "America/Los_Angeles");
  const event = (start, end, allDay = false) => ({ start, end, allDay });
  assert.equal(range.firstDay, "2026-10-20");
  assert.equal(range.lastExclusiveDay, "2026-10-27");
  assert.equal(calendarEventOverlapsLocalRange(event("2026-10-19T17:00:00Z", "2026-10-20T06:00:00Z"), range), false);
  assert.equal(calendarEventOverlapsLocalRange(event("2026-10-19T17:00:00Z", "2026-10-20T08:00:00Z"), range), true);
  assert.equal(calendarEventOverlapsLocalRange(event("2026-10-20T00:00:00Z", "2026-10-22T00:00:00Z", true), range), true);
  assert.equal(calendarEventOverlapsLocalRange(event("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", true), range), true);
  assert.equal(calendarEventOverlapsLocalRange(event("2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", true), range), false);
});
