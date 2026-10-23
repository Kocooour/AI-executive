import assert from "node:assert/strict";
import test from "node:test";
import { layoutDayTimeline, timelineNowOffset, untimedRowHeight, UNTIMED_MAX_PX, UNTIMED_MIN_PX } from "../lib/day-timeline.ts";

const base = { day: "2026-10-21", timezone: "Europe/Prague", workdayStart: "08:00", workdayEnd: "18:00" };
// Prague is UTC+2 on 2026-10-21 (summer time ends 2026-10-25).
const at = (time) => `2026-10-21T${time}:00.000Z`;
const item = (id, from, to) => ({ id, start: at(from), end: at(to) });

test("the axis covers the workday window and places items by start with height proportional to duration", () => {
  const layout = layoutDayTimeline([item("a", "08:00", "09:00"), item("b", "10:00", "11:30")], base);
  assert.equal(layout.axisStartMinute, 8 * 60);
  assert.equal(layout.axisEndMinute, 18 * 60);
  assert.equal(layout.height, 600);
  assert.deepEqual(layout.hours.map((hour) => hour.label).slice(0, 3), ["08:00", "09:00", "10:00"]);
  const [a, b] = layout.items;
  // 08:00Z is 10:00 in Prague: two hours into the axis.
  assert.equal(a.top, 120);
  assert.equal(a.height, 60);
  assert.equal(b.height, 90);
  assert.equal(b.height / a.height, 1.5);
  assert.deepEqual(layout.items.map((entry) => entry.id), ["a", "b"]);
});

test("the pixel scale multiplies positions and heights", () => {
  const layout = layoutDayTimeline([item("a", "08:00", "09:00")], { ...base, pxPerMinute: 0.8 });
  assert.equal(layout.items[0].top, 96);
  assert.equal(layout.items[0].height, 48);
  assert.equal(layout.height, 480);
});

test("very short items keep a readable minimum height without changing their position", () => {
  const layout = layoutDayTimeline([item("short", "08:00", "08:05")], base);
  assert.equal(layout.items[0].height, 22);
  assert.equal(layout.items[0].durationMinutes, 5);
});

test("overlapping items are placed side by side in lanes; later items start a new cluster", () => {
  const layout = layoutDayTimeline([
    item("a", "08:00", "10:00"), item("b", "09:00", "10:30"), item("c", "09:30", "10:00"),
    item("d", "12:00", "13:00"),
  ], base);
  const byId = Object.fromEntries(layout.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.a.column, 0);
  assert.equal(byId.b.column, 1);
  assert.equal(byId.c.column, 2);
  assert.deepEqual([byId.a.columns, byId.b.columns, byId.c.columns], [3, 3, 3]);
  assert.equal(byId.d.column, 0);
  assert.equal(byId.d.columns, 1);
});

test("back-to-back items share a lane and a lane is reused once free", () => {
  const layout = layoutDayTimeline([item("a", "08:00", "09:00"), item("b", "09:00", "10:00"), item("c", "08:30", "09:30")], base);
  const byId = Object.fromEntries(layout.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.a.column, 0);
  assert.equal(byId.c.column, 1);
  assert.equal(byId.b.column, 0);
  assert.equal(byId.a.columns, 2);
});

test("two short neighbours closer than the minimum height do not draw over each other", () => {
  const layout = layoutDayTimeline([item("a", "08:00", "08:10"), item("b", "08:12", "08:20")], base);
  assert.deepEqual(layout.items.map((entry) => entry.column), [0, 1]);
});

test("items outside the workday extend the axis to whole hours", () => {
  const layout = layoutDayTimeline([item("early", "04:30", "05:15"), item("late", "19:00", "20:20")], base);
  assert.equal(layout.axisStartMinute, 6 * 60);
  assert.equal(layout.axisEndMinute, 23 * 60);
  assert.equal(layout.hours[0].label, "06:00");
  assert.equal(layout.hours.at(-1).label, "23:00");
  assert.equal(layout.items[0].top, 30);
});

test("an event crossing midnight is clipped to the day and says so", () => {
  const layout = layoutDayTimeline([{ id: "night", start: "2026-10-20T21:30:00.000Z", end: "2026-10-20T22:30:00.000Z" }, { id: "late", start: "2026-10-21T21:00:00.000Z", end: "2026-10-21T23:30:00.000Z" }], base);
  const [night, late] = layout.items;
  assert.equal(night.startMinute, 0);
  assert.equal(night.durationMinutes, 30);
  assert.equal(night.continuesFromPreviousDay, true);
  assert.equal(late.continuesIntoNextDay, true);
  assert.equal(late.endMinute, 24 * 60);
});

test("items on other days and invalid items are dropped", () => {
  const layout = layoutDayTimeline([item("ok", "08:00", "09:00"), { id: "other", start: "2026-10-22T08:00:00Z", end: "2026-10-22T09:00:00Z" }, { id: "bad", start: "x", end: "y" }, { id: "neg", start: at("10:00"), end: at("09:00") }], base);
  assert.deepEqual(layout.items.map((entry) => entry.id), ["ok"]);
});

test("a daylight-saving day is measured in elapsed time (spring: 23 h, autumn: 25 h)", () => {
  const spring = layoutDayTimeline([{ id: "m", start: "2026-03-29T00:30:00Z", end: "2026-03-29T02:00:00Z" }], { ...base, day: "2026-03-29" });
  // Midnight is 23:00Z on the 28th; the clock jumps 02:00 -> 03:00 at 01:00Z. 00:30Z is 01:30 CET, 02:00Z is 04:00 CEST.
  assert.equal((spring.dayEndMs - spring.dayStartMs) / 60_000, 23 * 60);
  assert.equal(spring.items[0].durationMinutes, 90);
  assert.equal(spring.items[0].height, 90);
  assert.equal(spring.axisStartMinute, 60);
  assert.equal(spring.hours[0].label, "01:00");
  const autumn = layoutDayTimeline([], { ...base, day: "2026-10-25" });
  assert.equal((autumn.dayEndMs - autumn.dayStartMs) / 60_000, 25 * 60);
  // The workday is 08:00-18:00 local, i.e. one extra elapsed hour after the repeated 02:00 hour.
  assert.equal(autumn.axisStartMinute, 9 * 60);
  assert.equal(autumn.hours[0].label, "08:00");
  assert.equal(autumn.height, 600);
  // An hour across the spring skipped hour is 60 real minutes, not 120 wall-clock ones.
  const across = layoutDayTimeline([{ id: "x", start: "2026-03-29T00:30:00Z", end: "2026-03-29T01:30:00Z" }], { ...base, day: "2026-03-29" });
  assert.equal(across.items[0].height, 60);
  assert.equal(new Set(across.hours.map((hour) => hour.minute)).size, across.hours.length);
});

test("an invalid workday window falls back to 08:00-18:00", () => {
  const layout = layoutDayTimeline([], { ...base, workdayStart: "18:00", workdayEnd: "08:00" });
  assert.equal(layout.axisStartMinute, 8 * 60);
  assert.equal(layout.axisEndMinute, 18 * 60);
});

test("untimed rows scale with the estimate within the clamp; no estimate gets the minimum", () => {
  assert.equal(untimedRowHeight(undefined), UNTIMED_MIN_PX);
  assert.equal(untimedRowHeight(null), UNTIMED_MIN_PX);
  assert.equal(untimedRowHeight(0), UNTIMED_MIN_PX);
  assert.equal(untimedRowHeight(15), UNTIMED_MIN_PX);
  assert.equal(untimedRowHeight(90), 90);
  assert.equal(untimedRowHeight(600), UNTIMED_MAX_PX);
  assert.equal(untimedRowHeight(90, 0.8), 72);
});

test("now is placed on the axis only inside today's axis", () => {
  const layout = layoutDayTimeline([], base);
  assert.equal(timelineNowOffset(layout, Date.parse("2026-10-21T08:00:00Z")), 120);
  assert.equal(timelineNowOffset(layout, Date.parse("2026-10-21T02:00:00Z")), null);
  assert.equal(timelineNowOffset(layout, Date.parse("2026-10-22T08:00:00Z")), null);
});

test("a compact axis fits the items (at least three hours) instead of the whole workday", () => {
  const layout = layoutDayTimeline([item("a", "11:10", "11:50"), item("b", "12:30", "13:00")], { ...base, fitToItems: true });
  // 11:10Z..13:00Z is 13:10..15:00 in Prague: padded to a 3-hour span, then to whole hours.
  assert.equal(layout.axisStartMinute, 12 * 60);
  assert.equal(layout.axisEndMinute, 16 * 60);
  const wide = layoutDayTimeline([item("a", "06:00", "14:00")], { ...base, fitToItems: true });
  assert.equal(wide.axisStartMinute, 8 * 60);
  assert.equal(wide.axisEndMinute, 16 * 60);
  const none = layoutDayTimeline([], { ...base, fitToItems: true });
  assert.equal(none.axisStartMinute, 8 * 60);
  assert.equal(none.axisEndMinute, 18 * 60);
});

test("more overlapping items than lanes collapse into one +N group in the last lane", () => {
  const many = ["a", "b", "c", "d", "e", "f"].map((id) => item(id, "08:00", "09:00"));
  const layout = layoutDayTimeline(many, { ...base, maxColumns: 4 });
  assert.equal(layout.items.length, 3);
  assert.deepEqual(layout.items.map((entry) => entry.column), [0, 1, 2]);
  assert.ok(layout.items.every((entry) => entry.columns === 4));
  assert.equal(layout.overflow.length, 1);
  assert.equal(layout.overflow[0].items.length, 3);
  assert.equal(layout.overflow[0].column, 3);
  // Nothing is lost: every source is either placed or in the group.
  assert.equal(layout.items.length + layout.overflow[0].items.length, many.length);
  const phone = layoutDayTimeline(many, { ...base, maxColumns: 3 });
  assert.equal(phone.items.length, 2);
  assert.equal(phone.overflow[0].items.length, 4);
  // Within the cap there is no group.
  assert.equal(layoutDayTimeline(many.slice(0, 4), { ...base, maxColumns: 4 }).overflow.length, 0);
});

test("underlay items (hidden events) take no lane", () => {
  const layout = layoutDayTimeline([item("a", "08:00", "09:00"), { ...item("hidden", "08:00", "09:30"), underlay: true }, item("b", "08:30", "09:00")], base);
  const byId = Object.fromEntries(layout.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.hidden.underlay, true);
  assert.equal(byId.hidden.columns, 1);
  assert.deepEqual([byId.a.columns, byId.b.columns], [2, 2]);
});
