/**
 * R2d.2c.2g.2b.5 staging-only, OPERATOR-ONLY note change journal compaction (no HTTP
 * endpoint; see scripts/target-staging-compact-note-journal.mjs). Mirrors the task
 * change-log compaction (R2c.2b): pinned-fd + BEGIN IMMEDIATE write helper whose canonical
 * preflight runs inside the transaction before this body.
 *
 * Per Area the new floor is MIN(seq committed at or after `now - retentionDays`) - 1, or
 * the Area's MAX(seq) when no row is that recent, never lower than the current floor.
 * Every row at or below the floor is then deleted (the schema's guarded-delete trigger
 * allows exactly that, even for direct SQL). Unlike the task log there is no per-key
 * "keep the last row" rule: a note sync cursor at or behind the floor is refused with
 * resync_required and the client rebootstraps the whole Area from live notes.
 * The result is content-free: counts only.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { TARGET_STORE_FILENAME } from "./target-store-bootstrap";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

/** Proposed default; the owner decides it in PR review. */
export const TARGET_STAGING_NOTE_JOURNAL_DEFAULT_RETENTION_DAYS = 30;
export const TARGET_STAGING_NOTE_JOURNAL_MIN_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const BATCH = 1000;
const BUSY_MS = 5_000;

export type TargetStagingNoteJournalCompaction =
  | { ok: true; areas: number; deleted: number }
  | { ok: false; reason: "invalid_request" | "journal_present" | "unavailable" | "write_failed" };

/**
 * Same bounded retry as the change-log compaction: only a pre-body (preflight/pin) refusal
 * is retried once with a NEW full preflight. write_failed, journal_present and
 * invalid_request are never retried.
 */
export function compactTargetStagingNoteJournal(
  store: TargetStagingReadStore,
  options: { retentionDays: number; now: number },
): TargetStagingNoteJournalCompaction {
  const first = compactOnce(store, options);
  if (first.ok === true || first.reason !== "unavailable") return first;
  return compactOnce(store, options);
}

function compactOnce(
  store: TargetStagingReadStore,
  options: { retentionDays: number; now: number },
): TargetStagingNoteJournalCompaction {
  const { retentionDays, now } = options ?? ({} as { retentionDays: number; now: number });
  if (!Number.isSafeInteger(retentionDays) || retentionDays < TARGET_STAGING_NOTE_JOURNAL_MIN_RETENTION_DAYS ||
      retentionDays > 36_500 || !Number.isSafeInteger(now) || now <= 0) {
    return { ok: false, reason: "invalid_request" };
  }
  const cutoff = now - retentionDays * DAY_MS;
  // A hot rollback journal (an interrupted write or restore) makes every pinned writer refuse.
  try {
    if (typeof store?.stagingDirectory === "string") {
      lstatSync(path.join(store.stagingDirectory, TARGET_STORE_FILENAME + "-journal"));
      return { ok: false, reason: "journal_present" };
    }
  } catch { /* no journal: the normal path */ }
  return withPinnedTargetStagingWrite<TargetStagingNoteJournalCompaction>(store, context => {
    const { db } = context;
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const floors = db.prepare("SELECT area_id, floor_seq FROM note_journal_floors ORDER BY area_id")
      .all() as { area_id: string; floor_seq: number }[];
    // Rows still within retention are never compacted even if commit times are not monotonic:
    // the floor stops just before the FIRST row newer than the cutoff.
    const candidate = db.prepare(`SELECT COALESCE(
        (SELECT MIN(seq) FROM note_change_journal WHERE area_id = ? AND committed_at_ms >= ?) - 1,
        (SELECT COALESCE(MAX(seq), 0) FROM note_change_journal WHERE area_id = ?)) AS n`);
    const raise = db.prepare(
      "UPDATE note_journal_floors SET floor_seq = ?, revision = revision + 1 WHERE area_id = ?");
    const select = db.prepare(
      "SELECT seq FROM note_change_journal WHERE area_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?");
    const remove = db.prepare("DELETE FROM note_change_journal WHERE area_id = ? AND seq = ?");
    let areas = 0;
    let deleted = 0;
    for (const row of floors) {
      if (!Number.isSafeInteger(row.floor_seq) || row.floor_seq < 0) return { ok: false, reason: "write_failed" };
      const n = Number((candidate.get(row.area_id, cutoff, row.area_id) as { n: number }).n);
      const floor = Math.max(row.floor_seq, n);
      if (floor > row.floor_seq) {
        if (raise.run(floor, row.area_id).changes !== 1) return { ok: false, reason: "write_failed" };
        areas += 1;
      }
      let after = 0;
      for (;;) {
        const batch = select.all(row.area_id, after, floor, BATCH) as { seq: number }[];
        if (batch.length === 0) break;
        for (const r of batch) {
          if (remove.run(row.area_id, r.seq).changes !== 1) return { ok: false, reason: "write_failed" };
        }
        deleted += batch.length;
        after = batch[batch.length - 1].seq;
      }
    }
    if (!context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit({ kind: "compaction", payload: { scope: "note_journal", areas, deleted } });
    return { ok: true, areas, deleted };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }), BUSY_MS);
}
