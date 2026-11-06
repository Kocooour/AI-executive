/**
 * UI-01e: local inspector focus provenance only. This never grants access to
 * an entity; the active data scope and server ACL remain authoritative.
 */
export type InspectorFocusOrigin = {
  entityId: string;
  workspaceId: string;
  view: string;
};

export function inspectorOpenerMatchesSelection(
  selectedId: string,
  rowEntityId: string | null,
): boolean {
  return rowEntityId !== null && selectedId === rowEntityId;
}

/** A return target must still be the same visible, connected row in the scope
 * where it originally opened this inspector. Never restore an earlier task's
 * button after switching to another entity or view.
 */
export function shouldRestoreInspectorFocus(
  origin: InspectorFocusOrigin | null,
  current: {
    workspaceId: string;
    view: string;
    rowEntityId: string | null;
    connected: boolean;
    rendered: boolean;
  },
): boolean {
  return origin !== null &&
    origin.workspaceId === current.workspaceId &&
    origin.view === current.view &&
    inspectorOpenerMatchesSelection(origin.entityId, current.rowEntityId) &&
    current.connected && current.rendered;
}

/** The exact focus lifecycle used by DetailPanel, including ref consumption.
 * Kept here so regression tests execute transitions rather than inspecting
 * JSX source with regular expressions.
 */
export type InspectorPendingReturn = { origin: InspectorFocusOrigin; opener: HTMLElement };

export function advanceInspectorReturnFocus(
  pending: InspectorPendingReturn | null,
  selectedId: string | null,
  active: HTMLElement | null,
  inspector: HTMLElement | null,
  workspaceId: string,
  view: string,
  scopeChanged: boolean,
): InspectorPendingReturn | null {
  if (selectedId !== null) {
    // A scope transition must invalidate the opener even if the same row button
    // remains focused and the selected entity ID is unchanged.
    if (scopeChanged) return null;
    // A new selection never inherits the earlier entity's opener.
    const rowEntityId = active?.closest<HTMLElement>("[data-drop-entity]")?.dataset.dropEntity ?? null;
    if (!active?.matches(".taskRowOpen") || !inspectorOpenerMatchesSelection(selectedId, rowEntityId)) return null;
    inspector?.focus();
    return { origin: { entityId: selectedId, workspaceId, view }, opener: active };
  }
  // Closing consumes the origin even when the target has been detached,
  // hidden or rebound to another entity.
  if (pending) {
    const opener = pending.opener;
    const rowEntityId = opener.closest<HTMLElement>("[data-drop-entity]")?.dataset.dropEntity ?? null;
    if (shouldRestoreInspectorFocus(pending.origin, {
      workspaceId, view, rowEntityId,
      connected: opener.isConnected, rendered: opener.getClientRects().length > 0,
    })) opener.focus({ preventScroll: true });
  }
  return null;
}
