import { addCalendarDays, calendarEventOverlapsLocalDay, calendarLocalDayRange, type CalendarDisplayEvent } from "./calendar-event-display";

// Civil dates are stepped in UTC (not by milliseconds in the viewer's zone).
// This keeps the date strip stable through both DST changes.
export function mobileCalendarStripDays(center: string, before = 7, after = 14): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(center) ||
      !Number.isInteger(before) || !Number.isInteger(after) ||
      before < 0 || after < 0 || before + after > 42) return [];
  return Array.from({ length: before + after + 1 }, (_, i) => addCalendarDays(center, i - before));
}

export function mobileCalendarDateParts(day: string, language: string) {
  const date = new Date(`${day}T12:00:00Z`);
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(date)
    .replace(/\.$/, "");
  const accessibleLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(date);
  return {
    weekday: weekday.charAt(0).toUpperCase() + weekday.slice(1),
    date: day.slice(-2).replace(/^0/, ""),
    accessibleLabel,
  };
}

// Only the chosen civil day is displayed. The shared display predicate handles
// midnight-crossing intervals, local timezone changes, and all-day exclusive ends.
export function mobileCalendarEventsForDay<T extends CalendarDisplayEvent>(
  events: readonly T[], day: string, timezone: string,
): T[] {
  return events.filter((event) => calendarEventOverlapsLocalDay(event, day, timezone));
}

/**
 * The source refresher expands recurring instances approximately 14 days back
 * and 90 days forward. Do not present dates outside that cache horizon as an
 * empty calendar (or keep issuing queries that cannot supply occurrences).
 * Conservative whole-day bounds also work close to midnight and across DST.
 */
export function mobileCalendarReadWindow(day: string, today: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
      day < addCalendarDays(today, -13) || day > addCalendarDays(today, 89)) return null;
  const range = calendarLocalDayRange(day, 1, timezone);
  return Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start
    ? { from: range.start, to: range.end }
    : null;
}

/**
 * Keyboard movement for the one-day mobile date strip. Civil-day arithmetic
 * keeps navigation stable across DST transitions and month/year boundaries.
 * Non-navigation keys must retain their native behavior.
 */
export function mobileCalendarKeyboardTarget(day: string, key: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const offset = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 :
    key === "PageUp" ? -7 : key === "PageDown" ? 7 : null;
  return offset === null ? null : addCalendarDays(day, offset);
}
