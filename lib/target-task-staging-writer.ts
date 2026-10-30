/**
 * R2 staging-only single-task title mutation. Not a route, sync command or
 * production writer; the only supported entry is a session-bound authority.
 *
 * The pinned-fd open (no-follow source fd, exactly one newly opened regular
 * file descriptor matching that inode, BEGIN IMMEDIATE, in-transaction canonical
 * preflight) lives in the shared lib/target-staging-pinned-write.ts together
 * with its staging-only limits: it is not a production-safe fd-backed VFS.
 * BEGIN IMMEDIATE serializes writers across revision, ACL and UPDATE.
 * Any failure rolls back; a preview is never a write authorization capability.
 */
import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import {
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_AUDIT_MAX_EVENTS,
  TARGET_STAGING_RECEIPT_PREFIX,
} from "./target-store-bootstrap";
import {
  isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession,
} from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import {
  checkTargetTaskWriteContract, targetTaskTitleEditRevision,
  validTargetTaskTitleEditPreviewRequest,
} from "./target-task-write-preflight";

const CHUNK_BYTES = 64 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_TITLE_LENGTH = 4096;
const WRITE_AREA_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingTaskTitleWriteRequest {
  /** Fresh UUID for the logical command. Retries must reuse the same UUID. */
  readonly commandId: string;
  readonly taskId: string;
  readonly title: string;
  /** Mandatory task + policy SHA-256 returned by the staging preview. */
  readonly expectedRevision: string;
  /** R2c.3: the Area the client believes it writes into (never trusted, always verified). */
  readonly writeAreaId: string;
  /** R2c.3: the restore generation the client synchronized to. */
  readonly restoreGeneration: string;
}

export type TargetStagingTaskTitleWriteResult =
  | { ok: true; replayed?: true }
  | { ok: false;
      reason: "invalid_request" | "unauthorized" | "unavailable" |
        "stale_revision" | "unchanged" | "idempotency_conflict" | "write_failed" |
        "session_revoked" | "resync_required" | "write_area_mismatch" };

const denied = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "write_failed" });

export function validTargetStagingTaskTitleWriteRequest(
  value: unknown,
): value is TargetStagingTaskTitleWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "commandId,expectedRevision,restoreGeneration,taskId,title,writeAreaId" ||
      typeof input.commandId !== "string" || !COMMAND_ID.test(input.commandId)) return false;
  if (typeof input.writeAreaId !== "string" || !WRITE_AREA_ID.test(input.writeAreaId) ||
      typeof input.restoreGeneration !== "string" ||
      !COMMAND_ID.test(input.restoreGeneration)) return false;
  if (typeof input.expectedRevision !== "string" ||
      !validTargetTaskTitleEditPreviewRequest({
        taskId: input.taskId, expectedRevision: input.expectedRevision,
      })) return false;
  return typeof input.title === "string" &&
    input.title.length > 0 && input.title.length <= MAX_TITLE_LENGTH &&
    input.title.trim().length > 0 && input.title.trim() === input.title &&
    !input.title.includes("\0");
}

/**
 * Opaque actor- and task-scoped command key. One command UUID is unique for
 * one actor/task pair, so a revoked task's receipt cannot be queried by
 * replacing its taskId with another editable task.
 *
 * The v2 namespace prevents unsafe reuse of the old actor-only receipts.
 */
export function targetTaskTitleReceiptKey(actor: string, taskId: string, commandId: string): string {
  return TARGET_STAGING_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify([actor, taskId, commandId.toLowerCase()])).digest("hex");
}

/** Digest exact request semantics, including the preview revision. */
export function targetTaskTitleReceiptDigest(request: TargetStagingTaskTitleWriteRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.taskId, request.title, request.expectedRevision]))
    .digest("hex");
}


export function fingerprint(fd: number): string {
  const before = fstatSync(fd);
  if (!before.isFile() || !Number.isSafeInteger(before.size) ||
      before.size < 100 || before.size > MAX_DATABASE_BYTES) {
    throw new Error("Invalid staging database size");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let offset = 0;
  while (offset < before.size) {
    const count = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, before.size - offset), offset);
    if (count <= 0) throw new Error("Short staging database read");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(fd);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs) throw new Error("Staging file changed");
  return hash.digest("hex");
}


/**
 * This is a deliberately isolated staging file writer, not a production VFS.
 * The caller cannot supply a DatabaseSync, file descriptor, actor or revision
 * fingerprint. Everything is established within this synchronous boundary by
 * the shared pinned-write helper (pinned fd, BEGIN IMMEDIATE, canonical preflight).
 *
 * `durableSessionTokenHash` (R2-ID.1) additionally binds the mutation to a
 * durable staging session. Its row, expiry and identity epoch are verified
 * INSIDE the write transaction, both before any change and again immediately
 * before COMMIT, so a session revoked at any earlier point writes nothing.
 */
export function writePreflightedTargetTaskTitle(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskTitleWriteRequest,
  privateOnly = false,
  durableSessionTokenHash?: string,
): TargetStagingTaskTitleWriteResult {
  if (!validTargetStagingTaskTitleWriteRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();
  return withPinnedTargetStagingWrite<TargetStagingTaskTitleWriteResult>(store, context => {
    const { db, databaseFd } = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    // The live session must still exist for this very actor. Anything else,
    // including a session of a different user, voids the whole command.
    const sessionLive = (): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live = lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    // R2c.3 contract, before any receipt lookup, CAS or mutation.
    const contract = checkTargetTaskWriteContract(db, actor, request, privateOnly);
    if (contract.ok === false) return { ok: false, reason: contract.reason };
    // Persist the receipt in the *same transaction* as the UPDATE. The actor
    // and operation UUID are hashed into the key; only a request digest is
    // stored (never the title or task content). Replays are checked after the
    // current ACL, but before optimistic revision staleness.
    const receiptKey = targetTaskTitleReceiptKey(actor, request.taskId, request.commandId);
    const receiptDigest = targetTaskTitleReceiptDigest(request);
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(receiptKey) as { value: string } | undefined;
    if (prior) {
      return prior.value === receiptDigest
        ? { ok: true, replayed: true }
        : { ok: false, reason: "idempotency_conflict" };
    }
    // Keep the pinned-source read/identity check; unrelated SQLite changes
    // must not invalidate this task's optimistic CAS.
    fingerprint(databaseFd);
    if (targetTaskTitleEditRevision(db, request.taskId) !== request.expectedRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    // SQLite can count an UPDATE of the existing value as one changed row
    // without advancing the byte fingerprint. Never report such a no-op as
    // a successful mutation (revisions are optimistic checks, not one-shot IDs).
    const before = db.prepare(`
      SELECT t.title AS title, t.revision AS revision,
             a.id AS area_id, a.policy_revision AS policy_revision
        FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
        JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
       WHERE t.id=?
    `).get(request.taskId) as
      { title: string; revision: number; area_id: string; policy_revision: number } | undefined;
    if (!before) return failed();
    if (before.title === request.title) return { ok: false, reason: "unchanged" };
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const receiptCount = db.prepare(
      "SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
    ).get(TARGET_STAGING_RECEIPT_PREFIX + "%") as { n: number };
    if (receiptCount.n >= TARGET_STAGING_MAX_RECEIPTS) return failed();
    const auditCount = db.prepare("SELECT COUNT(*) AS n FROM task_title_audit")
      .get() as { n: number };
    // A full audit ledger fails closed. No row is silently discarded or written
    // without a matching receipt; archival/purge is a separate staging action.
    if (auditCount.n >= TARGET_STAGING_AUDIT_MAX_EVENTS) return failed();
    const committedAt = Date.now();
    if (!Number.isSafeInteger(committedAt) || committedAt <= 0) return failed();
    const updated = db.prepare("UPDATE tasks SET title=? WHERE id=?")
      .run(request.title, request.taskId);
    if (updated.changes !== 1) return failed();
    const after = db.prepare("SELECT revision FROM tasks WHERE id=?")
      .get(request.taskId) as { revision: number } | undefined;
    if (!after || after.revision !== before.revision + 1) return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
      .run(receiptKey, receiptDigest);
    // No task titles or credential material enter the durable audit trail.
    // All three changes commit or roll back together.
    db.prepare(`
      INSERT INTO task_title_audit(
        receipt_key, actor_user_id, task_id, area_id, policy_revision,
        revision_before, revision_after, expected_revision,
        restore_generation, committed_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      receiptKey, actor, request.taskId, before.area_id, before.policy_revision,
      before.revision, after.revision, request.expectedRevision,
      store.expectedRestoreGeneration, committedAt,
    );
    // Linearization point of the write: still inside BEGIN IMMEDIATE, so no
    // revocation can interleave between this check and COMMIT. A session which
    // expired while the command ran rolls back task, receipt and audit together.
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    // R2c.4a journal entry: content-free (the change_log sequence range is added by the helper).
    context.commit({ kind: "title", payload: {} });
    return { ok: true };
  }, denied, failed);
}
