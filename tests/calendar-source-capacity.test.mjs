import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calendarSourceCapacity } from "../lib/calendar-source-capacity.ts";
import { effectiveBusyEvents, occurrenceDecisionKey } from "../lib/calendar-decisions.ts";

const at = (clock) => Date.parse("2026-11-19T" + clock + ":00.000Z");
const sourceEvent = (id, start, end, busy = true) => ({
  id, sourceId: "source", uid: id, occurrenceKey: id + ":2026-11-19", start: new Date(start).toISOString(),
  end: new Date(end).toISOString(), allDay: false, status: "confirmed", busy,
});

test("C-1: a historical converted or hidden event remains busy in the source-only calendar", () => {
  const converted = sourceEvent("converted", at("09:00"), at("10:00"));
  const hidden = sourceEvent("hidden", at("12:00"), at("13:00"));
  const oldTask = {
    id: "legacy-task", type: "task", title: "old local task", workspaceId: "personal",
    status: "open", properties: { calendarEventId: "converted" }, createdAt: 1, updatedAt: 1,
  };
  const decisions = { [occurrenceDecisionKey(hidden)]: "hidden" };
  assert.deepEqual(effectiveBusyEvents([converted, hidden], decisions, [oldTask]), [],
    "legacy capacity previously omitted both source-busy events");

  const result = calendarSourceCapacity([converted, hidden], at("08:00"), at("18:00"));
  assert.equal(result.freeHours, 8, "both occupied hours count even though legacy decisions suppress them");
  assert.deepEqual(result.freeWindows, [
    [at("08:00"), at("09:00")], [at("10:00"), at("12:00")], [at("13:00"), at("18:00")],
  ]);
});

test("C-1: source capacity merges overlapping busy intervals, clips to workday and ignores free events", () => {
  const result = calendarSourceCapacity([
    sourceEvent("earlier", at("07:00"), at("09:30")),
    sourceEvent("overlap", at("09:00"), at("10:00")),
    sourceEvent("free", at("11:00"), at("13:00"), false),
    sourceEvent("late", at("17:00"), at("20:00")),
    { start: "invalid", end: new Date(at("12:00")).toISOString(), busy: true },
  ], at("08:00"), at("18:00"));
  assert.equal(result.freeHours, 7, "2 hours in morning and 1 in evening are occupied");
  assert.deepEqual(result.freeWindows, [[at("10:00"), at("17:00")]]);
  const shortGap = calendarSourceCapacity([
    sourceEvent("a", at("08:00"), at("09:00")),
    sourceEvent("b", at("09:20"), at("18:00")),
  ], at("08:00"), at("18:00"));
  assert.equal(shortGap.freeHours, 20 / 60);
  assert.deepEqual(shortGap.freeWindows, [], "gaps under 30 minutes are not advertised");
  assert.deepEqual(calendarSourceCapacity([], NaN, at("18:00")), { freeHours: 0, freeWindows: [] });
});

test("C-1: only target Calendar uses raw source capacity; legacy and partial profiles keep old values", () => {
  const root = readFileSync(new URL("../app/ui/lumi-app-root.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/ui/views/calendar-view.tsx", import.meta.url), "utf8");
  assert.match(root, /<CalendarView app=\{app\} eventsOnly=\{shellNavigation\.personalV1\} \/>/);
  assert.match(ui, /const sourceCapacity = eventsOnly \? calendarSourceCapacity\(/);
  assert.match(ui, /calendarEvents\.filter\(\(event\) => event\.workspaceId === workspaceId\)/);
  assert.match(ui, /const shownFreeHours = sourceCapacity\?\.freeHours \?\? freeHours/);
  assert.match(ui, /const shownFreeWindows = sourceCapacity\?\.freeWindows \?\? freeWindows/);
  assert.equal((ui.match(/shownFreeHours\.toFixed\(1\)/g) || []).length, 2,
    "both v1 and legacy status lines use the gated capacity");
  assert.equal((ui.match(/shownFreeWindows\.slice\(0, 3\)/g) || []).length, 2,
    "both mobile and desktop free-window lines use the gated capacity");
});

test("C-1: archived hide decisions never hide source events in target Calendar", () => {
  const ui = readFileSync(new URL("../app/ui/views/calendar-view.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../app/ui/views/day-timeline.tsx", import.meta.url), "utf8");
  assert.match(ui, /if \(!eventsOnly && isCalendarEventHidden\(event\)\)/,
    "target agenda must render the source event normally; legacy branch stays unchanged");
  assert.match(timeline, /const hidden = !eventsOnly && isCalendarEventHidden\(event\)/,
    "target timeline must not underlay, label or disable a historical hidden event");
  assert.match(ui, /<DayTimeline[^>]*eventsOnly=\{eventsOnly\}/,
    "both mobile and desktop timelines receive the target-only flag");
  assert.match(timeline, /underlay: hidden/,
    "the existing legacy underlay still uses the original hide decision when eventsOnly is off");
});

test("C-1: hidden event Unhide is disabled in read-only target Calendar", () => {
  const ui = readFileSync(new URL("../app/ui/views/calendar-view.tsx", import.meta.url), "utf8");
  const button = ui.match(/<button type="button" className="calendarEventHide" data-event-unhide=\{event\.id\}[^>]*>/)?.[0];
  assert.ok(button, "near-term hidden-event card keeps its Unhide button");
  assert.match(button, /disabled=\{app\.legacyWritesDisabled\}/);
  assert.match(button, /title=\{app\.legacyReadOnlyHint\}/);
  const timeline = readFileSync(new URL("../app/ui/views/day-timeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /data-event-unhide=\{event\.id\} disabled=\{app\.legacyWritesDisabled\}/);
});
