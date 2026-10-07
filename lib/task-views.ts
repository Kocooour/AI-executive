// Task ordering, view membership and Quick Capture parsing shared by the client views.
// Pure: no React, storage or network access. `now` parameters default to the current
// time and exist so the behavior is testable at a fixed instant.
import type { Entity } from "./db";
import { addLocalDays, ymd } from "./local-dates";

export const manualOrder = (entity: Entity, scope = `${entity.type}:all`) => {
  const stored = entity.properties.manualOrders;
  const workspaceScope = `${entity.workspaceId}:${scope}`;
  const value = Number(
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)[workspaceScope] ??
        (stored as Record<string, unknown>)[scope]
      : entity.properties.manualOrder,
  );
  return Number.isFinite(value) ? value : entity.createdAt;
};
export const byManualOrder = (scope?: string) => (a: Entity, b: Entity) =>
  manualOrder(a, scope) - manualOrder(b, scope) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
export const taskDueTone = (entity: Entity, todayValue: string, now = new Date()) => {
  if (entity.type !== "task" || entity.status !== "open") return "";
  const dueDates = [entity.properties.when, entity.properties.deadline]
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (dueDates.some((due) => due < todayValue)) return "dueOverdue";
  const tomorrowValue = ymd(addLocalDays(now, 1));
  if (dueDates.some((due) => due >= todayValue && due <= tomorrowValue)) return "dueSoon";
  return "";
};
export const taskMatchesView = (task: Entity, targetView: string, todayValue: string) => {
  if (targetView === "Completed") return task.status === "completed";
  if (task.status !== "open") return false;
  const properties = task.properties;
  if (targetView === "Inbox") return properties.inbox === true;
  if (targetView === "Today") {
    return properties.today === true || properties.when === todayValue ||
      (typeof properties.when === "string" && properties.when < todayValue);
  }
  if (targetView === "Overdue") {
    return typeof properties.when === "string" && properties.when < todayValue;
  }
  if (targetView === "Upcoming") {
    return typeof properties.when === "string" && properties.when > todayValue;
  }
  if (targetView === "Anytime") {
    return !properties.when && !properties.someday && properties.inbox !== true;
  }
  if (targetView === "Someday") return properties.someday === true;
  return true;
};
export function parseCaptureText(raw: string, today: string, now = new Date()) {
  let title = raw.trim(),
    when = "",
    priority = "none";
  if (/(^|\s)zítra(?=\s|$)/i.test(title)) {
    when = ymd(addLocalDays(now, 1));
    title = title.replace(/(^|\s)zítra(?=\s|$)/i, " ");
  } else if (/(^|\s)dnes(?=\s|$)/i.test(title)) {
    when = today;
    title = title.replace(/(^|\s)dnes(?=\s|$)/i, " ");
  }
  const m = title.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?\s*$/);
  if (m) {
    const year = m[3] ? Number(m[3]) : now.getFullYear();
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (d.getFullYear() === year && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
      if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(year + 1);
      when = ymd(d);
      title = title.slice(0, m.index).trim();
    }
  }
  if (/(^|\s)(!|#high)(?=\s|$)/i.test(title)) priority = "high";
  else if (/(^|\s)#medium(?=\s|$)/i.test(title)) priority = "medium";
  else if (/(^|\s)#low(?=\s|$)/i.test(title)) priority = "low";
  title = title.replace(/(^|\s)(!|#high|#medium|#low)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
  return { title, when, priority };
}
