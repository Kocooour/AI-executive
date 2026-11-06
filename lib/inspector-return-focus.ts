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
