import assert from "node:assert/strict";
import test from "node:test";

const { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } = await import("../lib/local-dates.ts");

test("ymd formats the local calendar day with zero padding", () => {
  assert.equal(ymd(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(ymd(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

test("addLocalDays crosses month and year boundaries without mutating its input", () => {
  const start = new Date(2026, 11, 31, 12);
  assert.equal(ymd(addLocalDays(start, 1)), "2027-01-01");
  assert.equal(ymd(addLocalDays(start, -31)), "2026-11-30");
  assert.equal(ymd(start), "2026-12-31");
});

test("local date-time input values round-trip to the same instant", () => {
  const iso = "2026-10-07T08:30:00.000Z";
  const local = toLocalDateTime(iso);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(fromLocalDateTime(local), iso);
});

test("empty or invalid date-time values become an empty input value", () => {
  assert.equal(toLocalDateTime(""), "");
  assert.equal(toLocalDateTime(undefined), "");
  assert.equal(toLocalDateTime(42), "");
  assert.equal(toLocalDateTime("not a date"), "");
  assert.equal(fromLocalDateTime(""), "");
});

test("a wall-clock time in an IANA zone converts to the exact UTC instant in summer and winter", () => {
  assert.equal(zonedDateTimeToIso("2026-10-07", "09:00", "Europe/Prague"), "2026-10-07T07:00:00.000Z");
  assert.equal(zonedDateTimeToIso("2026-01-15", "09:00", "Europe/Prague"), "2026-01-15T08:00:00.000Z");
  assert.equal(zonedDateTimeToIso("2026-10-25", "12:00", "Europe/Prague"), "2026-10-25T11:00:00.000Z");
  assert.equal(zonedDateTimeToIso("2026-07-01", "00:30", "America/New_York"), "2026-07-01T04:30:00.000Z");
  assert.equal(zonedDateTimeToIso("2026-07-01", "18:00", "UTC"), "2026-07-01T18:00:00.000Z");
});
