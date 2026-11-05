// Quick Capture previews a project's inherited Area only when its current
// locally scoped relation points to exactly one active Area in the same workspace.
// This display helper never grants access or substitutes for the write validation.
export interface CaptureAreaRow {
  id: string;
  type: string;
  workspaceId: string;
  status: string;
  title: string;
}

export function verifiedProjectAreaTitle(
  project: { id: string; workspaceId: string } | null | undefined,
  areaIds: readonly string[],
  rows: readonly CaptureAreaRow[],
): string | null {
  if (!project || areaIds.length !== 1 || !areaIds[0]) return null;
  const area = rows.find(row => row.id === areaIds[0]);
  return area?.type === "area" && area.status === "active" &&
    area.workspaceId === project.workspaceId && area.title.trim() ? area.title : null;
}
