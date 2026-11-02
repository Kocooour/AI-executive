/**
 * R2d.2c.2g.2b.1: isolated, content-free note-only journal contract.
 *
 * This table is NOT part of the current canonical v16 staging store and must
 * not be attached to live HTTP. The next schema iteration will wire atomic
 * emission and preflight. Caller must supply a verified actor, an already
 * pinned canonical snapshot and a live session/release guard before exposure.
 */
import { DatabaseSync } from "node:sqlite";

export const NOTE_SYNC_JOURNAL_MAX_EVENTS = 8192;
export const NOTE_SYNC_JOURNAL_PAGE_LIMIT = 100;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x < MAX_SAFE;
const validId = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.isWellFormed() &&
  x.trim() === x && x !== "." && x !== ".." &&
  Buffer.byteLength(x, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(x);

/** Install on synthetic v16 SQLite fixtures ONLY; canonical schema is unchanged. */
export const TARGET_NOTE_JOURNAL_SCHEMA_SQL = `
CREATE TABLE note_sync_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL CHECK(typeof(note_id)='text' AND note_id<>'' AND note_id=trim(note_id)
    AND length(CAST(note_id AS BLOB))<=512),
  area_id TEXT NOT NULL REFERENCES areas(id),
  project_id TEXT,
  op TEXT NOT NULL CHECK(op IN ('edit','delete')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<9007199254740991),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  restore_generation TEXT NOT NULL CHECK(length(restore_generation)=36),
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0),
  UNIQUE(note_id,revision)
);
CREATE INDEX note_sync_journal_by_area ON note_sync_journal(area_id,seq);
CREATE TRIGGER note_sync_journal_no_update BEFORE UPDATE ON note_sync_journal
BEGIN SELECT RAISE(ABORT, 'note journal events are immutable'); END;
CREATE TRIGGER note_sync_journal_no_delete BEFORE DELETE ON note_sync_journal
BEGIN SELECT RAISE(ABORT, 'note journal retention not approved'); END;
CREATE TRIGGER note_sync_journal_no_replace BEFORE INSERT ON note_sync_journal
WHEN EXISTS(SELECT 1 FROM note_sync_journal
  WHERE (note_id=NEW.note_id AND revision=NEW.revision) OR seq=NEW.seq)
BEGIN SELECT RAISE(ABORT, 'note journal replacement denied'); END;
CREATE TRIGGER note_sync_journal_capacity BEFORE INSERT ON note_sync_journal
WHEN (SELECT COUNT(*) FROM note_sync_journal)>=${NOTE_SYNC_JOURNAL_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'note journal capacity reached'); END;
CREATE TRIGGER note_sync_journal_dense AFTER INSERT ON note_sync_journal
WHEN NEW.seq<>(SELECT COUNT(*) FROM note_sync_journal)
BEGIN SELECT RAISE(ABORT, 'noncontiguous note journal sequence'); END;
`;

export type TargetNoteJournalOp = "edit" | "delete";
export type TargetNoteJournalEvent = {
  seq: number;
  noteId: string;
  areaId: string;
  projectId: string | null;
  op: TargetNoteJournalOp;
  revision: number;
};
export type TargetNoteJournalPage = {
  events: TargetNoteJournalEvent[];
  nextSeq: number;
  hasMore: boolean;
  policyRevision: number;
  restoreGeneration: string;
};
type Denied = { ok: false };
export type TargetNoteJournalAppend = { ok: true; seq: number } | Denied;

/**
 * A trusted future note writer MUST call this in the SAME BEGIN IMMEDIATE
 * transaction as the edit/tombstone and its audit. Derive all journal claims
 * from SQLite, never from a caller-selected Area or client payload.
 */
export function appendTrustedTargetNoteJournalEvent(
  db: DatabaseSync, op: TargetNoteJournalOp, noteId: string,
  committedAtMs: number,
): TargetNoteJournalAppend {
  const denied: Denied = { ok: false };
  if (!db.isTransaction || (op !== "edit" && op !== "delete") ||
      !validId(noteId) || !validInt(committedAtMs) || committedAtMs === 0) return denied;
  try {
    const source = op === "edit"
      ? db.prepare(`SELECT n.revision, n.project_id AS projectId,
          COALESCE(n.area_id,p.area_id) AS areaId
          FROM notes n LEFT JOIN projects p ON p.id=n.project_id WHERE n.id=?`)
        .get(noteId) as { revision: number; projectId: string | null; areaId: string } | undefined
      : db.prepare(`SELECT revision, project_id AS projectId, area_id AS areaId
          FROM note_tombstones WHERE id=?`)
        .get(noteId) as { revision: number; projectId: string | null; areaId: string } | undefined;
    if (!source || !validInt(source.revision) || source.revision === 0 ||
        !validId(source.areaId) ||
        (source.projectId !== null && !validId(source.projectId))) return denied;
    const policy = db.prepare("SELECT policy_revision AS policyRevision FROM areas WHERE id=?")
      .get(source.areaId) as { policyRevision: number } | undefined;
    const meta = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined;
    if (!policy || !validInt(policy.policyRevision) || !meta ||
        typeof meta.value !== "string" || !GENERATION.test(meta.value)) return denied;
    const result = db.prepare(`INSERT INTO note_sync_journal
      (note_id,area_id,project_id,op,revision,policy_revision,restore_generation,committed_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      noteId, source.areaId, source.projectId, op, source.revision,
      policy.policyRevision, meta.value.toLowerCase(), committedAtMs,
    );
    const seq = Number(result.lastInsertRowid);
    return validInt(seq) && seq > 0 ? { ok: true, seq } : denied;
  } catch {
    return denied;
  }
}

/**
 * Internal ACL-scoped event paging. No first-page HTTP API is provided.
 * The response reveals no global head or unrelated Area activity.
 * A policy/generation mismatch at ANY returned event forces rebootstrap;
 * never retroactively disclose events recorded before a membership change.
 * With no approved pruning, any missing seq is corruption, not a deletion.
 */
export function readAuthorizedTargetNoteJournalPage(
  db: DatabaseSync,
  request: { actorUserId: string; areaId: string; afterSeq: number; limit: number },
): TargetNoteJournalPage | null {
  if (!request || typeof request !== "object" ||
      typeof request.actorUserId !== "string" || !ACTOR.test(request.actorUserId) ||
      !validId(request.areaId) || !validInt(request.afterSeq) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 ||
      request.limit > NOTE_SYNC_JOURNAL_PAGE_LIMIT) return null;
  try {
    const area = db.prepare(`SELECT a.kind AS areaKind, w.kind AS workspaceKind,
      a.owner_user_id AS areaOwner, w.owner_user_id AS workspaceOwner,
      a.policy_revision AS policyRevision, m.role AS memberRole
      FROM areas a JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id
      WHERE a.id=? LIMIT 1`).get(request.actorUserId, request.areaId) as {
      areaKind: string; workspaceKind: string; areaOwner: string;
      workspaceOwner: string; policyRevision: number; memberRole: string | null;
    } | undefined;
    if (!area || !ACTOR.test(area.areaOwner) ||
        area.areaOwner !== area.workspaceOwner ||
        !validInt(area.policyRevision)) return null;
    const allowed = area.areaKind === "private" &&
      area.workspaceKind === "personal" && area.areaOwner === request.actorUserId ||
      area.areaKind === "shared" && area.workspaceKind === "shared" &&
      (area.memberRole === "viewer" || area.memberRole === "editor" ||
       area.memberRole === "admin");
    if (!allowed) return null;
    const meta = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined;
    if (!meta || typeof meta.value !== "string" || !GENERATION.test(meta.value)) return null;
    const count = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq),0) AS head FROM note_sync_journal")
      .get() as { n: number; head: number };
    if (!validInt(count.n) || count.n > NOTE_SYNC_JOURNAL_MAX_EVENTS ||
        !validInt(count.head) || count.head !== count.n ||
        request.afterSeq > count.head) return null;
    const rows = db.prepare(`SELECT seq,note_id AS noteId,area_id AS areaId,
      project_id AS projectId,op,revision,policy_revision AS policyRevision,
      restore_generation AS generation
      FROM note_sync_journal WHERE area_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(request.areaId, request.afterSeq, request.limit + 1) as Array<{
        seq: number; noteId: string; areaId: string; projectId: string | null;
        op: string; revision: number; policyRevision: number; generation: string;
      }>;
    for (const row of rows) {
      if (!validInt(row.seq) || row.seq <= request.afterSeq ||
          !validId(row.noteId) || row.areaId !== request.areaId ||
          (row.projectId !== null && !validId(row.projectId)) ||
          (row.op !== "edit" && row.op !== "delete") ||
          !validInt(row.revision) || row.revision < 1 ||
          row.policyRevision !== area.policyRevision ||
          typeof row.generation !== "string" ||
          row.generation.toLowerCase() !== meta.value.toLowerCase()) return null;
    }
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit);
    return {
      events: items.map(({ seq, noteId, areaId, projectId, op, revision }) => ({
        seq, noteId, areaId, projectId, op: op as TargetNoteJournalOp, revision,
      })),
      nextSeq: items.length ? items[items.length - 1].seq : request.afterSeq,
      hasMore,
      policyRevision: area.policyRevision,
      restoreGeneration: meta.value.toLowerCase(),
    };
  } catch {
    return null;
  }
}
