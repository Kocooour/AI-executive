import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Entity } from "./db";

// Server-side history of a note's text. A revision is written inside the transaction that stores
// a change to a note's title or content (replaceSnapshot, restoreBackup), so a refused or failed
// write leaves none. Revisions are owner-only: nothing here is read by agents, PACT tools, the AI
// provider, attention, the day plan or the client snapshot. Deleting a note deletes its revisions.

export type NoteRevisionOrigin = "baseline" | "created" | "edited" | "backup_restore";

export const maxRevisionsPerNote = 20;

export interface NoteRevisionSummary {
  revision: number;
  createdAt: number;
  origin: NoteRevisionOrigin;
  title: string;
  contentLength: number;
  sameAsRevision: number | null;
}

export interface NoteRevisionDetail extends NoteRevisionSummary {
  content: string;
}

export function noteTextHash(title: string, content: string) {
  return createHash("sha256").update(JSON.stringify([title, content])).digest("hex");
}

const noteContent = (entity: Entity) => typeof entity.content === "string" ? entity.content : "";

/** The migration: every existing note gets revision 1 (`baseline`); a note that already has revisions is skipped. */
export function baselineNoteRevisions(database: DatabaseSync, storeRevision = 0) {
  const rows = database.prepare("SELECT payload FROM entities").all() as Array<{ payload: string }>;
  const has = database.prepare("SELECT 1 FROM note_revisions WHERE note_id = ? LIMIT 1");
  const insert = database.prepare(`INSERT INTO note_revisions
    (id, note_id, workspace_id, revision, title, content, content_sha256, origin, store_revision, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'baseline', ?, ?)`);
  for (const row of rows) {
    let entity: Entity;
    try { entity = JSON.parse(String(row.payload)) as Entity; } catch { continue; }
    if (!entity || entity.type !== "note" || typeof entity.id !== "string" || has.get(entity.id)) continue;
    const content = noteContent(entity);
    insert.run(randomUUID(), entity.id, String(entity.workspaceId || "personal"), String(entity.title ?? ""), content,
      noteTextHash(String(entity.title ?? ""), content), storeRevision, Number(entity.updatedAt) || Date.now());
  }
}

/**
 * Called inside the write transaction. Notes that are new or whose title/content changed get the next revision;
 * notes that are gone (deleted, dropped, no longer a note) lose all revisions. Anything else writes nothing.
 */
export function recordNoteRevisions(
  database: DatabaseSync,
  before: Entity[],
  after: Entity[],
  origin: "edited" | "backup_restore",
  storeRevision: number,
  now = Date.now(),
) {
  const previous = new Map<string, Entity>();
  for (const entity of before) if (entity.type === "note") previous.set(entity.id, entity);
  const live = new Set<string>();
  const latest = database.prepare(
    "SELECT revision, content_sha256 AS hash FROM note_revisions WHERE note_id = ? ORDER BY revision DESC LIMIT 1");
  const insert = database.prepare(`INSERT INTO note_revisions
    (id, note_id, workspace_id, revision, title, content, content_sha256, origin, store_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const count = database.prepare("SELECT COUNT(*) AS value FROM note_revisions WHERE note_id = ?");
  const prune = database.prepare(`DELETE FROM note_revisions WHERE note_id = ? AND revision IN (
    SELECT revision FROM note_revisions WHERE note_id = ? ORDER BY revision ASC LIMIT ?)`);
  const write = (entity: Entity, revision: number, kind: NoteRevisionOrigin, at: number) => {
    const content = noteContent(entity);
    insert.run(randomUUID(), entity.id, String(entity.workspaceId || "personal"), revision, entity.title, content,
      noteTextHash(entity.title, content), kind, storeRevision, at);
  };
  for (const entity of after) {
    if (entity.type !== "note") continue;
    live.add(entity.id);
    const hash = noteTextHash(entity.title, noteContent(entity));
    let last = latest.get(entity.id) as { revision: number; hash: string } | undefined;
    const existing = previous.get(entity.id);
    if (!last && existing) {
      // A note that predates its history (no baseline): keep what it said before this write too.
      write(existing, 1, "baseline", now);
      last = { revision: 1, hash: noteTextHash(existing.title, noteContent(existing)) };
    }
    if (last && last.hash === hash) continue;
    const kind: NoteRevisionOrigin = origin === "backup_restore" ? "backup_restore" : existing || last ? "edited" : "created";
    write(entity, (last?.revision ?? 0) + 1, kind, now);
    const total = Number((count.get(entity.id) as { value: number }).value);
    if (total > maxRevisionsPerNote) prune.run(entity.id, entity.id, total - maxRevisionsPerNote);
  }
  const noted = database.prepare("SELECT DISTINCT note_id AS id FROM note_revisions").all() as Array<{ id: string }>;
  const remove = database.prepare("DELETE FROM note_revisions WHERE note_id = ?");
  for (const { id } of noted) if (!live.has(id)) remove.run(id);
}

function noteExists(database: DatabaseSync, noteId: string) {
  const row = database.prepare("SELECT payload FROM entities WHERE id = ?").get(noteId) as { payload: string } | undefined;
  if (!row) return false;
  try { return (JSON.parse(String(row.payload)) as Entity).type === "note"; } catch { return false; }
}

type Row = { revision: number; created_at: number; origin: NoteRevisionOrigin; title: string; content: string; content_sha256: string };

/** Newest first, no content. `sameAsRevision`: the newest earlier revision with identical title and text. Null: unknown note. */
export function listNoteRevisions(database: DatabaseSync, noteId: string): NoteRevisionSummary[] | null {
  if (!noteExists(database, noteId)) return null;
  const rows = database.prepare(`SELECT revision, created_at, origin, title, length(content) AS length, content_sha256
    FROM note_revisions WHERE note_id = ? ORDER BY revision ASC`).all(noteId) as unknown as Array<Row & { length: number }>;
  const seen = new Map<string, number>();
  const summaries = rows.map((row) => {
    const sameAsRevision = seen.get(row.content_sha256) ?? null;
    seen.set(row.content_sha256, row.revision);
    return { revision: Number(row.revision), createdAt: Number(row.created_at), origin: row.origin, title: row.title,
      contentLength: Number(row.length), sameAsRevision };
  });
  return summaries.reverse();
}

export function getNoteRevision(database: DatabaseSync, noteId: string, revision: number): NoteRevisionDetail | null {
  const summaries = listNoteRevisions(database, noteId);
  const summary = summaries?.find((item) => item.revision === revision);
  if (!summary) return null;
  const row = database.prepare("SELECT content FROM note_revisions WHERE note_id = ? AND revision = ?").get(noteId, revision) as { content: string };
  return { ...summary, content: row.content };
}

/** The answer of the revisions route for a validated query (the route checks the owner session first). */
export function answerRevisionQuery(database: DatabaseSync, noteId: string, revisionText: string | null):
  { status: 200 | 400 | 404; body: Record<string, unknown>; count?: number } {
  const revision = revisionText === null ? null : /^[1-9]\d{0,9}$/.test(revisionText) ? Number(revisionText) : Number.NaN;
  if (!noteId || noteId.length > 240 || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1))) {
    return { status: 400, body: { error: "Invalid note or revision" } };
  }
  if (revision === null) {
    const revisions = listNoteRevisions(database, noteId);
    return revisions ? { status: 200, body: { revisions }, count: revisions.length } : { status: 404, body: { error: "Note not found" } };
  }
  const found = getNoteRevision(database, noteId, revision);
  return found ? { status: 200, body: { revision: found } } : { status: 404, body: { error: "Note or revision not found" } };
}
