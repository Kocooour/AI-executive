/**
 * R2c.2b staging-only, OPERATOR-ONLY change-log compaction (no HTTP endpoint; see
 * scripts/target-staging-compact-change-log.mjs). Reuses the pinned-fd +
 * BEGIN IMMEDIATE write helper, whose canonical preflight runs inside the
 * transaction before this body.
 *
 * The new floor is MIN(seq committed at or after `now - retentionDays`) - 1, or
 * MAX(seq) when no row is that recent, and never lower than the current floor. Rows at or below it are then deleted
 * only where a later row of the same key also lies at or below the floor, so the
 * last row <= floor of every key and everything above the floor survive; the
 * schema's guarded-delete trigger enforces exactly that, even for direct SQL.
 * Feed cursors behind the floor answer 409 resync_required.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { TARGET_STORE_FILENAME } from "./target-store-bootstrap";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

/** Proposed default; the owner decides it in PR review. */
export const TARGET_STAGING_CHANGE_LOG_DEFAULT_RETENTION_DAYS = 30;
export const TARGET_STAGING_CHANGE_LOG_MIN_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const BATCH = 1000;
const BUSY_MS = 5_000;

export type TargetStagingChangeLogCompaction =
  | { ok: true; floor: number; deleted: number }
  | { ok: false; reason: "invalid_request" | "journal_present" | "unavailable" | "write_failed" };

export function compactTargetStagingChangeLog(
  store: TargetStagingReadStore,
  options: { retentionDays: number; now: number },
): TargetStagingChangeLogCompaction {
  const { retentionDays, now } = options ?? ({} as { retentionDays: number; now: number });
  if (!Number.isSafeInteger(retentionDays) || retentionDays < TARGET_STAGING_CHANGE_LOG_MIN_RETENTION_DAYS ||
      retentionDays > 36_500 || !Number.isSafeInteger(now) || now <= 0) {
    return { ok: false, reason: "invalid_request" };
  }
  const cutoff = now - retentionDays * DAY_MS;
  // A hot rollback journal (e.g. after a killed compaction) makes every pinned writer
  // refuse; report it distinctly so the operator runbook (ARCHITECTURE R2c.2b) applies.
  try {
    if (typeof store?.stagingDirectory === "string") {
      lstatSync(path.join(store.stagingDirectory, TARGET_STORE_FILENAME + "-journal"));
      return { ok: false, reason: "journal_present" };
    }
  } catch { /* no journal: the normal path */ }
  return withPinnedTargetStagingWrite<TargetStagingChangeLogCompaction>(store, context => {
    const { db } = context;
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const current = Number((db.prepare("SELECT value FROM metadata WHERE key='change_log_floor'")
      .get() as { value: string } | undefined)?.value);
    if (!Number.isSafeInteger(current) || current < 0) return { ok: false, reason: "write_failed" };
    // Rows still within retention are never compacted, even if commit times are not
    // monotonic (clock steps): the floor stops just before the FIRST row newer than the cutoff.
    const candidate = Number((db.prepare(`SELECT COALESCE(
        (SELECT MIN(seq) FROM change_log WHERE committed_at_ms >= ?) - 1,
        (SELECT COALESCE(MAX(seq), 0) FROM change_log)) AS n`).get(cutoff) as { n: number }).n);
    const floor = Math.max(current, candidate);
    if (floor > current) {
      const raised = db.prepare("UPDATE metadata SET value = ? WHERE key = 'change_log_floor'")
        .run(String(floor));
      if (raised.changes !== 1) return { ok: false, reason: "write_failed" };
    }
    // Superseded rows only: a later row of the same key at or below the floor exists (the
    // trigger re-checks this for every row). The probe seeks the full key in change_log_by_key
    // (membership rows share the Area as entity_id, so the member column must be part of the
    // seek) and progresses by sequence, so the work is linear in the log. One transaction,
    // bounded batches.
    const select = db.prepare(`SELECT c.seq AS seq FROM change_log c WHERE c.seq > ? AND c.seq <= ? AND EXISTS (
        SELECT 1 FROM change_log x INDEXED BY change_log_by_key
         WHERE x.entity_kind = c.entity_kind AND x.entity_id = c.entity_id
           AND x.member_user_id IS c.member_user_id AND x.seq > c.seq AND x.seq <= ?)
      ORDER BY c.seq LIMIT ?`);
    const remove = db.prepare("DELETE FROM change_log WHERE seq = ?");
    let deleted = 0;
    let after = 0;
    for (;;) {
      const batch = select.all(after, floor, floor, BATCH) as { seq: number }[];
      if (batch.length === 0) break;
      for (const row of batch) {
        if (remove.run(row.seq).changes !== 1) return { ok: false, reason: "write_failed" };
      }
      deleted += batch.length;
      after = batch[batch.length - 1].seq;
    }
    if (!context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit();
    return { ok: true, floor, deleted };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }), BUSY_MS);
}
