// Project lists of the navigation: the active projects under the sidebar, the attention dot of
// Projects and the area groups of the Projects view. Pure: no React, storage or network access.
import type { Entity, Relation } from "./db";
import { byManualOrder } from "./task-views";

export const sidebarProjectLimit = 7;

// Active projects of one workspace in their manual order. The aggregate ("all") has no list:
// projects of several workspaces under one heading would be confusing.
export function activeSidebarProjects(projects: Entity[], workspaceId: string, limit = sidebarProjectLimit): Entity[] {
  if (workspaceId === "all") return [];
  return projects
    .filter((project) => project.type === "project" && project.status === "active" && project.workspaceId === workspaceId)
    .sort(byManualOrder("project:all"))
    .slice(0, limit);
}

// Membership is a relation inside one workspace; a relation naming endpoints of different
// workspaces (or another workspace than its own) is ignored, as in openTaskCountsByProject.
function openTasksByProject(items: Entity[], projects: Entity[], relations: Relation[]) {
  const projectWorkspace = new Map(projects.map((project) => [project.id, project.workspaceId]));
  const openTasks = new Map(items.filter((item) => item.type === "task" && item.status === "open").map((task) => [task.id, task]));
  const byProject = new Map<string, Entity[]>();
  for (const relation of relations) {
    if (relation.relationType !== "belongs_to_project") continue;
    const task = openTasks.get(relation.sourceEntityId);
    if (!task || task.workspaceId !== projectWorkspace.get(relation.targetEntityId) || relation.workspaceId !== task.workspaceId) continue;
    const rows = byProject.get(relation.targetEntityId);
    if (rows) rows.push(task); else byProject.set(relation.targetEntityId, [task]);
  }
  return byProject;
}

// The dot next to Projects: some active project has an open task whose deadline has passed,
// or has no open task at all (no next step). `todayValue` is a local YYYY-MM-DD day.
export function projectsNeedAttention(items: Entity[], projects: Entity[], relations: Relation[], todayValue: string): boolean {
  const active = projects.filter((project) => project.type === "project" && project.status === "active");
  if (active.length === 0) return false;
  const tasks = openTasksByProject(items, active, relations);
  return active.some((project) => {
    const open = tasks.get(project.id) || [];
    if (open.length === 0) return true;
    return open.some((task) => {
      const deadline = task.properties.deadline;
      return typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}/.test(deadline) && deadline.slice(0, 10) < todayValue;
    });
  });
}

export type ProjectGroup = { key: string; area: Entity | null; projects: Entity[] };

// Projects under the heading of their area (areas and projects in manual order), then the
// projects without an area. A project belongs to the first of its areas in that order; a
// relation to an area of another workspace or one that is not listed does not count.
export function groupProjectsByArea(projects: Entity[], areas: Entity[], relations: Relation[]): ProjectGroup[] {
  const orderedAreas = areas.filter((area) => area.type === "area").sort(byManualOrder("area:all"));
  const areaRank = new Map(orderedAreas.map((area, index) => [area.id, index]));
  const areaById = new Map(orderedAreas.map((area) => [area.id, area]));
  const areaOf = new Map<string, string>();
  for (const relation of relations) {
    if (relation.relationType !== "belongs_to_area") continue;
    const area = areaById.get(relation.targetEntityId);
    if (!area || relation.workspaceId !== area.workspaceId) continue;
    const current = areaOf.get(relation.sourceEntityId);
    if (current === undefined || (areaRank.get(area.id) as number) < (areaRank.get(current) as number)) areaOf.set(relation.sourceEntityId, area.id);
  }
  const grouped = new Map<string, Entity[]>();
  const loose: Entity[] = [];
  for (const project of [...projects].filter((item) => item.type === "project").sort(byManualOrder("project:all"))) {
    const areaId = areaOf.get(project.id);
    const area = areaId ? areaById.get(areaId) : undefined;
    if (!area || area.workspaceId !== project.workspaceId) { loose.push(project); continue; }
    const rows = grouped.get(area.id);
    if (rows) rows.push(project); else grouped.set(area.id, [project]);
  }
  const groups: ProjectGroup[] = orderedAreas.filter((area) => grouped.has(area.id)).map((area) => ({ key: area.id, area, projects: grouped.get(area.id) as Entity[] }));
  if (loose.length > 0) groups.push({ key: "none", area: null, projects: loose });
  return groups;
}
