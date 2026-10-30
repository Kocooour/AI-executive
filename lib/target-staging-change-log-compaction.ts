/**
 * R2c.2b staging-only, OPERATOR-ONLY change-log compaction (no HTTP endpoint; see
 * scripts/target-staging-compact-change-log.mjs). Reuses the pinned-fd +
 * BEGIN IMMEDIATE write helper, whose canonical preflight runs inside the
 * transaction before this body.
 *
 * The new floor is the newest sequence committed before `now - retentionDays`
 * (never lower than the current floor). Rows at or below it are then deleted
 * only where a later row of the same key also lies at or below the floor, so the
 * last row <= floor of every key and everything above the floor survive; the
 * schema's guarded-delete trigger enforces exactly that, even for direct SQL.
 * Feed cursors behind the floor answer 409 resync_required.
 */
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
  | { ok: false; reason: "invalid_request" | "unavailable" | "write_failed" };

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
  return withPinnedTargetStagingWrite<TargetStagingChangeLogCompaction>(store, context => {
    const { db } = context;
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const current = Number((db.prepare("SELECT value FROM metadata WHERE key='change_log_floor'")
      .get() as { value: string } | undefined)?.value);
    if (!Number.isSafeInteger(current) || current < 0) return { ok: false, reason: "write_failed" };
    const candidate = Number((db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS n FROM change_log WHERE committed_at_ms < ?",
    ).get(cutoff) as { n: number }).n);
    const floor = Math.max(current, candidate);
    if (floor > current) {
      const raised = db.prepare("UPDATE metadata SET value = ? WHERE key = 'change_log_floor'")
        .run(String(floor));
      if (raised.changes !== 1) return { ok: false, reason: "write_failed" };
    }
    // Superseded rows only: a later row of the same key at or below the floor exists
    // (the trigger re-checks this for every row). Bounded batches, one transaction.
    const select = db.prepare(`SELECT c.seq AS seq FROM change_log c WHERE c.seq <= ? AND EXISTS (
        SELECT 1 FROM change_log x WHERE x.entity_kind = c.entity_kind AND x.entity_id = c.entity_id
          AND x.member_user_id IS c.member_user_id AND x.seq > c.seq AND x.seq <= ?)
      ORDER BY c.seq LIMIT ?`);
    const remove = db.prepare("DELETE FROM change_log WHERE seq = ?");
    let deleted = 0;
    for (;;) {
      const batch = select.all(floor, floor, BATCH) as { seq: number }[];
      if (batch.length === 0) break;
      for (const row of batch) {
        if (remove.run(row.seq).changes !== 1) return { ok: false, reason: "write_failed" };
      }
      deleted += batch.length;
    }
    if (!context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit();
    return { ok: true, floor, deleted };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }), BUSY_MS);
}
