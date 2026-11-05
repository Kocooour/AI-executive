// UI-08a legacy capture guard. A capture without project context always starts
// private, regardless of the workspace selected elsewhere in the application.
// This is only a client UX guard: the R3 server Area ACL remains authoritative.
export function initialCaptureWorkspace(projectWorkspaceId: string | null | undefined, personalWorkspaceId: string): string {
  return projectWorkspaceId || personalWorkspaceId;
}

export type CaptureDestination = {
  type: "task" | "note";
  workspaceId: string;
  projectId?: string;
  areaId?: string;
  projectAction?: string;
};

export function captureDestinationKey(destination: CaptureDestination): string {
  // A consent is valid only for this exact target, never a different workspace,
  // type, project or Area selected by the user or suggested asynchronously.
  return JSON.stringify([
    destination.type,
    destination.workspaceId,
    destination.projectId || "",
    destination.areaId || "",
    destination.projectAction || "none",
  ]);
}

export function captureNeedsShareConsent(workspaceId: string, personalWorkspaceId: string): boolean {
  // An unknown or renamed workspace is never silently treated as private.
  return workspaceId !== personalWorkspaceId;
}
