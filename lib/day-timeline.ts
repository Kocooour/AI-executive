import { addCalendarDays } from "./calendar-event-display";
import { zonedDateTimeToIso } from "./local-dates";

// Layout of one civil day as a vertical time axis whose item heights follow their duration.
// Pure: no React, storage or network. Times are measured in elapsed minutes since the zone's local
// midnight (so a daylight-saving day is 23 or 25 hours long and still lines up with real time).

export const TIMELINE_PX_PER_MINUTE = 1;
export const TIMELINE_PX_PER_MINUTE_NARROW = 1;
export const TIMELINE_MIN_ITEM_PX = 22;
export const UNTIMED_MIN_PX = 44;
export const UNTIMED_MAX_PX = 240;
const DEFAULT_WORKDAY_START = "08:00";
const DEFAULT_WORKDAY_END = "18:00";

export interface TimelineSource {
  id: string;
  /** ISO instants. */
  start: string;
  end: string;
  /** Hidden events: drawn behind the others, in no lane. */
  underlay?: boolean;
}

export interface DayTimelineOptions {
  /** Civil day, YYYY-MM-DD. */
  day: string;
  timezone: string;
  /** "HH:MM" workday window the axis always covers. */
  workdayStart?: string;
  workdayEnd?: string;
  pxPerMinute?: number;
  minItemPx?: number;
  /** A compact axis: only the span of the items (at least `minSpanMinutes`), not the whole workday. */
  /** Most side-by-side lanes in an overlap cluster (default 4); the rest collapse into a "+N" group. */
  maxColumns?: number;
  fitToItems?: boolean;
  minSpanMinutes?: number;
}

export interface PlacedTimelineItem<T extends TimelineSource> {
  source: T;
  id: string;
  /** Minutes since local midnight, clipped to the day. */
  startMinute: number;
  endMinute: number;
  /** Minutes of the item that fall on this day. */
  durationMinutes: number;
  continuesFromPreviousDay: boolean;
  continuesIntoNextDay: boolean;
  /** Pixels from the axis top and the item's height (at least the minimum item height). */
  top: number;
  height: number;
  /** Side-by-side lane inside its overlap cluster, and how many lanes the cluster has. */
  column: number;
  columns: number;
  /** Drawn full width behind the lanes (hidden events); takes no lane. */
  underlay: boolean;
}

export interface OverflowGroup<T extends TimelineSource> {
  id: string;
  items: Array<PlacedTimelineItem<T>>;
  startMinute: number;
  endMinute: number;
  top: number;
  height: number;
  column: number;
  columns: number;
}

export interface TimelineHour {
  minute: number;
  top: number;
  /** "HH:MM" of that instant in the zone. */
  label: string;
}

export interface DayTimelineLayout<T extends TimelineSource> {
  /** Instant of the local midnight and of the next one, as epoch milliseconds. */
  dayStartMs: number;
  dayEndMs: number;
  axisStartMinute: number;
  axisEndMinute: number;
  /** Axis height in pixels. */
  height: number;
  hours: TimelineHour[];
  /** Ordered by start time (then longer first): the DOM order. */
  items: Array<PlacedTimelineItem<T>>;
  /** Items that did not fit the lane cap, collapsed per overlap cluster into a "+N" group. */
  overflow: Array<OverflowGroup<T>>;
  pxPerMinute: number;
}

const validTime = (value: string | undefined, fallback: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "") ? value as string : fallback;

function hourLabel(timestamp: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

/** The minute of an instant on the day's axis (can be negative or beyond the day for other days). */
export function minuteOnDay(instant: number | string, dayStartMs: number) {
  const value = typeof instant === "number" ? instant : Date.parse(instant);
  return (value - dayStartMs) / 60_000;
}

/** Height of a row without a time: proportional to the estimate, clamped; no estimate gets the minimum. */
export function untimedRowHeight(minutes: number | null | undefined, pxPerMinute = TIMELINE_PX_PER_MINUTE) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return UNTIMED_MIN_PX;
  return Math.round(Math.min(UNTIMED_MAX_PX, Math.max(UNTIMED_MIN_PX, minutes * pxPerMinute)));
}

export function layoutDayTimeline<T extends TimelineSource>(sources: T[], options: DayTimelineOptions): DayTimelineLayout<T> {
  const pxPerMinute = options.pxPerMinute && options.pxPerMinute > 0 ? options.pxPerMinute : TIMELINE_PX_PER_MINUTE;
  const minItemPx = options.minItemPx && options.minItemPx > 0 ? options.minItemPx : TIMELINE_MIN_ITEM_PX;
  const minItemMinutes = minItemPx / pxPerMinute;
  const dayStartMs = Date.parse(zonedDateTimeToIso(options.day, "00:00", options.timezone));
  const dayEndMs = Date.parse(zonedDateTimeToIso(addCalendarDays(options.day, 1), "00:00", options.timezone));
  const dayMinutes = Math.round((dayEndMs - dayStartMs) / 60_000);

  // Hour marks by real elapsed hours from local midnight: a skipped hour (spring) has no mark and a
  // repeated hour (autumn) has two, each at its own elapsed minute.
  const candidates: Array<{ minute: number; label: string }> = [];
  for (let timestamp = dayStartMs; timestamp <= dayEndMs; timestamp += 3_600_000) {
    candidates.push({ minute: Math.round((timestamp - dayStartMs) / 60_000), label: hourLabel(timestamp, options.timezone) });
  }
  if (candidates[candidates.length - 1]?.minute !== dayMinutes) candidates.push({ minute: dayMinutes, label: hourLabel(dayEndMs, options.timezone) });
  candidates.sort((a, b) => a.minute - b.minute);

  // Items clipped to the day, ordered by start (longer first), invalid ones dropped.
  const clipped = sources.flatMap((source) => {
    const start = Date.parse(source.start), end = Date.parse(source.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= dayStartMs || start >= dayEndMs) return [];
    const startMinute = (Math.max(start, dayStartMs) - dayStartMs) / 60_000;
    const endMinute = (Math.min(end, dayEndMs) - dayStartMs) / 60_000;
    return [{ source, startMinute, endMinute, continuesFromPreviousDay: start < dayStartMs, continuesIntoNextDay: end > dayEndMs }];
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.source.id.localeCompare(b.source.id));

  // The axis: the workday window, widened to whole hours around any item outside it.
  const workStart = Math.round((Date.parse(zonedDateTimeToIso(options.day, validTime(options.workdayStart, DEFAULT_WORKDAY_START), options.timezone)) - dayStartMs) / 60_000);
  const workEnd = Math.round((Date.parse(zonedDateTimeToIso(options.day, validTime(options.workdayEnd, DEFAULT_WORKDAY_END), options.timezone)) - dayStartMs) / 60_000);
  const workdayValid = workEnd > workStart;
  let wantStart = workdayValid ? workStart : 8 * 60;
  let wantEnd = workdayValid ? workEnd : 18 * 60;
  const fit = Boolean(options.fitToItems) && clipped.length > 0;
  if (fit) { wantStart = Infinity; wantEnd = -Infinity; }
  for (const item of clipped) {
    // An item's visible extent includes its minimum height, so a short last item still fits.
    wantStart = Math.min(wantStart, item.startMinute);
    wantEnd = Math.max(wantEnd, item.endMinute, item.startMinute + minItemMinutes);
  }
  if (fit) {
    const span = options.minSpanMinutes ?? 180;
    if (wantEnd - wantStart < span) { const extra = (span - (wantEnd - wantStart)) / 2; wantStart -= extra; wantEnd += extra; }
  }
  wantStart = Math.max(0, wantStart);
  wantEnd = Math.min(dayMinutes, wantEnd);
  const axisStartMinute = [...candidates].reverse().find((candidate) => candidate.minute <= wantStart)?.minute ?? 0;
  const axisEndMinute = candidates.find((candidate) => candidate.minute >= wantEnd)?.minute ?? dayMinutes;

  // Overlap clusters and side-by-side lanes. An item shorter than the minimum height occupies that much
  // room, so two short neighbours never draw over each other. Underlay items (hidden events) take no
  // lane: they are full width behind the others. A cluster has at most `maxColumns` lanes; items that
  // do not fit collapse into one "+N" group in the last lane.
  const maxColumns = Math.max(2, Math.floor(options.maxColumns ?? 4));
  // Each item's drawn interval: at least the minimum height, and moved up when that would run past the
  // end of the axis (a 23:59 item). Clusters and lanes use the drawn interval, so a moved item never
  // lands on top of the item before it.
  const drawnStart = (startMinute: number, endMinute: number) =>
    Math.max(axisStartMinute, Math.min(startMinute, axisEndMinute - Math.max(endMinute - startMinute, minItemMinutes)));
  type Clipped = (typeof clipped)[number] & { drawnStart: number };
  const visualEnd = (item: Clipped) => item.drawnStart + Math.max(item.endMinute - item.startMinute, minItemMinutes);
  // An item drawn taller than its length (the minimum height) near the end of the axis is moved up so
  // it stays inside the axis instead of covering what follows it.
  const axisPx = (axisEndMinute - axisStartMinute) * pxPerMinute;
  const inside = (top: number, height: number) => Math.max(0, Math.min(top, axisPx - height));
  const make = (item: Clipped, column: number, columns: number, underlay = false): PlacedTimelineItem<T> => ({
    source: item.source,
    id: item.source.id,
    startMinute: item.startMinute,
    endMinute: item.endMinute,
    durationMinutes: Math.round(item.endMinute - item.startMinute),
    continuesFromPreviousDay: item.continuesFromPreviousDay,
    continuesIntoNextDay: item.continuesIntoNextDay,
    top: inside((item.drawnStart - axisStartMinute) * pxPerMinute, Math.max(minItemPx, (item.endMinute - item.startMinute) * pxPerMinute)),
    height: Math.max(minItemPx, (item.endMinute - item.startMinute) * pxPerMinute),
    column, columns, underlay,
  });
  const pack = (members: Clipped[], limit: number) => {
    const laneEnds: number[] = [];
    const lanes = new Map<Clipped, number>();
    const overflow: Clipped[] = [];
    for (const item of members) {
      let lane = laneEnds.findIndex((end) => end <= item.drawnStart);
      if (lane === -1 && laneEnds.length < limit) lane = laneEnds.length;
      if (lane === -1) { overflow.push(item); continue; }
      laneEnds[lane] = visualEnd(item);
      lanes.set(item, lane);
    }
    return { lanes, overflow, count: laneEnds.length };
  };
  const placed: Array<PlacedTimelineItem<T>> = [];
  const overflowGroups: Array<OverflowGroup<T>> = [];
  const flush = (members: Clipped[]) => {
    if (members.length === 0) return;
    let limit = maxColumns;
    let result = pack(members, limit);
    if (result.overflow.length > 0) { limit = maxColumns - 1; result = pack(members, limit); }
    const columns = result.overflow.length > 0 ? limit + 1 : Math.max(1, result.count);
    for (const [item, lane] of result.lanes) placed.push(make(item, lane, columns));
    if (result.overflow.length > 0) {
      const start = Math.min(...result.overflow.map((item) => item.drawnStart));
      const end = Math.max(...result.overflow.map(visualEnd));
      overflowGroups.push({
        id: `overflow:${result.overflow[0].source.id}`,
        items: result.overflow.map((item) => make(item, limit, columns)),
        startMinute: start, endMinute: end,
        top: inside((start - axisStartMinute) * pxPerMinute, Math.max(minItemPx, (end - start) * pxPerMinute)),
        height: Math.max(minItemPx, (end - start) * pxPerMinute),
        column: limit, columns,
      });
    }
  };
  let members: Clipped[] = [];
  let clusterEnd = -Infinity;
  const drawn: Clipped[] = clipped.map((item) => ({ ...item, drawnStart: drawnStart(item.startMinute, item.endMinute) }))
    .sort((a, b) => a.drawnStart - b.drawnStart || b.endMinute - a.endMinute || a.source.id.localeCompare(b.source.id));
  for (const item of drawn) {
    if (item.source.underlay) { placed.push(make(item, 0, 1, true)); continue; }
    if (item.drawnStart >= clusterEnd) { flush(members); members = []; clusterEnd = -Infinity; }
    members.push(item);
    clusterEnd = Math.max(clusterEnd, visualEnd(item));
  }
  flush(members);
  placed.sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.id.localeCompare(b.id));

  return {
    dayStartMs,
    dayEndMs,
    axisStartMinute,
    axisEndMinute,
    height: (axisEndMinute - axisStartMinute) * pxPerMinute,
    pxPerMinute,
    hours: candidates.filter((candidate) => candidate.minute >= axisStartMinute && candidate.minute <= axisEndMinute)
      .map((candidate) => ({ minute: candidate.minute, label: candidate.label, top: (candidate.minute - axisStartMinute) * pxPerMinute })),
    items: placed,
    overflow: overflowGroups,
  };
}

/** Pixel offset of "now" on the axis, or null when it is outside the axis (or the day is not today). */
export function timelineNowOffset(layout: Pick<DayTimelineLayout<TimelineSource>, "dayStartMs" | "dayEndMs" | "axisStartMinute" | "axisEndMinute" | "pxPerMinute">, now: number) {
  if (now < layout.dayStartMs || now >= layout.dayEndMs) return null;
  const minute = (now - layout.dayStartMs) / 60_000;
  if (minute < layout.axisStartMinute || minute > layout.axisEndMinute) return null;
  return (minute - layout.axisStartMinute) * layout.pxPerMinute;
}
