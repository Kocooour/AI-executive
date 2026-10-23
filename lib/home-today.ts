// The "Today" section of Home shows only tasks that are not already the subject of an attention item
// shown above it (no duplicates). Pure: counts come from the same set the list is cut from.
import type { Entity } from "./db";

export type AttentionSubject = { subjectId: string; workspaceId: string };

export function homeTodayList({ todayTasks, attentionItems, limit }: {
  todayTasks: Entity[];
  attentionItems: AttentionSubject[];
  limit: number;
}) {
  const subjects = new Set(attentionItems.map((item) => `${item.workspaceId}\u0000${item.subjectId}`));
  const rest = todayTasks.filter((task) => !subjects.has(`${task.workspaceId}\u0000${task.id}`));
  const shown = rest.slice(0, Math.max(0, limit));
  return {
    shown,
    // Today tasks that are not in attention, and how many of them the list leaves out.
    total: rest.length,
    more: rest.length - shown.length,
    // Today tasks that are listed in attention instead.
    inAttention: todayTasks.length - rest.length,
  };
}

// The one primary action on the right of an attention item. A task whose deadline or planned day is
// the reason gets its date chip (the same "When" popover as in the lists) when the task is in local
// data, still open and the workspace is writable; everything else (waiting follow-ups, projects, a
// task not in local data, the read-only aggregate) gets "Open".
export function attentionPrimaryAction(
  candidate: { subjectType: "task" | "project"; ruleId: string },
  subject: Pick<Entity, "type" | "status"> | undefined,
  writable: boolean,
): "defer" | "open" {
  if (candidate.subjectType !== "task" || candidate.ruleId === "waiting_follow_up") return "open";
  return writable && subject && subject.type === "task" && subject.status === "open" ? "defer" : "open";
}
