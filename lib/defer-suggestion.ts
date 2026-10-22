// Deferral targets and Lumi's single, explainable deferral suggestion for a task ("Kdy" popover).
// Pure and deterministic: no clock, React, storage or network access. `today` is always an input
// (a local YYYY-MM-DD day), so the same data gives the same suggestion.
import type { Entity } from "./db";
import { addLocalDays, ymd } from "./local-dates";
import { taskMatchesView } from "./task-views";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day (2026-02-30 is not one), or "".
const validDay = (value: string) => {
  if (!DAY.test(value)) return false;
  const [year, month, date] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, date));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date;
};
const dayOf = (value: unknown) => (typeof value === "string" && validDay(value.slice(0, 10)) ? value.slice(0, 10) : "");
// Noon avoids a daylight-saving shift moving the date.
const toDate = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12);
};
export const addDays = (day: string, days: number) => ymd(addLocalDays(toDate(day), days));

export type DeferTargets = { today: string; tomorrow: string; weekend: string; nextWeek: string };

// Weekend is the nearest Saturday (today on a Saturday or Sunday); next week is the Monday of the
// next week (seven days on from a Monday).
export function deferTargets(today: string): DeferTargets {
  const weekday = toDate(today).getDay(); // 0 = Sunday … 6 = Saturday
  return {
    today,
    tomorrow: addDays(today, 1),
    weekend: weekday === 6 || weekday === 0 ? today : addDays(today, 6 - weekday),
    nextWeek: addDays(today, (8 - weekday) % 7 || 7),
  };
}

export type DeferSuggestion = {
  target: string | "someday";
  reason: string;
  params: Record<string, string | number>;
};
export type DeferSuggestionInput = {
  task: Entity;
  // Open tasks of the task's workspace.
  openTasks: Entity[];
  today: string;
  calendarOverloaded?: boolean;
};

export const OVERLOADED_TODAY_TASKS = 6;
export const BUSY_DAY_TASKS = 4;
export const REPEATED_DEFERRALS = 3;
export const BUSY_WEEK_TASKS = 3;

// Postponements only: to Someday, to a later day, or a dated task given no date. Pulling a task
// earlier is not a deferral.
export const deferralCount = (task: Entity) => {
  const history = task?.properties?.deferHistory;
  return (Array.isArray(history) ? history : []).filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const { from, to } = entry as { from?: unknown; to?: unknown };
    const validTo = to === "someday" || to === null || dayOf(to) === to;
    if (!validTo) return false;
    if (to === "someday") return from !== "someday";
    if (typeof from === "string" && dayOf(from) === from) return to === null || (typeof to === "string" && to > from);
    return false;
  }).length;
};
// Records without a properties object are read as having none; null and non-record entries are dropped.
const withProperties = (entity: Entity): Entity =>
  entity.properties && typeof entity.properties === "object" ? entity : { ...entity, properties: {} };

export function suggestDeferral({ task: given, openTasks, today, calendarOverloaded = false }: DeferSuggestionInput): DeferSuggestion | null {
  if (!given || given.type !== "task" || given.status !== "open") return null;
  const task = withProperties(given);
  const { tomorrow, nextWeek } = deferTargets(today);
  const properties = task.properties;
  const deadline = dayOf(properties.deadline);
  const open = (Array.isArray(openTasks) ? openTasks : [])
    .filter((candidate) => candidate && typeof candidate === "object" && candidate.type === "task" && candidate.status === "open")
    .map(withProperties);

  // 1. A close or passed deadline: never defer, keep it today.
  if (deadline && deadline <= tomorrow) {
    return { target: today, reason: "deferKeepDeadline", params: { date: deadline } };
  }

  // A date after the deadline is never suggested: the latest day that is still before it, or keep today.
  const bounded = (target: string): string | null => {
    if (!deadline || target <= deadline) return target;
    return deadline > today ? deadline : null;
  };
  const keepToday = (): DeferSuggestion => ({ target: today, reason: "deferKeepDeadline", params: { date: deadline } });

  // 2. Waiting for someone with a follow-up day still ahead.
  const followUp = dayOf(properties.followUpDate);
  if (properties.waiting === true && followUp > today && (!deadline || followUp <= deadline)) {
    return {
      target: followUp,
      reason: "deferWaitingFollowUp",
      params: { who: typeof properties.waitingFor === "string" ? properties.waitingFor : "", date: followUp },
    };
  }

  // 3. Postponed again and again: out of the way. A task with a deadline is never sent to Someday.
  const count = deferralCount(task);
  if (count >= REPEATED_DEFERRALS && !deadline) return { target: "someday", reason: "deferRepeated", params: { n: count } };

  // 4. Today is overloaded (a calendar that says so, or more than six tasks): the nearest quieter day.
  if (taskMatchesView(task, "Today", today)) {
    const todayCount = open.filter((candidate) => taskMatchesView(candidate, "Today", today)).length;
    if (calendarOverloaded || todayCount > OVERLOADED_TODAY_TASKS) {
      for (let offset = 1; offset <= 13; offset += 1) {
        const day = addDays(today, offset);
        if (deadline && day >= deadline) break;
        const dayCount = open.filter((candidate) => candidate.id !== task.id && candidate.properties.when === day).length;
        if (dayCount < BUSY_DAY_TASKS) {
          return { target: day, reason: "deferOverloaded", params: { todayCount, date: day, dayCount } };
        }
      }
    }
  }

  // 5. No deadline, low priority, and a week of other things that matter more: next Monday.
  const priority = String(properties.priority || "none");
  if (!deadline && (priority === "low" || priority === "none")) {
    const sunday = addDays(today, (7 - toDate(today).getDay()) % 7);
    const busy = open.filter((candidate) => {
      if (candidate.id === task.id) return false;
      const other = dayOf(candidate.properties.deadline);
      if (other && other >= today && other <= sunday) return true;
      return candidate.properties.priority === "high" && taskMatchesView(candidate, "Today", today);
    }).length;
    if (busy >= BUSY_WEEK_TASKS) {
      const target = bounded(nextWeek);
      if (target) return { target, reason: "deferBusyWeek", params: { n: busy } };
    }
  }

  // 6. Otherwise the next day.
  const target = bounded(tomorrow);
  return target ? { target, reason: "deferDefault", params: {} } : keepToday();
}
