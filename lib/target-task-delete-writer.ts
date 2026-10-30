/**
 * R2c.1 staging-only idempotent single-task delete command. Not a route, sync
 * command or production writer; the only supported entry is a session-bound
 * authority (see writePreflightedTargetTaskTitle, whose structure this follows:
 * pinned fd, BEGIN IMMEDIATE, canonical preflight inside the transaction).
 *
 * A delete never removes information silently: it inserts a permanent
 * content-free tombstone (ID, Area, revision + 1, change_seq), DELETEs the row
 * (SQLite triggers write the change_log 'tombstone' entry and advance the OLD
 * Area's cursor epoch), then records the actor's receipt and a delete audit
 * row. All of it commits or rolls back together.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  TARGET_STAGING_AUDIT_MAX_EVENTS, TARGET_STAGING_DELETE_RECEIPT_PREFIX,
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_MAX_TOMBSTONES,
} from "./target-store-bootstrap";
import {
  isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession,
} from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { fingerprint } from "./target-task-staging-writer";
import {
  checkTargetTaskWriteContract, targetTaskWriteRevision, validTargetTaskTitleEditPreviewRequest,
} from "./target-task-write-preflight";

const WRITE_AREA_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingTaskDeleteRequest {
  /** Fresh UUID for the logical command. Retries must reuse the same UUID. */
  readonly commandId: string;
  readonly taskId: string;
  /** Mandatory task + policy SHA-256 (the task detail's snapshotRevision). */
  readonly expectedRevision: string;
  /** R2c.3: the Area the client believes it writes into (never trusted, always verified). */
  readonly writeAreaId: string;
  /** R2c.3: the restore generation the client synchronized to. */
  readonly restoreGeneration: string;
}

export type TargetStagingTaskDeleteResult =
  | { ok: true; replayed?: true }
  | { ok: false;
      reason: "invalid_request" | "unauthorized" | "unavailable" |
        "stale_revision" | "idempotency_conflict" | "write_failed" | "session_revoked" |
        "resync_required" | "write_area_mismatch" };

/** Verification of an uncertain delete response; never authorizes a retry. */
export type TargetStagingTaskDeleteStatusResult =
  | { ok: true; status: "committed" | "not_recorded" }
  | { ok: false; reason: "invalid_request" | "unauthorized" | "unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch" };

const denied = (): TargetStagingTaskDeleteResult => ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingTaskDeleteResult => ({ ok: false, reason: "write_failed" });

export function validTargetStagingTaskDeleteRequest(
  value: unknown,
): value is TargetStagingTaskDeleteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "commandId,expectedRevision,restoreGeneration,taskId,writeAreaId" ||
      typeof input.commandId !== "string" || !COMMAND_ID.test(input.commandId)) return false;
  if (typeof input.writeAreaId !== "string" || !WRITE_AREA_ID.test(input.writeAreaId) ||
      typeof input.restoreGeneration !== "string" ||
      !COMMAND_ID.test(input.restoreGeneration)) return false;
  return typeof input.expectedRevision === "string" &&
    validTargetTaskTitleEditPreviewRequest({
      taskId: input.taskId, expectedRevision: input.expectedRevision,
    });
}

/**
 * Opaque actor- and task-scoped command key in its own metadata namespace, so a
 * delete receipt can never be confused with (or replayed as) a title receipt.
 */
export function targetTaskDeleteReceiptKey(actor: string, taskId: string, commandId: string): string {
  return TARGET_STAGING_DELETE_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify([actor, taskId, commandId.toLowerCase()])).digest("hex");
}

/** Digest of the exact request semantics (task and expected revision). */
export function targetTaskDeleteReceiptDigest(request: TargetStagingTaskDeleteRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(["task-delete-v2", request.taskId, request.expectedRevision, request.writeAreaId]))
    .digest("hex");
}

/**
 * Shared by the command and its status verification: the actor's stored
 * receipt for this exact command, if any. Callers must already have proven the
 * current write right (live task, or the Area recorded by the tombstone).
 */
export function targetTaskDeleteReceiptOutcome(
  db: DatabaseSync, actor: string, request: TargetStagingTaskDeleteRequest,
): "none" | "match" | "conflict" {
  const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(targetTaskDeleteReceiptKey(actor, request.taskId, request.commandId)) as
    { value: string } | undefined;
  if (!prior) return "none";
  return prior.value === targetTaskDeleteReceiptDigest(request) ? "match" : "conflict";
}

/**
 * Read-only reconciliation inside an authenticated snapshot. Access needs the
 * CURRENT write right in the task's Area, or (task gone) in the Area its
 * tombstone records, plus the actor's own receipt: everything else, including
 * a tombstone nobody of this actor deleted, is the same "unavailable" as a
 * missing task. "committed" acknowledges the original command only.
 */
export function verifyTargetTaskDeleteCommand(
  db: DatabaseSync, actor: string, request: TargetStagingTaskDeleteRequest, privateOnly = false,
): TargetStagingTaskDeleteStatusResult {
  // R2c.3 contract first (generation, write access, writeAreaId right, Area match).
  const contract = checkTargetTaskWriteContract(db, actor, request, privateOnly, true);
  if (contract.ok === false) return { ok: false, reason: contract.reason };
  const target = contract.target;
  const outcome = targetTaskDeleteReceiptOutcome(db, actor, request);
  if (outcome === "conflict") return { ok: false, reason: "idempotency_conflict" };
  if (outcome === "match") return { ok: true, status: "committed" };
  return target === "live" ? { ok: true, status: "not_recorded" } : { ok: false, reason: "unavailable" };
}

/**
 * `durableSessionTokenHash` binds the mutation to a durable staging session
 * (R2-ID.1) whose row, expiry and identity epoch are verified INSIDE the write
 * transaction, before any change and again immediately before COMMIT.
 */
export function deletePreflightedTargetTask(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDeleteRequest,
  privateOnly = false,
  durableSessionTokenHash?: string,
): TargetStagingTaskDeleteResult {
  if (!validTargetStagingTaskDeleteRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();
  return withPinnedTargetStagingWrite<TargetStagingTaskDeleteResult>(store, context => {
    const { db, databaseFd } = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    const sessionLive = (): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live = lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    // Write right on the live task, or (retry after success) on the Area a
    // tombstone records, with the actor's CURRENT role. Missing, viewer,
    // non-member and foreign-private are one "unavailable".
    // R2c.3: generation, write access, writeAreaId right and Area match first.
    const contract = checkTargetTaskWriteContract(db, actor, request, privateOnly, true);
    if (contract.ok === false) return { ok: false, reason: contract.reason };
    const target = contract.target;
    const receiptKey = targetTaskDeleteReceiptKey(actor, request.taskId, request.commandId);
    const receiptDigest = targetTaskDeleteReceiptDigest(request);
    const outcome = targetTaskDeleteReceiptOutcome(db, actor, request);
    if (outcome !== "none") {
      return outcome === "match"
        ? { ok: true, replayed: true }
        : { ok: false, reason: "idempotency_conflict" };
    }
    // A tombstoned ID without this actor's receipt is not theirs to learn about.
    if (target === "tombstone") return { ok: false, reason: "unavailable" };
    fingerprint(databaseFd);
    if (targetTaskWriteRevision(db, request.taskId) !== request.expectedRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    const before = db.prepare(`
      SELECT t.revision AS revision, a.id AS area_id, a.policy_revision AS policy_revision
        FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
        JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
       WHERE t.id=?
    `).get(request.taskId) as { revision: number; area_id: string; policy_revision: number } | undefined;
    if (!before) return failed();
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    // Capacity fails closed before anything is written.
    const count = (sql: string, ...args: string[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    if (count("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
          TARGET_STAGING_DELETE_RECEIPT_PREFIX + "%") >= TARGET_STAGING_MAX_RECEIPTS ||
        count("SELECT COUNT(*) AS n FROM task_delete_audit") >= TARGET_STAGING_AUDIT_MAX_EVENTS ||
        count("SELECT COUNT(*) AS n FROM task_tombstones") >= TARGET_STAGING_MAX_TOMBSTONES) return failed();
    const committedAt = Date.now();
    if (!Number.isSafeInteger(committedAt) || committedAt <= 0) return failed();

    // The tombstone's change_seq is the exact next log sequence (verified again
    // by task_tombstones_consistency); the DELETE's trigger then logs it under
    // that very sequence. Read back below, never assumed.
    const nextSeq = Number((db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM change_log")
      .get() as { n: number }).n);
    const tombstoneRevision = before.revision + 1;
    db.prepare(`INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms)
      VALUES (?,?,?,?,?)`).run(request.taskId, before.area_id, tombstoneRevision, nextSeq, committedAt);
    if (db.prepare("DELETE FROM tasks WHERE id=?").run(request.taskId).changes !== 1) return failed();
    const logged = db.prepare(`SELECT seq, area_id, revision FROM change_log
      WHERE entity_kind='task' AND entity_id=? AND op='tombstone'`)
      .all(request.taskId) as { seq: number; area_id: string; revision: number }[];
    const stored = db.prepare("SELECT change_seq, area_id, revision FROM task_tombstones WHERE id=?")
      .get(request.taskId) as { change_seq: number; area_id: string; revision: number } | undefined;
    if (logged.length !== 1 || !stored || logged[0].seq !== nextSeq ||
        stored.change_seq !== nextSeq || logged[0].area_id !== before.area_id ||
        stored.area_id !== before.area_id || logged[0].revision !== tombstoneRevision ||
        stored.revision !== tombstoneRevision) return failed();

    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receiptKey, receiptDigest);
    // Content-free: no title or credential material enters the audit trail.
    db.prepare(`
      INSERT INTO task_delete_audit(
        receipt_key, actor_user_id, task_id, area_id, policy_revision,
        revision_before, tombstone_revision, change_seq, expected_revision,
        restore_generation, committed_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      receiptKey, actor, request.taskId, before.area_id, before.policy_revision,
      before.revision, tombstoneRevision, nextSeq, request.expectedRevision,
      store.expectedRestoreGeneration, committedAt,
    );
    // Linearization point, still inside BEGIN IMMEDIATE: a session revoked or
    // expired while the command ran rolls back tombstone, delete, log entry,
    // receipt and audit together.
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    context.commit();
    return { ok: true };
  }, denied, failed);
}
