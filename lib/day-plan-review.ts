import type { Entity } from "./db";

export interface PlanReview {
  planned: number;
  completed: number;
  open: number;
  moved: number;
  dismissed: number;
  nextWorkday: string;
  carryover: Array<{ id: string; title: string }>;
}

function localDate(at: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nextWorkingDate(date: string, workdays: number[]) {
  const next = new Date(`${date}T12:00:00Z`);
  for (let offset = 0; offset < 7; offset += 1) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (workdays.includes(next.getUTCDay())) return next.toISOString().slice(0, 10);
  }
  return "";
}

export function reviewPlan(tasks: Entity[], date: string, timezone: string, workdays: number[]): PlanReview {
  const nextWorkday = nextWorkingDate(date, workdays);
  let planned = 0, completed = 0, open = 0, moved = 0, dismissed = 0;
  const carryover: PlanReview["carryover"] = [];
  const carryoverIds = new Set<string>();
  for (const task of tasks) {
    if (task.type !== "task") continue;
    const history = Array.isArray(task.properties.planningHistory) ? task.properties.planningHistory : [];
    const latest = task.properties.planningFeedback;
    const decisions = [...history, latest].filter((entry): entry is { date: unknown; decision: unknown } =>
      Boolean(entry && typeof entry === "object" && (entry as { date?: unknown }).date === date));
    const decision = decisions.at(-1)?.decision || "";
    const start = Date.parse(String(task.properties.plannedStart || ""));
    const onPlan = decisions.some((entry) => entry.decision === "accepted") || Number.isFinite(start) && localDate(start, timezone) === date;
    if (onPlan) {
      planned += 1;
      if (task.status === "completed") completed += 1;
      else if (task.status === "open") {
        open += 1;
        if (!carryoverIds.has(task.id)) { carryover.push({ id: task.id, title: task.title }); carryoverIds.add(task.id); }
      }
    }
    if (decision === "tomorrow") { moved += 1; if (task.status === "open" && !carryoverIds.has(task.id)) { carryover.push({ id: task.id, title: task.title }); carryoverIds.add(task.id); } }
    if (decision === "dismissed") dismissed += 1;
  }
  return { planned, completed, open, moved, dismissed, nextWorkday, carryover: carryover.slice(0, 5) };
}
