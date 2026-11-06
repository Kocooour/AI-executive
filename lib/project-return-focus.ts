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
  /** Unique browser-history entry, not an authorization token. */
  originPositionId: string;
};

export type ProjectFocusEntry<T> = { intent: ProjectReturnFocusIntent; opener: T };

/** History.state is untrusted after reload; only minted IDs in this mounted app count. */
export function knownProjectFocusPosition(state: unknown, positions: ReadonlySet<string>): string | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { lumiFocusEntry?: unknown }).lumiFocusEntry;
  return typeof candidate === "string" && positions.has(candidate) ? candidate : null;
}

/**
 * A Back operation from a specific *departing* history entry restores that
 * entry's opener, only if the destination is its exact recorded origin.
 * Forward, arbitrary Back targets and stale history tokens never do.
 */
export function projectFocusReturnForHistory<T>(
  departingEntryId: string | null,
  entries: ReadonlyMap<string, ProjectFocusEntry<T>>,
  destinationPositionId: string | null,
  destinationSearch: string,
): ProjectFocusEntry<T> | null {
  if (!departingEntryId || !destinationPositionId) return null;
  const entry = entries.get(departingEntryId);
  // Identical URLs can occupy different history slots (A₁ → B → A₂).
  // Only the exact origin slot may restore the opener on Back.
  return entry?.intent.originPositionId === destinationPositionId &&
    entry.intent.originSearch === destinationSearch ? entry : null;
}

/** Check the committed destination and current local visibility before DOM focus. */
export function shouldRestoreProjectFocus(
  intent: ProjectReturnFocusIntent | null,
  current: { openProjectId: string | null; workspaceId: string; view: string; search: string; positionId: string | null },
  visible: boolean,
): boolean {
  return !!intent && visible &&
    intent.originProjectId === current.openProjectId &&
    intent.workspaceId === current.workspaceId &&
    intent.view === current.view &&
    intent.originSearch === current.search &&
    intent.originPositionId === current.positionId;
}
