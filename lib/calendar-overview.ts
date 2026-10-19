import { zonedDateTimeToIso } from "./local-dates";

export interface CalendarOverviewInterval {
  id: string;
  start?: string;
  end?: string;
  allDay?: boolean;
}

function parsedInterval(item: CalendarOverviewInterval, timezone: string) {
  if (item.allDay && (!item.start || !item.end || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(item.start) || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(item.end) || !Number.isFinite(Date.parse(item.start)) || !Number.isFinite(Date.parse(item.end)))) return null;
  // Imported VALUE=DATE boundaries are stored at UTC midnight, but describe
  // civil dates. Convert those dates to local midnights before comparing with
  // timed work blocks, including across daylight-saving changes.
  const start = item.allDay && item.start
    ? Date.parse(zonedDateTimeToIso(item.start.slice(0, 10), "00:00", timezone))
    : Date.parse(item.start || "");
  const end = item.allDay && item.end
    ? Date.parse(zonedDateTimeToIso(item.end.slice(0, 10), "00:00", timezone))
    : Date.parse(item.end || "");
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] as const : null;
}

// Half-open intervals mean that a block ending exactly when another begins is not a conflict.
export function calendarOverviewConflictIds(items: CalendarOverviewInterval[], timezone = "UTC") {
  const conflicts = new Set<string>();
  for (let left = 0; left < items.length; left += 1) {
    const a = parsedInterval(items[left], timezone);
    if (!a) continue;
    for (let right = left + 1; right < items.length; right += 1) {
      const b = parsedInterval(items[right], timezone);
      if (!b || a[1] <= b[0] || b[1] <= a[0]) continue;
      conflicts.add(items[left].id);
      conflicts.add(items[right].id);
    }
  }
  return conflicts;
}

export function calendarOverviewIntersects(left: CalendarOverviewInterval, right: CalendarOverviewInterval, timezone = "UTC") {
  const a = parsedInterval(left, timezone);
  const b = parsedInterval(right, timezone);
  return Boolean(a && b && a[0] < b[1] && b[0] < a[1]);
}
