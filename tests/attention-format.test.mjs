import assert from "node:assert/strict";
import test from "node:test";

const { attentionReason } = await import("../app/ui/format.ts");

function timed(at, reasonCode = "deadline_overdue", timezone = "Europe/Prague") {
  return {
    reasonCode,
    reasonFacts: { deadlineAllDay: false },
    relevantAt: Date.parse(at),
    relevantDate: at.slice(0, 10),
    timezone,
  };
}

test("timed Attention dates preserve local time and show a human zone label across DST", () => {
  for (const [instant, expectedHour, winter] of [
    ["2026-01-05T12:00:00Z", "13:00", true],
    ["2026-07-05T12:00:00Z", "14:00", false],
  ]) {
    const item = timed(instant);
    for (const [language, locale] of [["cs", "cs-CZ"], ["en", "en-GB"]]) {
      const result = attentionReason(item, language);
      const expected = new Date(instant).toLocaleString(locale, {
        timeZone: "Europe/Prague",
        timeZoneName: "short",
      });
      assert.ok(result.includes(expected), `${language}: ${result} missing local date ${expected}`);
      assert.ok(result.includes(expectedHour), result);
      assert.doesNotMatch(result, /Europe\/Prague|\([A-Za-z_]+\/[A-Za-z_]+\)/);
      if (language === "cs") assert.match(result, winter ? /SEČ/ : /SELČ/);
    }
    const upcoming = attentionReason(timed(instant, "deadline_soon"), "cs");
    assert.match(upcoming, /příštích 48 hodinách/);
    assert.doesNotMatch(upcoming, /Europe\/Prague/);
  }
});

test("all-day deadlines retain the local-day explanation without adding a clock zone", () => {
  const item = {
    ...timed("2026-10-25T23:00:00Z"),
    reasonFacts: { deadlineAllDay: true },
    relevantDate: "2026-10-25",
  };
  const result = attentionReason(item, "cs");
  assert.match(result, /po konci místního dne/);
  assert.doesNotMatch(result, /Europe\/Prague|SEČ|SELČ|GMT/);
});

test("non-Prague timed deadlines show the correct foreign local clock and short zone", () => {
  const instant = "2026-11-05T13:00:00Z";
  const item = timed(instant, "deadline_overdue", "America/New_York");
  const result = attentionReason(item, "en");
  assert.ok(result.includes(new Date(instant).toLocaleString("en-GB", {
    timeZone: "America/New_York", timeZoneName: "short",
  })));
  assert.doesNotMatch(result, /America\/New_York/);
});
