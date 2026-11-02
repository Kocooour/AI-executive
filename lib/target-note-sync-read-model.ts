/** Internal, content-free note journal reader. No HTTP or client release path. */
import { DatabaseSync } from "node:sqlite";
import { readAuthorizedTargetNoteBootstrapPage, NOTE_BOOTSTRAP_PAGE_LIMIT } from "./target-note-sync-bootstrap";
import { openTargetNoteSyncCursor, sealTargetNoteSyncCursor, type NoteSyncCursorScope } from "./target-note-sync-cursor";
import type { TargetReadLinearization } from "./target-task-read-model";

type EventRow = { seq: number; kind: "edit" | "delete"; note_id: string;
  project_id: string | null; revision: number };
export type TargetNoteChange = { seq: number; kind: "edit" | "delete";
  noteId: string; projectId: string | null; revision: number };
export type TargetNoteSyncPage = {
  phase: "bootstrap" | "changes";
  entries: { id: string; revision: number; projectId: string | null; parentRevision: number | null }[];
  changes: TargetNoteChange[];
  more: boolean;
  cursor: string;
  /** Internal witness for a later live durable-session and Area-policy check. */
  linearization: TargetReadLinearization;
};

type Request = { actorUserId: string; areaId: string; sessionEpoch: number;
  secret: string; cursor?: string; limit: number; nowSeconds?: number };
const safeInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Call only on a canonical, preflighted, pinned read-only staging snapshot
 * with server-verified actor and revocation epoch. The result is internal:
 * a future gateway must perform a live durable-session/Area-policy check just
 * before release. An unjournaled note or parent change returns null and the
 * consumer must discard this cursor and fully rebootstrap the Area.
 */
export function readAuthorizedTargetNoteSyncPage(
  db: DatabaseSync, request: Request,
): TargetNoteSyncPage | null {
  if (!request || !safeInt(request.sessionEpoch) ||
      !Number.isInteger(request.limit) || request.limit < 1 ||
      request.limit > NOTE_BOOTSTRAP_PAGE_LIMIT ||
      (request.cursor !== undefined && typeof request.cursor !== "string")) return null;
  try {
    // The manifest selector derives current ACL, policy and generation from
    // this snapshot. Never use token claims as authorization evidence.
    const first = readAuthorizedTargetNoteBootstrapPage(db, {
      actorUserId: request.actorUserId, areaId: request.areaId,
      afterId: null, limit: 1,
    });
    if (!first) return null;
    const area = first.linearization.areas[0];
    const generation = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined)?.value;
    if (!generation) return null;
    const identity = db.prepare("SELECT revocation_epoch AS epoch FROM identities WHERE id=?")
      .get(request.actorUserId) as { epoch: number } | undefined;
    if (!identity || !safeInt(identity.epoch) || identity.epoch !== request.sessionEpoch) return null;
    const scope: NoteSyncCursorScope = {
      actorUserId: request.actorUserId, sessionEpoch: request.sessionEpoch,
      restoreGeneration: generation, areaId: request.areaId,
      policyRevision: area.policyRevision, access: area.access,
    };
    const stamp = db.prepare(`SELECT a.note_sync_revision AS contentRevision,
      COALESCE((SELECT MAX(j.seq) FROM note_change_journal j WHERE j.area_id=a.id),0) AS head
      FROM areas a WHERE a.id=?`).get(request.areaId) as
      { contentRevision: number; head: number } | undefined;
    if (!stamp || !safeInt(stamp.contentRevision) || !safeInt(stamp.head) ||
        stamp.contentRevision < stamp.head) return null;
    const opened = request.cursor === undefined ? null : openTargetNoteSyncCursor(
      request.secret, request.cursor, scope, request.nowSeconds);
    if (request.cursor !== undefined && (!opened || !opened.ok)) return null;
    const position = opened?.ok ? opened.position : null;
    if (position?.phase !== "changes") {
      const page = position?.phase !== "bootstrap" ? readAuthorizedTargetNoteBootstrapPage(db, {
        actorUserId: request.actorUserId, areaId: request.areaId,
        afterId: null, limit: request.limit,
      }) : readAuthorizedTargetNoteBootstrapPage(db, {
        actorUserId: request.actorUserId, areaId: request.areaId,
        afterId: position.afterId, expectedSnapshotRevision: position.snapshotRevision,
        limit: request.limit,
      });
      if (!page) return null;
      const next = page.hasMore ? {
        phase: "bootstrap" as const, afterId: page.nextAfterId!,
        snapshotRevision: page.snapshotRevision,
      } : {
        phase: "changes" as const, afterSeq: stamp.head,
        contentRevision: stamp.contentRevision,
      };
      const cursor = sealTargetNoteSyncCursor(request.secret, scope, next, request.nowSeconds);
      return cursor ? { phase: "bootstrap", entries: page.entries, changes: [],
        more: page.hasMore, cursor, linearization: page.linearization } : null;
    }
    if (position.afterSeq > stamp.head || position.contentRevision > stamp.contentRevision ||
        stamp.contentRevision - position.contentRevision !== stamp.head - position.afterSeq) return null;
    const rows = db.prepare(`SELECT seq,kind,note_id,project_id,revision
      FROM note_change_journal WHERE area_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(request.areaId, position.afterSeq, request.limit + 1) as EventRow[];
    const chosen = rows.slice(0, request.limit);
    let expected = position.afterSeq;
    for (const row of rows) {
      if (++expected !== row.seq || (row.kind !== "edit" && row.kind !== "delete") ||
          typeof row.note_id !== "string" || !safeInt(row.revision)) return null;
    }
    const next = { phase: "changes" as const, afterSeq: position.afterSeq + chosen.length,
      contentRevision: position.contentRevision + chosen.length };
    const cursor = sealTargetNoteSyncCursor(request.secret, scope, next, request.nowSeconds);
    return cursor ? { phase: "changes", entries: [], changes: chosen.map(row => ({
      seq: row.seq, kind: row.kind, noteId: row.note_id,
      projectId: row.project_id, revision: row.revision,
    })), more: rows.length > chosen.length, cursor,
      linearization: first.linearization } : null;
  } catch {
    return null;
  }
}
