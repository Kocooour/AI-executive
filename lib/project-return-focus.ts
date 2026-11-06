/**
 * UI-01d: per-history-entry focus restoration is presentation-only. Neither
 * a saved history token nor a DOM opener is an authorization capability.
 */
export type ProjectReturnFocusIntent = {
  projectId: string;
  workspaceId: string;
  view: string;
  source: "sidebar" | "content";
  originProjectId: string | null;
  originSearch: string;
};

export type ProjectFocusEntry<T> = { intent: ProjectReturnFocusIntent; opener: T };

/**
 * A Back operation from a specific *departing* history entry restores that
 * entry's opener, only if the destination is its exact recorded origin.
 * Forward, arbitrary Back targets and stale history tokens never do.
 */
export function projectFocusReturnForHistory<T>(
  departingEntryId: string | null,
  entries: ReadonlyMap<string, ProjectFocusEntry<T>>,
  destinationSearch: string,
): ProjectFocusEntry<T> | null {
  if (!departingEntryId) return null;
  const entry = entries.get(departingEntryId);
  return entry?.intent.originSearch === destinationSearch ? entry : null;
}

/** Check the committed destination and current local visibility before DOM focus. */
export function shouldRestoreProjectFocus(
  intent: ProjectReturnFocusIntent | null,
  current: { openProjectId: string | null; workspaceId: string; view: string; search: string },
  visible: boolean,
): boolean {
  return !!intent && visible &&
    intent.originProjectId === current.openProjectId &&
    intent.workspaceId === current.workspaceId &&
    intent.view === current.view &&
    intent.originSearch === current.search;
}
