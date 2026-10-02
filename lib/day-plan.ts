import type { Entity } from "./db";
import { calendarAvailability } from "./calendar";
import { getNotificationPreferences } from "./notifications";
import { readSnapshot } from "./server-store";
import { learnPlanning, type LearnedPlanning } from "./day-plan-learning";

export interface DayPlanItem {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  reason: "overdue" | "today" | "deadline" | "priority";
  start?: string;
  end?: string;
  estimateSource?: LearnedPlanning["estimateSource"];
  estimateSamples?: number;
  preferredMinute?: number | null;
  timeSamples?: number;
  planningSource?: "albert-day-plan" | "manual" | "other";
}

export interface DayPlan {
  revision: number;
  workspaceId: string;
  date: string;
  timezone: string;
  calendar: "ready" | "missing" | "stale" | "non-workday";
  freeMinutes: number | null;
  requiredMinutes: number;
  overloaded: boolean;
  existingBlocks: DayPlanItem[];
  planBlocks: DayPlanItem[];
  unscheduled: DayPlanItem[];
}

function dateInZone(timezone: string, now: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function currentDayPlanDate(now = Date.now()) {
  return dateInZone(getNotificationPreferences().timezone, now);
}

function addDays(date: string, count: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function estimate(task: Entity, peers: Entity[], timezone: string) {
  return learnPlanning(task, peers, timezone);
}

function minuteInZone(at: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function preferredFit(windows: Array<[number, number]>, duration: number, preferredMinute: number | null, timezone: string) {
  const candidates: number[] = [];
  for (const [from, to] of windows) {
    for (let at = Math.ceil(from / 900_000) * 900_000; at + duration * 60_000 <= to; at += 900_000) candidates.push(at);
  }
  if (!candidates.length) return null;
  if (preferredMinute === null) return candidates[0];
  return candidates.sort((left, right) =>
    Math.abs(minuteInZone(left, timezone) - preferredMinute) - Math.abs(minuteInZone(right, timezone) - preferredMinute) || left - right)[0];
}

function interval(task: Entity): [number, number] | null {
  const start = Date.parse(String(task.properties.plannedStart || ""));
  const end = Date.parse(String(task.properties.plannedEnd || ""));
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

function subtract(windows: Array<[number, number]>, occupied: [number, number]) {
  return windows.flatMap(([start, end]): Array<[number, number]> => {
    if (occupied[1] <= start || occupied[0] >= end) return [[start, end]];
    const parts: Array<[number, number]> = [];
    if (occupied[0] > start) parts.push([start, occupied[0]]);
    if (occupied[1] < end) parts.push([occupied[1], end]);
    return parts;
  });
}

export function buildDayPlan(workspaceId: string, date: string, now = Date.now()): DayPlan {
  const snapshot = readSnapshot();
  if (workspaceId === "all" || !snapshot.entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId)) {
    throw new Error("Workspace not found");
  }
  const preferences = getNotificationPreferences();
  const timezone = preferences.timezone;
  const today = currentDayPlanDate(now);
  const workday = preferences.workdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const availability = calendarAvailability(workspaceId, date, timezone, preferences.workdayStart, preferences.workdayEnd);
  const calendar: DayPlan["calendar"] = !workday ? "non-workday" : !availability.configured ? "missing" : !availability.fresh ? "stale" : "ready";
  const projects = new Map(snapshot.relations.filter((relation) => relation.workspaceId === workspaceId && relation.relationType === "belongs_to_project")
    .map((relation) => [relation.sourceEntityId, relation.targetEntityId]));
  const allTasks = snapshot.entities.filter((entity) => entity.type === "task" && entity.workspaceId === workspaceId)
    .map((task): Entity => ({ ...task, properties: { ...task.properties, projectId: projects.get(task.id) || task.properties.projectId } }));
  const tasks = allTasks.filter((task) => task.status === "open");
  const existingBlocks: DayPlanItem[] = [];
  const occupied: Array<[number, number]> = [];
  for (const task of tasks) {
    const slot = interval(task);
    if (!slot || dateInZone(timezone, slot[0]) > date || dateInZone(timezone, slot[1] - 1) < date) continue;
    const learning = estimate(task, allTasks, timezone);
    existingBlocks.push({ taskId: task.id, title: task.title, ...learning, reason: "today",
      planningSource: task.properties.planningSource === "albert-day-plan" ? "albert-day-plan" : task.properties.planningSource === "manual" ? "manual" : "other",
      start: new Date(slot[0]).toISOString(), end: new Date(slot[1]).toISOString() });
    occupied.push(slot);
  }
  existingBlocks.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const ranked = tasks.flatMap((task) => {
    if (interval(task)) return [];
    const when = typeof task.properties.when === "string" ? task.properties.when.slice(0, 10) : "";
    const deadline = typeof task.properties.deadline === "string" ? task.properties.deadline.slice(0, 10) : "";
    const feedback = task.properties.planningFeedback as { date?: string; decision?: string } | undefined;
    if (feedback?.date === date && (feedback.decision === "dismissed" || feedback.decision === "tomorrow")) return [];
    const overdue = Boolean(when && when < date || deadline && deadline < date);
    const dueToday = when === date || deadline === date || task.properties.today === true && !when && date === today;
    const dueSoon = Boolean(deadline && deadline > date && deadline <= addDays(date, 2));
    const priority = String(task.properties.priority || "none");
    if (!overdue && !dueToday && !dueSoon && priority !== "high") return [];
    const reason: DayPlanItem["reason"] = overdue ? "overdue" : dueToday ? "today" : dueSoon ? "deadline" : "priority";
    const score = (overdue ? 100 : 0) + (dueToday ? 70 : 0) + (dueSoon ? 25 : 0) + ({ high: 30, medium: 20, low: 10 }[priority] || 0);
    return [{ task, score, reason, earliest: [when, deadline].filter(Boolean).sort()[0] || "" }];
  }).sort((a, b) => b.score - a.score || a.earliest.localeCompare(b.earliest) || a.task.createdAt - b.task.createdAt || a.task.id.localeCompare(b.task.id));
  const requiredMinutes = ranked.reduce((total, item) => total + estimate(item.task, allTasks, timezone).estimatedMinutes, 0);
  const unscheduled: DayPlanItem[] = [];
  const planBlocks: DayPlanItem[] = [];
  let windows = calendar === "ready"
    ? availability.windows.map((window): [number, number] => [Date.parse(window.start), Date.parse(window.end)])
    : [];
  if (date === today) windows = windows.map(([start, end]): [number, number] => [Math.max(start, Math.ceil((now + 15 * 60_000) / 900_000) * 900_000), end]).filter(([start, end]) => end > start);
  for (const slot of occupied) windows = subtract(windows, slot);
  const freeMinutes = calendar === "ready" ? Math.floor(windows.reduce((total, [start, end]) => total + end - start, 0) / 60_000) : null;
  for (const { task, reason } of ranked) {
    const item: DayPlanItem = { taskId: task.id, title: task.title, ...estimate(task, allTasks, timezone), reason };
    const start = calendar === "ready" ? preferredFit(windows, item.estimatedMinutes, item.preferredMinute ?? null, timezone) : null;
    if (start === null) { unscheduled.push(item); continue; }
    const end = start + item.estimatedMinutes * 60_000;
    planBlocks.push({ ...item, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    windows = subtract(windows, [start, end]);
  }
  return { revision: snapshot.revision, workspaceId, date, timezone, calendar, freeMinutes, requiredMinutes,
    overloaded: freeMinutes !== null ? requiredMinutes > freeMinutes || unscheduled.length > 0 : ranked.length > preferences.dailyTaskCapacity,
    existingBlocks, planBlocks, unscheduled };
}
