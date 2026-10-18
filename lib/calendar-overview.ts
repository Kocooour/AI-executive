export interface CalendarOverviewInterval {
  id: string;
  start?: string;
  end?: string;
}

function parsedInterval(item: CalendarOverviewInterval) {
  const start = Date.parse(item.start || "");
  const end = Date.parse(item.end || "");
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] as const : null;
}

// Half-open intervals mean that a block ending exactly when another begins is not a conflict.
export function calendarOverviewConflictIds(items: CalendarOverviewInterval[]) {
  const conflicts = new Set<string>();
  for (let left = 0; left < items.length; left += 1) {
    const a = parsedInterval(items[left]);
    if (!a) continue;
    for (let right = left + 1; right < items.length; right += 1) {
      const b = parsedInterval(items[right]);
      if (!b || a[1] <= b[0] || b[1] <= a[0]) continue;
      conflicts.add(items[left].id);
      conflicts.add(items[right].id);
    }
  }
  return conflicts;
}

export function calendarOverviewIntersects(left: CalendarOverviewInterval, right: CalendarOverviewInterval) {
  const a = parsedInterval(left);
  const b = parsedInterval(right);
  return Boolean(a && b && a[0] < b[1] && b[0] < a[1]);
}
