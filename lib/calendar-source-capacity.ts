/**
 * Busy/free capacity for the target-only Calendar, derived solely from the
 * connected calendar feed. Legacy task conversions, old hide decisions and
 * DayPlan are deliberately not inputs: none can free a source-busy interval.
 * Legacy capacity stays in useLumiApp for off / partial configurations.
 */
export function calendarSourceCapacity(
  events: readonly { start: string; end: string; busy: boolean }[],
  dayStart: number,
  dayEnd: number,
): { freeHours: number; freeWindows: Array<[number, number]> } {
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || dayEnd <= dayStart)
    return { freeHours: 0, freeWindows: [] };

  const busyIntervals = events.filter((event) => event.busy)
    .map((event): [number, number] => [
      Math.max(dayStart, Date.parse(event.start)),
      Math.min(dayEnd, Date.parse(event.end)),
    ])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);

  const freeWindows: Array<[number, number]> = [];
  let cursor = dayStart;
  let blockedMs = 0;
  for (const [start, end] of busyIntervals) {
    if (start - cursor >= 30 * 60_000) freeWindows.push([cursor, start]);
    blockedMs += Math.max(0, end - Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (dayEnd - cursor >= 30 * 60_000) freeWindows.push([cursor, dayEnd]);

  return {
    freeHours: Math.max(0, (dayEnd - dayStart - blockedMs) / 3_600_000),
    freeWindows,
  };
}
