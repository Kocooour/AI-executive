// What the project page and the project list say about one project: progress, the next step and at most one thing that
// needs attention. Pure: no React, storage or network access. Membership is a `belongs_to_project` relation inside one
// workspace (a relation naming records of another workspace is ignored, as in lib/project-navigation.ts).
import type { Entity, Relation } from "./db";
import { byManualOrder } from "./task-views";

const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);

// Matches the create() authorization: a finished project must be reopened before new
// tasks or notes can be attached. Shared between the page actions and mutation guard.
export function projectAcceptsNewItems(project: Pick<Entity, "type" | "status">): boolean {
  return project.type === "project" && project.status === "active";
}

export type ProjectSummary = {
  // Tasks of the project: all, completed, open.
  total: number;
  done: number;
  open: number;
  // The first available open task in the project's order; null when there is none.
  next: Entity | null;
  // Open tasks whose deadline has passed.
  overdue: number;
  // The deadline of the project has passed and it is still active.
  projectOverdue: boolean;
  // The one label the list shows, by priority: "overdue" (tasks after their deadline), then "noNext" (no next step).
  attention: { kind: "overdue"; count: number } | { kind: "noNext" } | null;
  // The newest change of the project, one of its tasks or its notes.
  lastActivityAt: number;
  lastActivityFromLinked: boolean;
};

export function projectTasks(project: Entity, items: Entity[], relations: Relation[]) {
  const members = new Set<string>();
  for (const relation of relations) {
    if (relation.relationType === "belongs_to_project" && relation.targetEntityId === project.id && relation.workspaceId === project.workspaceId) {
      members.add(relation.sourceEntityId);
    }
  }
  const linked = items.filter((item) => members.has(item.id) && item.workspaceId === project.workspaceId);
  return { tasks: linked.filter((item) => item.type === "task"), notes: linked.filter((item) => item.type === "note") };
}

// The next step: an item still in Inbox has not been clarified, a waiting or someday task is not a step to take, and a
// task planned for a later day belongs in Upcoming (the same rules as taskMatchesView for the lists).
export function nextProjectStep(openTasks: Entity[], projectId: string, today: string): Entity | null {
  return [...openTasks]
    .filter((task) => task.properties.inbox !== true && task.properties.waiting !== true && task.properties.someday !== true &&
      !(typeof task.properties.when === "string" && task.properties.when > today))
    .sort(byManualOrder(`task:project:${projectId}`))[0] ?? null;
}

export function summarizeProject(project: Entity, items: Entity[], relations: Relation[], today: string): ProjectSummary {
  const { tasks, notes } = projectTasks(project, items, relations);
  const openTasks = tasks.filter((task) => task.status === "open");
  const next = nextProjectStep(openTasks, project.id, today);
  const overdue = openTasks.filter((task) => validDay(task.properties.deadline) && task.properties.deadline.slice(0, 10) < today).length;
  const deadline = project.properties.deadline;
  const active = project.status === "active";
  const latest = [...tasks, ...notes].reduce((time, item) => Math.max(time, Number.isFinite(item.updatedAt) ? item.updatedAt : 0), 0);
  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === "completed").length,
    open: openTasks.length,
    next,
    overdue,
    projectOverdue: active && validDay(deadline) && deadline.slice(0, 10) < today,
    // A completed project has nothing left to start, so it never asks for attention.
    attention: !active ? null : overdue > 0 ? { kind: "overdue", count: overdue } : next ? null : { kind: "noNext" },
    lastActivityAt: Math.max(latest, project.updatedAt || 0),
    lastActivityFromLinked: latest > (project.updatedAt || 0),
  };
}
