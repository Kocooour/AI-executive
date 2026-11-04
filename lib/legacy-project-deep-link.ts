// UI-01's temporary legacy resolver. This does NOT implement target Area ACL.
// Every result must also be present in the authenticated owner's current legacy
// store; UI-09/R3 replaces this with live server-authorized project resolution.
export type LegacyProjectLinkRow = { id: string; type: string; workspaceId: string };

export function resolveLegacyProjectLink(
  records: readonly LegacyProjectLinkRow[],
  id: string,
  activeWorkspaceId: string,
): { projectId: string; selectWorkspaceId: string | null } | null {
  const project = records.find((record) => record.type === "project" && record.id === id);
  if (!project) return null;
  // Do not switch scopes based on an orphan project or an arbitrary URL value.
  if (!records.some((record) => record.type === "workspace" && record.workspaceId === project.workspaceId)) return null;
  // Legacy "all" is only a client aggregate, never the target "my-plan" policy.
  return {
    projectId: project.id,
    selectWorkspaceId: activeWorkspaceId === "all" || activeWorkspaceId === project.workspaceId
      ? null
      : project.workspaceId,
  };
}
