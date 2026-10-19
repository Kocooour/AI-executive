import { zonedDateTimeToIso } from "./local-dates";

export interface CalendarDisplayEvent {
  start: string;
  end: string;
  allDay: boolean;
}

export interface CalendarEventDisplay {
  /** The part of a timed event that falls within `day`, when a day is supplied. */
  time: string;
  /** A date label suitable for an agenda that spans several days. */
  date: string;
  /** Complete, read-only event timing for the event inspector. */
  detail: string;
  continuesFromPreviousDay: boolean;
  continuesIntoNextDay: boolean;
  coversWholeDay: boolean;
}

const localeFor = (language: string) => language === "cs" ? "cs-CZ" : "en-GB";

function addDays(day: string, amount: number) {
  const [year, month, date] = day.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, date + amount));
  return result.toISOString().slice(0, 10);
}

function dateRange(start: Date, end: Date, language: string, timezone: string, endExclusive = false) {
  const locale = localeFor(language);
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: timezone });
  const last = endExclusive ? new Date(end.getTime() - 1) : end;
  const firstText = formatter.format(start);
  const lastText = formatter.format(last);
  return firstText === lastText ? firstText : `${firstText}–${lastText}`;
}

/**
 * Whether an event belongs to a civil calendar day.  Timed events use the
 * configured local time zone; iCalendar VALUE=DATE events keep their
 * date-only, UTC-persisted inclusive/exclusive boundaries.
 */
export function calendarEventOverlapsLocalDay(event: CalendarDisplayEvent, day: string, timezone: string) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return false;
  if (event.allDay) return start.toISOString().slice(0, 10) <= day && day < end.toISOString().slice(0, 10);
  const dayStart = new Date(zonedDateTimeToIso(day, "00:00", timezone));
  const dayEnd = new Date(zonedDateTimeToIso(addDays(day, 1), "00:00", timezone));
  return end > dayStart && start < dayEnd;
}

export function calendarEventOverlapsLocalDays(event: CalendarDisplayEvent, firstDay: string, days: number, timezone: string) {
  return Array.from({ length: Math.max(0, days) }, (_, index) =>
    calendarEventOverlapsLocalDay(event, addDays(firstDay, index), timezone),
  ).some(Boolean);
}

/**
 * Formats an event without letting an overnight event leak yesterday's time into
 * today's agenda. All-day end values follow ICS's exclusive-end convention.
 */
export function calendarEventDisplay(event: CalendarDisplayEvent, {
  language,
  timezone,
  day,
}: { language: string; timezone: string; day?: string }): CalendarEventDisplay {
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { time: "", date: "", detail: "", continuesFromPreviousDay: false, continuesIntoNextDay: false, coversWholeDay: false };
  }

  const locale = localeFor(language);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  const fullDateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone });
  // VALUE=DATE entries have no time zone. The calendar importer persists their
  // date-only boundaries as UTC midnights, so formatting in the viewer's zone
  // would move them to the previous/next calendar day west/east of UTC.
  const allDayDate = dateRange(start, end, language, "UTC", true);
  if (event.allDay) return {
    time: "",
    date: allDayDate,
    detail: allDayDate,
    continuesFromPreviousDay: false,
    continuesIntoNextDay: false,
    coversWholeDay: false,
  };

  let visibleStart = start;
  let visibleEnd = end;
  let continuesFromPreviousDay = false;
  let continuesIntoNextDay = false;
  let coversWholeDay = false;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const dayStart = new Date(zonedDateTimeToIso(day, "00:00", timezone));
    const dayEnd = new Date(zonedDateTimeToIso(addDays(day, 1), "00:00", timezone));
    continuesFromPreviousDay = start < dayStart;
    continuesIntoNextDay = end > dayEnd;
    visibleStart = start < dayStart ? dayStart : start;
    visibleEnd = end > dayEnd ? dayEnd : end;
    coversWholeDay = visibleStart.getTime() === dayStart.getTime() && visibleEnd.getTime() === dayEnd.getTime();
  }
  return {
    time: `${time.format(visibleStart)}–${time.format(visibleEnd)}`,
    date: dateRange(start, end, language, timezone),
    detail: `${fullDateTime.format(start)}–${fullDateTime.format(end)}`,
    continuesFromPreviousDay,
    continuesIntoNextDay,
    coversWholeDay,
  };
}
