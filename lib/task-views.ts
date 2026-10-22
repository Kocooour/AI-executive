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
  // Only a deadline is alarming; a planned day that passed or arrives today has no tone.
  const deadline = entity.properties.deadline;
  if (typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return "";
  if (deadline < todayValue) return "dueOverdue";
  return deadline <= ymd(addLocalDays(now, 1)) ? "dueSoon" : "";
};
export const taskMatchesView = (task: Entity, targetView: string, todayValue: string) => {
  if (targetView === "Completed") return task.status === "completed";
  if (task.status !== "open") return false;
  const properties = task.properties;
  // An emptied date field is stored as "", which must not compare as "earlier than today".
  const when = typeof properties.when === "string" ? properties.when : "";
  if (targetView === "Inbox") return properties.inbox === true;
  if (targetView === "Today") {
    return properties.today === true || (when !== "" && when <= todayValue);
  }
  if (targetView === "Overdue") {
    // Overdue means a passed deadline, not a planned day that has passed.
    const deadline = typeof properties.deadline === "string" ? properties.deadline.slice(0, 10) : "";
    return deadline !== "" && deadline < todayValue;
  }
  if (targetView === "Upcoming") {
    return when > todayValue;
  }
  if (targetView === "Anytime") {
    // A task flagged for today belongs to Today only, including older tasks that carry the flag without a date.
    return !properties.when && !properties.someday && properties.inbox !== true && properties.today !== true;
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
  // Priority marks may follow the date ("… 25. 10. !"), so they are taken out first.
  if (/(^|\s)(!|#high)(?=\s|$)/i.test(title)) priority = "high";
  else if (/(^|\s)#medium(?=\s|$)/i.test(title)) priority = "medium";
  else if (/(^|\s)#low(?=\s|$)/i.test(title)) priority = "low";
  title = title.replace(/(^|\s)(!|#high|#medium|#low)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
  // A date at the end of the text: "25.10", "25.10.", "25.10.2026", and the Czech way of writing
  // it with spaces, "25. 10." or "25. 10. 2026". With spaces the dot after the month is required,
  // so that "kapitola 2. 5" stays a title.
  // A third number right before it ("kroky 1. 2. 3.") means a list, not a date.
  const spaced = title.match(/(?:^|\s)(\d{1,2})\. (\d{1,2})\.(?: ?(\d{4})\.?)?$/);
  const m = title.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?$/)
    || (spaced && !/\d\.\s*$/.test(title.slice(0, spaced.index)) ? spaced : null);
  if (m) {
    const year = m[3] ? Number(m[3]) : now.getFullYear();
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (d.getFullYear() === year && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
      if (!m[3] && d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(year + 1);
      when = ymd(d);
      title = title.slice(0, m.index).trim();
    }
  }
  // Text that consists only of a date or a mark has no title left. A task needs one (the server
  // refuses a record without it), so such text is kept as the title, as typed.
  if (!title) return { title: raw.trim().replace(/\s+/g, " "), when: "", priority: "none" };
  return { title, when, priority };
}

// Where a newly created task lands. A date typed into the title wins; otherwise the task follows the
// view it was added from. A task added to Today gets today's date as well as the flag, the same as
// dragging it there or choosing Today in the detail panel, so it becomes overdue tomorrow like any dated task.
// A task typed into the row of Someday is marked for someday, and one typed into the row of
// Upcoming gets tomorrow's date: it would otherwise land in Anytime and vanish from the list it
// was typed into. This applies only when the caller leaves the placement to the view; the capture
// dialog states its own placement and is not affected.
export function newTaskPlacement(
  parsedWhen: string,
  properties: Record<string, unknown>,
  options: { view: string; today: string; hasProject: boolean },
) {
  if (parsedWhen) return { inbox: false, today: parsedWhen === options.today, when: parsedWhen };
  const flaggedToday = Boolean(properties.today ?? (options.view === "Today"));
  const hasDate = typeof properties.when === "string" && properties.when !== "";
  const leftToView = properties.inbox === undefined && properties.today === undefined && properties.someday === undefined;
  const unplaced = leftToView && !flaggedToday && !hasDate;
  const [year, month, day] = options.today.split("-").map(Number);
  return {
    inbox: Boolean(properties.inbox ?? (!options.hasProject && options.view === "Inbox")),
    today: flaggedToday,
    ...(flaggedToday && !hasDate ? { when: options.today } : {}),
    ...(unplaced && options.view === "Someday" ? { someday: true } : {}),
    ...(unplaced && options.view === "Upcoming" ? { when: ymd(new Date(year, month - 1, day + 1)) } : {}),
  };
}
