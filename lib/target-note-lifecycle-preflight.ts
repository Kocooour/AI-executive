/**
 * v19 note lifecycle journal preflight. Pure, content-free SELECTs on the
 * same canonical pinned snapshot as the existing staging preflight.
 * A raw mutation without an authenticated audit remains a witness gap and
 * can only trigger an Area rebootstrap, never a trusted incremental event.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  TARGET_STAGING_AUDIT_MAX_EVENTS,
  TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX,
} from "./target-store-bootstrap";

const SHA = /^[0-9a-f]{64}$/;

export function verifyTargetNoteLifecycleJournal(db: DatabaseSync): boolean {
  try {
    const counts = (sql: string): number =>
      Number((db.prepare(sql).get() as { n: number }).n);
    const audits = db.prepare("SELECT receipt_key,restore_generation FROM note_lifecycle_audit")
      .all() as { receipt_key: unknown; restore_generation: unknown }[];
    if (audits.length > TARGET_STAGING_AUDIT_MAX_EVENTS) return false;
    const generation = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined)?.value;
    const history = db.prepare("SELECT previous_generation FROM restore_generations")
      .all() as { previous_generation: string }[];
    const generations = new Set([generation, ...history.map(h => h.previous_generation)]);
    for (const a of audits) {
      if (typeof a.receipt_key !== "string" ||
        !a.receipt_key.startsWith(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX) ||
        !SHA.test(a.receipt_key.slice(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX.length)) ||
        !generations.has(a.restore_generation as string) ||
        !db.prepare("SELECT 1 FROM metadata WHERE key=?").get(a.receipt_key)) return false;
    }
    const invalidAudit = [
      "SELECT COUNT(*) AS n FROM note_lifecycle_audit a",
      "LEFT JOIN notes n ON n.id=a.note_id",
      "LEFT JOIN note_tombstones t ON t.id=a.note_id",
      "LEFT JOIN areas dest ON dest.id=a.area_id",
      "LEFT JOIN areas source ON source.id=a.old_area_id",
      "WHERE (n.id IS NULL AND t.id IS NULL) OR dest.id IS NULL",
      "OR (a.kind='move' AND source.id IS NULL) OR a.kind NOT IN ('create','move')",
      // Policy epochs may advance after an immutable event, never regress.
      "OR typeof(a.policy_revision)<>'integer' OR a.policy_revision<0",
      "OR dest.policy_revision<a.policy_revision",
      "OR typeof(a.revision_after)<>'integer' OR a.revision_after<0",
      "OR (a.kind='create' AND (a.old_area_id IS NOT NULL OR a.old_project_id IS NOT NULL",
      " OR a.old_policy_revision IS NOT NULL",
      " OR a.revision_before IS NOT NULL OR a.revision_after<>0))",
      "OR (a.kind='move' AND (a.old_area_id IS NULL OR a.revision_before IS NULL",
      " OR typeof(a.old_policy_revision)<>'integer' OR a.old_policy_revision<0",
      " OR source.policy_revision<a.old_policy_revision",
      " OR a.revision_after<>a.revision_before+1",
      " OR (a.old_area_id=a.area_id AND a.old_project_id IS a.project_id)))",
      "OR (n.id IS NOT NULL AND n.revision<a.revision_after)",
      "OR (t.id IS NOT NULL AND t.revision<=a.revision_after)",
      "OR typeof(a.committed_at_ms)<>'integer' OR a.committed_at_ms<=0",
    ].join(" ");
    // Bound parameters: never concatenate a receipt prefix into SQL literals.
    const orphan = db.prepare(
      "SELECT COUNT(*) AS n FROM metadata m WHERE substr(m.key,1,?)=? " +
      "AND NOT EXISTS(SELECT 1 FROM note_lifecycle_audit a WHERE a.receipt_key=m.key)",
    ).get(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX.length,
      TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX) as { n: number };
    if (counts(invalidAudit) !== 0 || orphan.n !== 0) return false;
    const invalidJournal = [
      "SELECT COUNT(*) AS n FROM note_change_journal j",
      "LEFT JOIN note_lifecycle_audit a ON",
      "(j.kind='upsert' AND j.receipt_key=a.receipt_key) OR",
      "(j.kind='leave' AND j.receipt_key=a.receipt_key||':leave')",
      "WHERE j.kind IN ('upsert','leave') AND (a.id IS NULL",
      "OR j.note_id IS NOT a.note_id OR j.actor_user_id IS NOT a.actor_user_id",
      "OR j.committed_at_ms IS NOT a.committed_at_ms",
      "OR j.revision IS NOT a.revision_after",
      "OR (j.kind='upsert' AND (j.area_id IS NOT a.area_id",
      " OR j.project_id IS NOT a.project_id",
      " OR j.parent_revision IS NOT a.parent_revision",
      " OR j.policy_revision IS NOT a.policy_revision))",
      "OR (j.kind='leave' AND (a.kind<>'move'",
      " OR a.old_area_id=a.area_id OR j.area_id IS NOT a.old_area_id",
      " OR j.project_id IS NOT a.old_project_id OR j.parent_revision IS NOT NULL",
      " OR j.policy_revision IS NOT a.old_policy_revision)))",
    ].join(" ");
    // A journal row absent for an audit is legitimate only when its Area's journal was
    // compacted (floor > 0); the main preflight reconciles the exact count with the floor.
    const floorOf = (area: string) =>
      `COALESCE((SELECT f.floor_seq FROM note_journal_floors f WHERE f.area_id=${area}),0)`;
    const missingJournal = [
      "SELECT COUNT(*) AS n FROM note_lifecycle_audit a",
      "LEFT JOIN note_change_journal up ON up.kind='upsert'",
      " AND up.receipt_key=a.receipt_key",
      "LEFT JOIN note_change_journal lv ON lv.kind='leave'",
      " AND lv.receipt_key=a.receipt_key||':leave'",
      `WHERE (up.seq IS NULL AND ${floorOf("a.area_id")}=0) OR up.area_id<>a.area_id`,
      "OR (a.kind='move' AND a.old_area_id<>a.area_id",
      ` AND ((lv.seq IS NULL AND ${floorOf("a.old_area_id")}=0) OR lv.area_id<>a.old_area_id))`,
      "OR ((a.kind='create' OR a.old_area_id=a.area_id) AND lv.seq IS NOT NULL)",
    ].join(" ");
    return counts(invalidJournal) === 0 && counts(missingJournal) === 0;
  } catch {
    return false;
  }
}
