import { addCalendarDays, calendarEventOverlapsLocalDay, type CalendarDisplayEvent } from "./calendar-event-display";

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
