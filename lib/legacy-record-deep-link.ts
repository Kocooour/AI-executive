import type { NavigationTarget } from "./view-url";

// Temporary legacy owner-store resolver, NOT the Area ACL / server authorization of
// UI-09/R3. URLs are locators only. A missing, wrong-type or orphan target fails closed.
export type LegacyRecordRow = {
  id: string;
  type: string;
  workspaceId: string;
  properties?: Record<string, unknown>;
};
export type LegacyRecordRelation = {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  workspaceId: string;
};

/**
 * Current belongs_to_project edges are authoritative for project ancestry.
 * Only legacy records with *no* project edge can use their old projectId field.
 * Conflicting/foreign edges never grant a stale parent, including multi-parent
 * corruptions; links cannot transfer access across legacy workspaces.
 */
export function legacyRecordBelongsToProject(
  record: LegacyRecordRow,
  projectId: string,
  relations: readonly LegacyRecordRelation[],
): boolean {
  const projectEdges = relations.filter((link) =>
    link.sourceEntityId === record.id && link.relationType === "belongs_to_project");
  if (projectEdges.length > 0) {
    return projectEdges.length === 1 &&
      projectEdges[0].workspaceId === record.workspaceId &&
      projectEdges[0].targetEntityId === projectId;
  }
  return record.properties?.projectId === projectId;
}

export function resolveLegacyRecordLink<T extends LegacyRecordRow>(
  records: readonly T[],
  relations: readonly LegacyRecordRelation[],
  target: NavigationTarget | null,
  activeWorkspaceId: string,
): { record: T; projectId: string | null; selectWorkspaceId: string | null } | null {
  if (target?.kind !== "task" && target?.kind !== "note") return null;
  const record = records.find((item) => item.id === target.id && item.type === target.kind);
  if (!record) return null;
  if (!records.some((item) => item.type === "workspace" && item.workspaceId === record.workspaceId)) return null;

  let projectId: string | null = null;
  if (target.projectId !== undefined) {
    if (target.view !== "Projects") return null;
    const project = records.find((item) => item.type === "project" && item.id === target.projectId &&
      item.workspaceId === record.workspaceId);
    if (!project) return null;
    if (!legacyRecordBelongsToProject(record, project.id, relations)) return null;
    projectId = project.id;
  }

  return {
    record,
    projectId,
    selectWorkspaceId: activeWorkspaceId === "all" || activeWorkspaceId === record.workspaceId
      ? null : record.workspaceId,
  };
}
