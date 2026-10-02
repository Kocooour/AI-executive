import type { Entity } from "./db";
import { calendarAvailability } from "./calendar";
import { getNotificationPreferences } from "./notifications";
import { readSnapshot } from "./server-store";

export interface DayPlanItem {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  reason: "overdue" | "today" | "deadline" | "priority";
  start?: string;
  end?: string;
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

function estimate(task: Entity) {
  const value = Number(task.properties.estimatedMinutes);
  return Number.isFinite(value) && value >= 10 && value <= 480 ? Math.ceil(value / 5) * 5 : 60;
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
  const tasks = snapshot.entities.filter((entity) => entity.type === "task" && entity.status === "open" && entity.workspaceId === workspaceId);
  const existingBlocks: DayPlanItem[] = [];
  const occupied: Array<[number, number]> = [];
  for (const task of tasks) {
    const slot = interval(task);
    if (!slot || dateInZone(timezone, slot[0]) > date || dateInZone(timezone, slot[1] - 1) < date) continue;
    existingBlocks.push({ taskId: task.id, title: task.title, estimatedMinutes: estimate(task), reason: "today", start: new Date(slot[0]).toISOString(), end: new Date(slot[1]).toISOString() });
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
  const requiredMinutes = ranked.reduce((total, item) => total + estimate(item.task), 0);
  const unscheduled: DayPlanItem[] = [];
  const planBlocks: DayPlanItem[] = [];
  let windows = calendar === "ready"
    ? availability.windows.map((window): [number, number] => [Date.parse(window.start), Date.parse(window.end)])
    : [];
  if (date === today) windows = windows.map(([start, end]): [number, number] => [Math.max(start, Math.ceil((now + 15 * 60_000) / 900_000) * 900_000), end]).filter(([start, end]) => end > start);
  for (const slot of occupied) windows = subtract(windows, slot);
  const freeMinutes = calendar === "ready" ? Math.floor(windows.reduce((total, [start, end]) => total + end - start, 0) / 60_000) : null;
  for (const { task, reason } of ranked) {
    const item: DayPlanItem = { taskId: task.id, title: task.title, estimatedMinutes: estimate(task), reason };
    const fit = calendar === "ready" ? windows.find(([start, end]) => end - Math.ceil(start / 900_000) * 900_000 >= item.estimatedMinutes * 60_000) : undefined;
    if (!fit) { unscheduled.push(item); continue; }
    const start = Math.ceil(fit[0] / 900_000) * 900_000;
    const end = start + item.estimatedMinutes * 60_000;
    planBlocks.push({ ...item, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    windows = subtract(windows, [start, end]);
  }
  return { revision: snapshot.revision, workspaceId, date, timezone, calendar, freeMinutes, requiredMinutes,
    overloaded: freeMinutes !== null ? requiredMinutes > freeMinutes || unscheduled.length > 0 : ranked.length > preferences.dailyTaskCapacity,
    existingBlocks, planBlocks, unscheduled };
}
