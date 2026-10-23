import { addCalendarDays } from "./calendar-event-display";
import { zonedDateTimeToIso } from "./local-dates";

// Layout of one civil day as a vertical time axis whose item heights follow their duration.
// Pure: no React, storage or network. Times are measured in elapsed minutes since the zone's local
// midnight (so a daylight-saving day is 23 or 25 hours long and still lines up with real time).

export const TIMELINE_PX_PER_MINUTE = 1;
export const TIMELINE_PX_PER_MINUTE_NARROW = 0.8;
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

  // Whole local hours of the day as axis candidates, by elapsed minute (a skipped hour has none).
  const candidates: Array<{ minute: number; label: string }> = [];
  for (let hour = 0; hour <= 24; hour += 1) {
    const timestamp = hour === 24 ? dayEndMs : Date.parse(zonedDateTimeToIso(options.day, `${String(hour).padStart(2, "0")}:00`, options.timezone));
    const minute = Math.round((timestamp - dayStartMs) / 60_000);
    if (minute < 0 || minute > dayMinutes || candidates.some((candidate) => candidate.minute === minute)) continue;
    candidates.push({ minute, label: hourLabel(timestamp, options.timezone) });
  }
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
  // room, so two short neighbours never draw over each other.
  const placed: Array<PlacedTimelineItem<T>> = [];
  let cluster: Array<PlacedTimelineItem<T>> = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const closeCluster = () => { for (const item of cluster) item.columns = Math.max(1, laneEnds.length); cluster = []; laneEnds = []; };
  for (const item of clipped) {
    const visualEnd = Math.max(item.endMinute, item.startMinute + minItemMinutes);
    if (item.startMinute >= clusterEnd) { closeCluster(); clusterEnd = -Infinity; }
    let lane = laneEnds.findIndex((end) => end <= item.startMinute);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(visualEnd); } else laneEnds[lane] = visualEnd;
    clusterEnd = Math.max(clusterEnd, visualEnd);
    const entry: PlacedTimelineItem<T> = {
      source: item.source,
      id: item.source.id,
      startMinute: item.startMinute,
      endMinute: item.endMinute,
      durationMinutes: Math.round(item.endMinute - item.startMinute),
      continuesFromPreviousDay: item.continuesFromPreviousDay,
      continuesIntoNextDay: item.continuesIntoNextDay,
      top: (item.startMinute - axisStartMinute) * pxPerMinute,
      height: Math.max(minItemPx, (item.endMinute - item.startMinute) * pxPerMinute),
      column: lane,
      columns: 1,
    };
    cluster.push(entry);
    placed.push(entry);
  }
  closeCluster();

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
  };
}

/** Pixel offset of "now" on the axis, or null when it is outside the axis (or the day is not today). */
export function timelineNowOffset(layout: Pick<DayTimelineLayout<TimelineSource>, "dayStartMs" | "dayEndMs" | "axisStartMinute" | "axisEndMinute" | "pxPerMinute">, now: number) {
  if (now < layout.dayStartMs || now >= layout.dayEndMs) return null;
  const minute = (now - layout.dayStartMs) / 60_000;
  if (minute < layout.axisStartMinute || minute > layout.axisEndMinute) return null;
  return (minute - layout.axisStartMinute) * layout.pxPerMinute;
}
