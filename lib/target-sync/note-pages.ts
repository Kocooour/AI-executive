/**
 * R2d.2c.2g.2b.4a — pure, staging-only note metadata page reconciler.
 *
 * Not a connected/offline client: the caller must enforce actor + restore-
 * generation + Area namespace isolation, authenticate every HTTP request,
 * handle 401/404/409 by wiping/restarting the correct scope, and commit pages
 * atomically before persisting a cursor. Never substitute task-feed events.
 * No note title/body, tombstone history, or credential belongs in this state.
 */
export type NoteMetadata = {
  id: string;
  revision: number;
  projectId: string | null;
  parentRevision: number | null;
};
export type NoteMetadataChange = {
  kind: "edit" | "delete";
  noteId: string;
  projectId: string | null;
  revision: number;
};
export type NoteSyncWirePage = {
  phase: "bootstrap" | "changes";
  entries: NoteMetadata[];
  changes: NoteMetadataChange[];
  more: boolean;
  cursor: string;
};
export type NoteSyncPageState = {
  phase: "bootstrap" | "changes";
  cursor: string | null;
  /** Published only after the entire bootstrap succeeds. */
  visible: NoteMetadata[];
  /** Incomplete manifest, not for reads. */
  pending: NoteMetadata[];
};
export type ApplyNoteSyncResult =
  | { ok: true; state: NoteSyncPageState }
  | { ok: false; reason: "invalid_page" | "resync_required" };

const MAX_PAGE = 100;
const MAX_AREA_NOTES = 4096;
/** Encrypted server cursor v1 has one version byte, 12-byte nonce, 3072-byte payload, 16-byte tag. */
const CURSOR_LENGTH = Math.ceil((1 + 12 + 3072 + 16) * 4 / 3);
const safeRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) =>
  Object.keys(v).sort().join(",") === expected;
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.isWellFormed() &&
  v.trim() === v && v !== "." && v !== ".." &&
  new TextEncoder().encode(v).length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const validCursor = (v: unknown): v is string =>
  typeof v === "string" && v.length === CURSOR_LENGTH && /^[A-Za-z0-9_-]+$/.test(v);

function entry(value: unknown): value is NoteMetadata {
  if (!record(value) || !keys(value, "id,parentRevision,projectId,revision") ||
      !validId(value.id) || !safeRevision(value.revision)) return false;
  return value.projectId === null
    ? value.parentRevision === null
    : validId(value.projectId) && safeRevision(value.parentRevision);
}
function change(value: unknown): value is NoteMetadataChange {
  return record(value) && keys(value, "kind,noteId,projectId,revision") &&
    (value.kind === "edit" || value.kind === "delete") &&
    validId(value.noteId) && (value.projectId === null || validId(value.projectId)) &&
    safeRevision(value.revision);
}

/** Strict response DTO allowlist: no content or internal server stamps. */
export function decodeNoteSyncWirePage(value: unknown): NoteSyncWirePage | null {
  if (!record(value) || !keys(value, "changes,cursor,entries,more,phase") ||
      (value.phase !== "bootstrap" && value.phase !== "changes") ||
      typeof value.more !== "boolean" || !validCursor(value.cursor) ||
      !Array.isArray(value.entries) || !Array.isArray(value.changes) ||
      value.entries.length > MAX_PAGE || value.changes.length > MAX_PAGE) return null;
  if (value.phase === "bootstrap") {
    if (value.changes.length !== 0 || (value.more && value.entries.length === 0) ||
        !value.entries.every(entry)) return null;
    const ids = (value.entries as NoteMetadata[]).map(e => e.id);
    if (new Set(ids).size !== ids.length) return null;
  } else if (value.entries.length !== 0 ||
             (value.more && value.changes.length === 0) ||
             !value.changes.every(change)) return null;
  return {
    phase: value.phase, entries: value.entries.map((v: NoteMetadata) => ({ ...v })),
    changes: value.changes.map((v: NoteMetadataChange) => ({ ...v })),
    more: value.more, cursor: value.cursor,
  };
}

/** Reset must be used before a fresh bootstrap (e.g. after 409 resync_required). */
export function emptyNoteSyncPageState(): NoteSyncPageState {
  return { phase: "bootstrap", cursor: null, visible: [], pending: [] };
}

/** Never expose pending bootstrap entries as a readable manifest. */
export function readableNoteMetadata(state: NoteSyncPageState): NoteMetadata[] {
  return state.phase === "changes" ? state.visible.map(v => ({ ...v })) : [];
}

/**
 * Apply exactly one page that was fetched using state.cursor. A rejected page
 * NEVER advances the cursor. The caller must throw away this Area's state and
 * rebootstrap on resync_required, not attempt to invent missing mutations.
 */
export function applyNoteSyncPage(
  state: NoteSyncPageState, raw: unknown,
): ApplyNoteSyncResult {
  const page = decodeNoteSyncWirePage(raw);
  if (!page || page.phase !== state.phase) return { ok: false, reason: "invalid_page" };
  if (page.phase === "bootstrap") {
    const ids = new Set(state.pending.map(e => e.id));
    for (const e of page.entries) {
      if (ids.has(e.id)) return { ok: false, reason: "resync_required" };
      ids.add(e.id);
    }
    if (ids.size > MAX_AREA_NOTES) return { ok: false, reason: "resync_required" };
    const pending = [...state.pending, ...page.entries];
    if (page.more) return { ok: true, state: {
      phase: "bootstrap", cursor: page.cursor, pending, visible: [],
    } };
    return { ok: true, state: {
      phase: "changes", cursor: page.cursor, pending: [], visible: pending,
    } };
  }
  if (state.cursor === null) return { ok: false, reason: "invalid_page" };
  const visible = new Map(state.visible.map(v => [v.id, { ...v }]));
  for (const event of page.changes) {
    const existing = visible.get(event.noteId);
    // New IDs and skipped revisions indicate an unjournaled create/move or
    // inconsistent feed. Rebootstrap instead of publishing a partial cache.
    if (!existing || event.revision !== existing.revision + 1 ||
        event.projectId !== existing.projectId) {
      return { ok: false, reason: "resync_required" };
    }
    if (event.kind === "delete") visible.delete(event.noteId);
    else visible.set(event.noteId, { ...existing, revision: event.revision });
  }
  return { ok: true, state: {
    phase: "changes", cursor: page.cursor, pending: [], visible: [...visible.values()],
  } };
}


/**
 * Validate a disk checkpoint before it may be used as a cursor source.
 * Data loaded from IndexedDB is untrusted; reject unknown fields and note
 * content as strictly as wire pages. Never publish an incomplete bootstrap.
 */
export function decodeNoteSyncCheckpoint(value: unknown): NoteSyncPageState | null {
  if (!record(value) || !keys(value, "cursor,pending,phase,visible") ||
      (value.phase !== "bootstrap" && value.phase !== "changes") ||
      !Array.isArray(value.visible) || !Array.isArray(value.pending) ||
      value.visible.length > MAX_AREA_NOTES || value.pending.length > MAX_AREA_NOTES ||
      !value.visible.every(entry) || !value.pending.every(entry)) return null;
  if (value.phase === "bootstrap") {
    if (value.visible.length !== 0 ||
        (value.cursor === null ? value.pending.length !== 0 : !validCursor(value.cursor) || value.pending.length === 0))
      return null;
  } else if (!validCursor(value.cursor) || value.pending.length !== 0) return null;
  const selected = value.phase === "bootstrap" ? value.pending : value.visible;
  if (new Set(selected.map((v: NoteMetadata) => v.id)).size !== selected.length) return null;
  return {
    phase: value.phase, cursor: value.cursor,
    visible: (value.visible as NoteMetadata[]).map(v => ({ ...v })),
    pending: (value.pending as NoteMetadata[]).map(v => ({ ...v })),
  };
}
