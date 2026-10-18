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
