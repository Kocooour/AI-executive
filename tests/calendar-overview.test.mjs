import assert from "node:assert/strict";
import test from "node:test";
import { calendarOverviewConflictIds, calendarOverviewIntersects } from "../lib/calendar-overview.ts";

test("calendar overview marks only overlapping intervals as conflicts", () => {
  const conflicts = calendarOverviewConflictIds([
    { id: "event", start: "2026-10-18T09:00:00Z", end: "2026-10-18T10:00:00Z" },
    { id: "planned", start: "2026-10-18T09:30:00Z", end: "2026-10-18T10:30:00Z" },
    { id: "next", start: "2026-10-18T10:30:00Z", end: "2026-10-18T11:00:00Z" },
  ]);
  assert.deepEqual([...conflicts].sort(), ["event", "planned"]);
});

test("calendar overview ignores malformed and edge-touching intervals", () => {
  assert.equal(calendarOverviewIntersects(
    { id: "a", start: "2026-10-18T09:00:00Z", end: "2026-10-18T10:00:00Z" },
    { id: "b", start: "2026-10-18T10:00:00Z", end: "2026-10-18T11:00:00Z" },
  ), false);
  assert.deepEqual([...calendarOverviewConflictIds([
    { id: "bad", start: "no", end: "date" },
    { id: "valid", start: "2026-10-18T10:00:00Z", end: "2026-10-18T11:00:00Z" },
  ])], []);
});

test("all-day conflicts follow civil dates west of UTC, including an exclusive end", () => {
  const allDay = { id: "all-day", start: "2026-10-22T00:00:00Z", end: "2026-10-23T00:00:00Z", allDay: true };
  const previousEvening = { id: "previous", start: "2026-10-22T05:00:00Z", end: "2026-10-22T06:00:00Z" };
  const firstHour = { id: "first", start: "2026-10-22T07:00:00Z", end: "2026-10-22T08:00:00Z" };
  const lastHour = { id: "last", start: "2026-10-23T06:00:00Z", end: "2026-10-23T07:00:00Z" };
  const nextDay = { id: "next", start: "2026-10-23T07:00:00Z", end: "2026-10-23T08:00:00Z" };
  assert.equal(calendarOverviewIntersects(allDay, previousEvening, "America/Los_Angeles"), false);
  assert.equal(calendarOverviewIntersects(allDay, firstHour, "America/Los_Angeles"), true);
  assert.equal(calendarOverviewIntersects(allDay, lastHour, "America/Los_Angeles"), true);
  assert.equal(calendarOverviewIntersects(allDay, nextDay, "America/Los_Angeles"), false);
});
