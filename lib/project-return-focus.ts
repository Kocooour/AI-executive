/**
 * UI-01d: focus restoration is a presentation concern, never an access grant.
 * Only return to the opener when the original authorized legacy scope is still
 * selected and the project is still visible after browser Back / close.
 */
export type ProjectReturnFocusIntent = {
  projectId: string;
  workspaceId: string;
  view: string;
  source: "sidebar" | "content";
};

export function shouldRestoreProjectFocus(
  intent: ProjectReturnFocusIntent | null,
  current: { openProjectId: string | null; workspaceId: string; view: string },
  visible: boolean,
): boolean {
  return !!intent && current.openProjectId === null && visible &&
    intent.workspaceId === current.workspaceId && intent.view === current.view;
}
