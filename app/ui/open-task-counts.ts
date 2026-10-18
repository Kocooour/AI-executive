import type { Entity, Relation } from "../../lib/db";

// Project membership is represented by relations. Build the two lookups once and inspect each
// relation once, rather than scanning the complete relation list for every task row.
export function openTaskCountsByProject(
  items: Entity[],
  projects: Entity[],
  relations: Relation[],
) {
  const projectWorkspace = new Map(projects.map((project) => [project.id, project.workspaceId]));
  const openTaskWorkspace = new Map(
    items
      .filter((item) => item.type === "task" && item.status === "open")
      .map((task) => [task.id, task.workspaceId]),
  );
  const counts = new Map<string, number>();
  for (const relation of relations) {
    if (relation.relationType !== "belongs_to_project") continue;
    const taskWorkspace = openTaskWorkspace.get(relation.sourceEntityId);
    const projectWorkspaceId = projectWorkspace.get(relation.targetEntityId);
    if (!taskWorkspace || taskWorkspace !== projectWorkspaceId || relation.workspaceId !== taskWorkspace) continue;
    counts.set(relation.targetEntityId, (counts.get(relation.targetEntityId) || 0) + 1);
  }
  return counts;
}
