import assert from "node:assert/strict";
import test from "node:test";
import { mobileCalendarDateParts, mobileCalendarEventsForDay, mobileCalendarStripDays, mobileCalendarReadWindow } from "../lib/mobile-calendar-day.ts";

test("date strip walks actual civil dates across DST and year boundaries", () => {
  assert.deepEqual(mobileCalendarStripDays("2026-03-29", 1, 2), ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
  assert.deepEqual(mobileCalendarStripDays("2026-12-31", 1, 2), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(mobileCalendarStripDays("nonsense").length, 0);
});

test("Czech date bubbles include weekday over date without timezone drift", () => {
  const w = mobileCalendarDateParts("2026-11-04", "cs");
  assert.match(w.weekday, /^St/);
  assert.equal(w.date, "4");
  assert.match(w.accessibleLabel, /4/);
});

test("only the requested day contains midnight-crossing, all-day and timed events", () => {
  const events = [
    { id: "night", start: "2026-10-24T21:30:00.000Z", end: "2026-10-25T02:30:00.000Z", allDay: false },
    { id: "all-day", start: "2026-10-25T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z", allDay: true },
    { id: "other", start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z", allDay: false },
    { id: "edge", start: "2026-10-25T21:00:00.000Z", end: "2026-10-25T23:00:00.000Z", allDay: false },
  ];
  assert.deepEqual(mobileCalendarEventsForDay(events, "2026-10-25", "Europe/Prague").map((e) => e.id), ["night", "all-day", "edge"]);
  assert.deepEqual(mobileCalendarEventsForDay(events, "2026-10-26", "Europe/Prague").map((e) => e.id), ["other"]);
  assert.deepEqual(mobileCalendarEventsForDay(events, "2026-10-24", "Europe/Prague").map((e) => e.id), ["night"]);
});

test("selected day reads its complete local-midnight window across both DST changes", () => {
  const spring = mobileCalendarReadWindow("2026-03-29", "2026-03-29", "Europe/Prague");
  assert.ok(spring);
  assert.equal(new Date(spring.from).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(new Date(spring.to).toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal((spring.to - spring.from) / 3_600_000, 23);
  const autumn = mobileCalendarReadWindow("2026-10-25", "2026-10-25", "Europe/Prague");
  assert.ok(autumn);
  assert.equal(new Date(autumn.from).toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(new Date(autumn.to).toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal((autumn.to - autumn.from) / 3_600_000, 25);
});

test("calendar source cache horizon is bounded and does not claim unavailable days", () => {
  const today = "2026-11-04";
  assert.ok(mobileCalendarReadWindow("2026-10-22", today, "Europe/Prague"));
  assert.equal(mobileCalendarReadWindow("2026-10-21", today, "Europe/Prague"), null);
  assert.ok(mobileCalendarReadWindow("2027-02-01", today, "Europe/Prague"));
  assert.equal(mobileCalendarReadWindow("2027-02-02", today, "Europe/Prague"), null);
  assert.equal(mobileCalendarReadWindow("not-a-day", today, "Europe/Prague"), null);
});
