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
    const parentRelation = relations.some((link) =>
      link.sourceEntityId === record.id && link.targetEntityId === project.id &&
      link.workspaceId === record.workspaceId && link.relationType === "belongs_to_project");
    // Legacy tasks may also have a direct projectId property. Neither that
    // property nor a relation can carry access across two different scopes.
    if (!parentRelation && record.properties?.projectId !== project.id) return null;
    projectId = project.id;
  }

  return {
    record,
    projectId,
    selectWorkspaceId: activeWorkspaceId === "all" || activeWorkspaceId === record.workspaceId
      ? null : record.workspaceId,
  };
}
