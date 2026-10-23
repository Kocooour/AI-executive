// The owner's decisions about calendar events, and the task made from an event. Pure and
// deterministic: no clock, React, storage or network access (`now` and `today` are inputs).
//
// Decisions live on the workspace entity under `properties.calendarDecisions`, a bounded map of
// opaque keys to "hidden" | "notTask". Keys never contain a title:
//   occ:<sourceId>:<occurrenceKey>   one occurrence   (occurrenceKey = "<uid>:<start ISO>")
//   series:<sourceId>:<uid>          every repeat of a recurring event
import type { Entity } from "./db";
import { suggestDeferral } from "./defer-suggestion";
import { zonedDateTimeToIso } from "./local-dates";
import { taskMinutes } from "./task-duration";
import { taskMatchesView } from "./task-views";

export type CalendarDecision = "hidden" | "notTask";
export type CalendarDecisions = Record<string, CalendarDecision>;

export interface DecisionEvent {
  id: string;
  sourceId: string;
  uid?: string;
  occurrenceKey?: string;
  title?: string;
  start: string;
  end: string;
  allDay: boolean;
  status?: string;
}

export const DECISIONS_PROPERTY = "calendarDecisions";
export const MAX_DECISIONS = 500;
export const KEEP_DECISION_DAYS = 30;
export const MIN_EVENT_TASK_MINUTES = 5;
// The task estimate is valid up to 480 minutes (lib/task-duration.ts).
export const MAX_EVENT_TASK_MINUTES = 480;

const DAY_MS = 86_400_000;
const isDecision = (value: unknown): value is CalendarDecision => value === "hidden" || value === "notTask";

export const occurrenceDecisionKey = (event: Pick<DecisionEvent, "sourceId" | "occurrenceKey" | "id">) =>
  `occ:${event.sourceId}:${event.occurrenceKey || event.id}`;
export const seriesDecisionKey = (event: Pick<DecisionEvent, "sourceId" | "uid">) =>
  event.uid ? `series:${event.sourceId}:${event.uid}` : "";

/** The decisions stored on a workspace entity; anything malformed is ignored. */
export function readDecisions(workspace: Pick<Entity, "properties"> | null | undefined): CalendarDecisions {
  const stored = workspace?.properties?.[DECISIONS_PROPERTY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const result: CalendarDecisions = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if ((key.startsWith("occ:") || key.startsWith("series:")) && isDecision(value)) result[key] = value;
  }
  return result;
}

// The start time an occurrence key ends with ("<uid>:2026-10-23T09:00:00.000Z"), or null.
function occurrenceStart(key: string) {
  const match = /(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/.exec(key);
  const time = match ? Date.parse(match[1]) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Drops occurrence decisions whose start is more than 30 days past and keeps at most `max`
 * entries (the oldest-written go first, occurrences before series).
 */
export function pruneDecisions(decisions: CalendarDecisions, now: number, max = MAX_DECISIONS): CalendarDecisions {
  const kept = Object.entries(decisions).filter(([key]) => {
    if (!key.startsWith("occ:")) return true;
    const start = occurrenceStart(key);
    return start === null || start >= now - KEEP_DECISION_DAYS * DAY_MS;
  });
  let excess = kept.length - max;
  if (excess > 0) {
    for (const group of [(key: string) => key.startsWith("occ:"), () => true]) {
      for (let index = 0; index < kept.length && excess > 0;) {
        if (group(kept[index][0])) { kept.splice(index, 1); excess -= 1; } else index += 1;
      }
    }
  }
  return Object.fromEntries(kept);
}

/** One decision set or cleared (`null`), then pruned. The input is not changed. */
export function withDecision(decisions: CalendarDecisions, key: string, value: CalendarDecision | null, now: number): CalendarDecisions {
  if (!key) return decisions;
  const next = { ...decisions };
  delete next[key]; // a changed decision moves to the end, so the oldest are the first to go
  if (value) next[key] = value;
  return pruneDecisions(next, now);
}

/** The decision that applies to an event: its own occurrence first, then its series. */
export function decisionFor(decisions: CalendarDecisions, event: DecisionEvent): { decision: CalendarDecision; key: string } | null {
  const own = occurrenceDecisionKey(event);
  if (decisions[own]) return { decision: decisions[own], key: own };
  const series = seriesDecisionKey(event);
  if (series && decisions[series]) return { decision: decisions[series], key: series };
  return null;
}

export const isHiddenEvent = (decisions: CalendarDecisions, event: DecisionEvent) => decisionFor(decisions, event)?.decision === "hidden";

/** Another cached event belongs to the same series (same source and uid). */
export const isRecurringEvent = (event: DecisionEvent, events: DecisionEvent[]) =>
  Boolean(event.uid) && events.some((other) => other.id !== event.id && other.sourceId === event.sourceId && other.uid === event.uid);

/** Ids of calendar events that tasks of a workspace point to (`properties.calendarEventId`). */
export function linkedEventTasks(entities: Entity[], workspaceId: string): Map<string, Entity> {
  const result = new Map<string, Entity>();
  for (const entity of entities) {
    if (entity.type !== "task" || entity.workspaceId !== workspaceId) continue;
    const id = entity.properties?.calendarEventId;
    if (typeof id !== "string" || !id) continue;
    // An open task is the one to show when an event has several.
    if (!result.has(id) || (entity.status === "open" && result.get(id)?.status !== "open")) result.set(id, entity);
  }
  return result;
}

/**
 * Whether Lumi should ask "Is this a task?": a timed event that has not ended, is not cancelled,
 * is not hidden or marked "not a task", and has no task yet.
 */
export function needsTaskQuestion(event: DecisionEvent, context: { decisions: CalendarDecisions; linked: Map<string, Entity>; now: number }) {
  if (event.allDay || event.status === "cancelled") return false;
  const end = Date.parse(event.end);
  if (!Number.isFinite(end) || end <= context.now) return false;
  if (decisionFor(context.decisions, event)) return false;
  return !context.linked.has(event.id);
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
/** The civil date (YYYY-MM-DD) of an instant in a time zone. */
export function localDay(instant: number, timezone: string) {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timezone, formatter);
  }
  return formatter.format(new Date(instant));
}

export interface EventTaskDraft {
  title: string;
  /** The event's local date in the calendar time zone. */
  when: string;
  properties: Record<string, unknown>;
}

/** The task made from an event: its title and day, its length as the estimate, and a link back. */
export function eventTaskDraft(event: DecisionEvent, timezone: string): EventTaskDraft | null {
  const start = Date.parse(event.start), end = Date.parse(event.end);
  if (!Number.isFinite(start)) return null;
  // An all-day event (VALUE=DATE) keeps its date in UTC; it has no duration worth an estimate.
  const when = event.allDay ? event.start.slice(0, 10) : localDay(start, timezone);
  const properties: Record<string, unknown> = {
    calendarEventId: event.id,
    calendarSourceId: event.sourceId,
    ...(event.occurrenceKey ? { calendarEventKey: event.occurrenceKey } : {}),
  };
  if (!event.allDay && Number.isFinite(end) && end > start) {
    const minutes = Math.max(MIN_EVENT_TASK_MINUTES, Math.min(MAX_EVENT_TASK_MINUTES, Math.round((end - start) / 60_000)));
    properties.estimatedMinutes = minutes;
  }
  return { title: (event.title || "").trim().slice(0, 200), when, properties };
}

/** Free workday minutes of a civil day: the workday window minus every busy event (hidden ones too). */
export function dayFreeMinutes(
  events: Array<Pick<DecisionEvent, "start" | "end"> & { busy: boolean }>,
  day: string, timezone: string, workdayStart: string, workdayEnd: string,
) {
  const from = Date.parse(zonedDateTimeToIso(day, workdayStart, timezone));
  const to = Date.parse(zonedDateTimeToIso(day, workdayEnd, timezone));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const merged = events.filter((event) => event.busy)
    .map((event) => [Math.max(from, Date.parse(event.start)), Math.min(to, Date.parse(event.end))] as [number, number])
    .filter((interval) => interval[1] > interval[0]).sort((a, b) => a[0] - b[0])
    .reduce<Array<[number, number]>>((result, interval) => {
      const last = result[result.length - 1];
      if (!last || interval[0] > last[1]) result.push(interval);
      else last[1] = Math.max(last[1], interval[1]);
      return result;
    }, []);
  return Math.max(0, Math.floor((to - from - merged.reduce((total, interval) => total + interval[1] - interval[0], 0)) / 60_000));
}

export interface ReprioritizeSuggestion {
  task: Entity;
  /** A YYYY-MM-DD day, or "someday". */
  target: string;
  reason: string;
  plannedMinutes: number;
  freeMinutes: number;
}

const priorityLevel: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };
const priorityOf = (task: Entity) => priorityLevel[String(task.properties?.priority || "none")] ?? 0;

/**
 * After a task was made from a calendar event: when the known estimates of the open tasks planned
 * for that day exceed the day's free time, the task Lumi proposes to move away. Tasks made from
 * calendar events are not counted (their time is already busy in the calendar) and never moved.
 * Candidates are tasks without a deadline on or before that day and of medium priority or lower,
 * the least important first (then the longest, to free the most). Null when the day fits, there is
 * no free-time data, or nothing can sensibly move.
 */
export function reprioritizeSuggestion(input: { tasks: Entity[]; workspaceId: string; day: string; today: string; freeMinutes: number | null }): ReprioritizeSuggestion | null {
  const { day, freeMinutes } = input;
  if (freeMinutes === null || !Number.isFinite(freeMinutes)) return null;
  const open = (Array.isArray(input.tasks) ? input.tasks : []).filter((task) =>
    task && task.type === "task" && task.status === "open" && task.workspaceId === input.workspaceId && task.properties && typeof task.properties === "object");
  const plannedFor = (task: Entity) => task.properties.when === day || (day === input.today && taskMatchesView(task, "Today", day));
  const planned = open.filter((task) => plannedFor(task) && !task.properties.calendarEventId);
  const plannedMinutes = planned.reduce((total, task) => total + (taskMinutes(task.properties.estimatedMinutes) ?? 0), 0);
  if (plannedMinutes <= freeMinutes) return null;
  const candidates = planned.filter((task) => {
    const deadline = typeof task.properties.deadline === "string" ? task.properties.deadline.slice(0, 10) : "";
    return priorityOf(task) < priorityLevel.high && !(deadline && deadline <= day);
  }).sort((a, b) => priorityOf(a) - priorityOf(b)
    || (taskMinutes(b.properties.estimatedMinutes) ?? 0) - (taskMinutes(a.properties.estimatedMinutes) ?? 0)
    || a.id.localeCompare(b.id));
  for (const task of candidates) {
    // The day itself is the reference, so "tomorrow" is the day after it.
    const suggestion = suggestDeferral({ task, openTasks: open, today: day, calendarOverloaded: true });
    if (!suggestion || suggestion.reason === "deferKeepDeadline" || suggestion.target === day) continue;
    return { task, target: suggestion.target, reason: suggestion.reason, plannedMinutes, freeMinutes };
  }
  return null;
}
