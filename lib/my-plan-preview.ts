/** UI-04c: visual-only legacy workspace preview; never an actor authorization selector.
 * The R3-slice target My Plan is the only source of server-authorized membership.
 */
import type { Entity, Relation } from "./db";
import { byManualOrder } from "./task-views";
import { projectAreaPreviewTone, type ProjectAreaTone } from "./project-list-preview";

export interface PreviewAreaGroup {
  key: string;
  areaId: string | null;
  accessibleLabel: string;
  tone: ProjectAreaTone;
  tasks: Entity[];
}
export interface PreviewDaySection {
  day: "today" | "tomorrow";
  date: string;
  groups: PreviewAreaGroup[];
  count: number;
}

const isoDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Advance a civil day without depending on parsing UTC midnight in the viewer timezone. */
export function tomorrowOf(day: string): string {
  if (!isoDay(day)) throw new Error("Invalid preview day");
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return next.toISOString().slice(0, 10);
}

export function previewDayForTask(task: Entity, today: string, tomorrow = tomorrowOf(today)): "today" | "tomorrow" | null {
  if (task.type !== "task" || task.status !== "open") return null;
  const when = task.properties.when;
  const deadline = task.properties.deadline;
  // Passed or today's hard deadline wins even when the task is planned later.
  if (isoDay(deadline) && deadline <= today) return "today";
  // Legacy Today membership remains visible even if the 'when' field is absent.
  if (task.properties.today === true || (isoDay(when) && when <= today)) return "today";
  if ((isoDay(when) && when === tomorrow) || (isoDay(deadline) && deadline === tomorrow)) return "tomorrow";
  return null;
}

/** Resolve area only through same-workspace relation graph. Project membership
 * takes precedence over a stale task area; conflicting memberships fail closed.
 */
export function previewAreaForTask(
  task: Entity, entities: Entity[], relations: Relation[],
): Entity | null {
  const index = new Map(entities.map((item) => [item.id, item]));
  const parents = new Set(relations.filter((r) =>
    r.relationType === "belongs_to_project" && r.workspaceId === task.workspaceId &&
    r.sourceEntityId === task.id && index.get(r.targetEntityId)?.type === "project" &&
    index.get(r.targetEntityId)?.workspaceId === task.workspaceId
  ).map((r) => r.targetEntityId));
  if (parents.size > 1) return null;
  const source = parents.size === 1 ? index.get([...parents][0])! : task;
  const areaIds = new Set(relations.filter((r) =>
    r.relationType === "belongs_to_area" && r.workspaceId === task.workspaceId &&
    r.sourceEntityId === source.id && index.get(r.targetEntityId)?.type === "area" &&
    index.get(r.targetEntityId)?.workspaceId === task.workspaceId &&
    index.get(r.targetEntityId)?.status === "active"
  ).map((r) => r.targetEntityId));
  if (areaIds.size !== 1) return null;
  return index.get([...areaIds][0]) ?? null;
}

/** Never fall through to data outside the currently selected legacy workspace.
 * For 'all', return no tasks: combined actor-authorized My Plan is not wired yet.
 * Calendar-linked Today tasks can be excluded because the Timeline already shows them.
 */
export function buildMyPlanPreview({
  entities, relations, workspaceId, today, excludeTimelineIds = new Set<string>(),
  priorityFilter = "all", sortBy = "manual", language = "cs",
}: {
  entities: Entity[]; relations: Relation[]; workspaceId: string; today: string;
  excludeTimelineIds?: ReadonlySet<string>;
  priorityFilter?: string; sortBy?: "manual" | "date" | "priority" | "created"; language?: string;
}): PreviewDaySection[] {
  const tomorrow = tomorrowOf(today);
  const days = ["today", "tomorrow"] as const;
  const selected = workspaceId === "all" ? [] : entities.filter((item) =>
    item.type === "task" && item.workspaceId === workspaceId &&
    (priorityFilter === "all" || String(item.properties.priority || "none") === priorityFilter)
  );
  return days.map((day) => {
    const date = day === "today" ? today : tomorrow;
    const manual = byManualOrder(day === "today" ? "task:Today" : "task:Upcoming");
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
    const order = (a: Entity, b: Entity) => {
      if (sortBy === "created") return b.createdAt - a.createdAt || manual(a, b);
      if (sortBy === "priority") {
        const diff = (rank[String(a.properties.priority || "none")] ?? 3) -
          (rank[String(b.properties.priority || "none")] ?? 3);
        return diff || manual(a, b);
      }
      if (sortBy === "date") {
        const when = (item: Entity) => {
          const deadline = item.properties.deadline;
          const planned = item.properties.when;
          return isoDay(deadline) ? deadline : isoDay(planned) ? planned : "9999-12-31";
        };
        return when(a).localeCompare(when(b)) || manual(a, b);
      }
      return manual(a, b);
    };
    const tasks = selected.filter((item) =>
      previewDayForTask(item, today, tomorrow) === day && !(day === "today" && excludeTimelineIds.has(item.id))
    ).sort(order);
    const groups = new Map<string, PreviewAreaGroup>();
    for (const task of tasks) {
      const area = previewAreaForTask(task, entities, relations);
      const key = area ? `${task.workspaceId}:${area.id}` : `${task.workspaceId}:unassigned`;
      let group = groups.get(key);
      if (!group) {
        group = { key, areaId: area?.id ?? null,
          accessibleLabel: area?.title || (language === "cs" ? "Nezařazeno" : "Unassigned"),
          tone: projectAreaPreviewTone(area),
          tasks: [] };
        groups.set(key, group);
      }
      group.tasks.push(task);
    }
    return { day, date, groups: [...groups.values()], count: tasks.length };
  });
}


/** A drag/keyboard move in UI-04c may reorder only tasks that the user can
 * currently see in the *same* day and inherited Area block. Other lists and
 * hidden/filtered tasks must never become insertion neighbours.
 *
 * Returning null means the move is forbidden (including a cross-day,
 * cross-Area or stale target); callers must not fall back to legacy peers.
 */
export function previewReorderPeers(
  sections: readonly PreviewDaySection[], sourceId: string, scope: string, targetId?: string,
  sortBy: "manual" | "date" | "priority" | "created" = "manual",
): Entity[] | null {
  // Manual rank interpolation is valid only against manually ordered peers.
  // Otherwise the moved row can jump to an unrelated position after the UI
  // switches sorting modes; fail closed even if a stale drag reaches this helper.
  if (sortBy !== "manual") return null;
  const day = scope === "task:Today" ? "today" : scope === "task:Upcoming" ? "tomorrow" : null;
  if (!day) return null;
  const section = sections.find((candidate) => candidate.day === day);
  if (!section) return null;
  for (const group of section.groups) {
    if (!group.tasks.some((task) => task.id === sourceId)) continue;
    if (targetId !== undefined && !group.tasks.some((task) => task.id === targetId)) return null;
    return [...group.tasks];
  }
  return null;
}
