/**
 * R3-BE-4c (core only): create ONE standalone task in the current actor's
 * PRIVATE Area. This is intentionally NOT an HTTP route, client command or
 * production enablement. Only a trusted server-issued write audience may enter.
 *
 * Every identity, restore-generation, Area boundary, receipt and ID-reuse
 * decision is made under the staging pinned BEGIN IMMEDIATE write transaction.
 * A request never provides an actor, workspace, parent project or sharing hint.
 */
import { createHash } from "node:crypto";
import { fingerprint } from "./target-task-staging-writer";
import {
  isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession,
} from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor, type TargetStagingReadCredential } from "./target-task-authenticated-read";
import { canWriteIsolatedTargetArea } from "./target-task-write-preflight";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import {
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_AUDIT_MAX_EVENTS,
  TARGET_STAGING_PRIVATE_TASK_CREATE_RECEIPT_PREFIX,
} from "./target-store-bootstrap";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA = /^[A-Za-z0-9_.:@-]{1,120}$/;
export const PRIVATE_TASK_CREATE_RECEIPT_PREFIX = TARGET_STAGING_PRIVATE_TASK_CREATE_RECEIPT_PREFIX;

export interface PrivateTaskCreateCommand {
  readonly taskId: string;
  readonly commandId: string;
  readonly areaId: string;
  readonly restoreGeneration: string;
  readonly title: string;
}
export type PrivateTaskCreateResult =
  | { ok: true; replayed?: true }
  | { ok: false; reason: "invalid_request" | "unauthorized" | "unavailable" |
      "resync_required" | "idempotency_conflict" | "session_revoked" | "write_failed" };

export function validPrivateTaskCreateCommand(value: unknown): value is PrivateTaskCreateCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).sort().join(",") ===
      "areaId,commandId,restoreGeneration,taskId,title" &&
    typeof r.taskId === "string" && UUID.test(r.taskId) &&
    // SQLite stores task IDs as case-sensitive TEXT. Reject aliases of the
    // same logical UUID at this CREATE boundary, including after deletion.
    r.taskId === r.taskId.toLowerCase() &&
    typeof r.commandId === "string" && UUID.test(r.commandId) &&
    typeof r.areaId === "string" && AREA.test(r.areaId) &&
    typeof r.restoreGeneration === "string" && UUID.test(r.restoreGeneration) &&
    typeof r.title === "string" && r.title.length > 0 &&
    r.title.trim() === r.title && r.title.trim().length > 0 &&
    r.title.isWellFormed() && Buffer.byteLength(r.title, "utf8") <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(r.title);
}
function receiptKey(actor: string, r: PrivateTaskCreateCommand): string {
  return PRIVATE_TASK_CREATE_RECEIPT_PREFIX + createHash("sha256").update(
    JSON.stringify([actor, r.commandId.toLowerCase()]),
  ).digest("hex");
}
function receiptDigest(r: PrivateTaskCreateCommand): string {
  return createHash("sha256").update(JSON.stringify([
    "private-task-create-v1", r.taskId.toLowerCase(), r.areaId,
    r.restoreGeneration.toLowerCase(), r.title,
  ])).digest("hex");
}
const denied = (): PrivateTaskCreateResult => ({ ok: false, reason: "unauthorized" });
const failed = (): PrivateTaskCreateResult => ({ ok: false, reason: "write_failed" });

export function createPreflightedPrivateTask(
  store: TargetStagingReadStore,
  credential: TargetStagingReadCredential,
  request: PrivateTaskCreateCommand,
  durableSessionTokenHash?: string,
): PrivateTaskCreateResult {
  if (!validPrivateTaskCreateCommand(request)) return {ok:false, reason:"invalid_request"};
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();

  return withPinnedTargetStagingWrite<PrivateTaskCreateResult>(store, context => {
    const { db, databaseFd } = context;
    const actor = verifiedActor(db, credential, true);
    if (!actor) return denied();

    const sessionLive = (): boolean => durableSessionTokenHash === undefined ||
      lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now())?.userId === actor;
    if (!sessionLive()) return {ok:false, reason:"session_revoked"};

    const generation = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as {value:string}|undefined)?.value;
    if (!generation || generation.toLowerCase() !== request.restoreGeneration.toLowerCase() ||
        generation.toLowerCase() !== store.expectedRestoreGeneration.toLowerCase())
      return {ok:false, reason:"resync_required"};

    // Both the Area kind and owner identity are established from the live DB.
    // Shared, foreign, missing and structurally mismatched Areas are identical.
    if (!canWriteIsolatedTargetArea(db, actor, request.areaId, true))
      return {ok:false, reason:"unavailable"};
    const key = receiptKey(actor, request), digest = receiptDigest(request);
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as {value:string}|undefined;
    if (prior) {
      // The receipt key is actor+COMMAND (not actor+task+command): recycling
      // a command UUID with a different task ID can never create two tasks.
      // Its exact digest is checked before considering whether the original
      // task is still present in this actor's private Area.
      if (prior.value !== digest) return {ok:false,reason:"idempotency_conflict"};
      // Never acknowledge a creation after its task was deleted, transferred,
      // or became invisible. Receipts alone are not live write authority.
      const item = db.prepare(
        "SELECT id,area_id,project_id FROM tasks WHERE id=? COLLATE NOCASE",
      ).get(request.taskId) as {id:string;area_id:string|null;project_id:string|null}|undefined;
      if (!item || item.id !== request.taskId ||
          item.area_id !== request.areaId || item.project_id !== null)
        return {ok:false,reason:"unavailable"};
      return {ok:true,replayed:true};
    }
    // No task-ID reuse or overwrite, even after a tombstone. Do not disclose
    // which of an existing task or foreign tombstone caused the denial.
    const used = db.prepare(
      // Reject pre-existing legacy/mixed-case ID aliases as well, because older
      // writers may have stored UUID text without canonical casing.
      "SELECT 1 AS ok FROM tasks WHERE id=? COLLATE NOCASE UNION ALL SELECT 1 AS ok FROM task_tombstones WHERE id=? COLLATE NOCASE LIMIT 1",
    ).get(request.taskId,request.taskId);
    if (used) return {ok:false,reason:"unavailable"};
    const receipts = (db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(PRIVATE_TASK_CREATE_RECEIPT_PREFIX+"%") as {n:number}).n;
    const events = (db.prepare("SELECT COUNT(*) AS n FROM change_log")
      .get() as {n:number}).n;
    if (!Number.isSafeInteger(receipts) || receipts >= TARGET_STAGING_MAX_RECEIPTS ||
        !Number.isSafeInteger(events) || events >= TARGET_STAGING_AUDIT_MAX_EVENTS)
      return failed();

    fingerprint(databaseFd);
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const inserted = db.prepare(
      "INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)",
    ).run(request.taskId,request.areaId,request.title);
    if (inserted.changes !== 1) return failed();
    const row = db.prepare(
      "SELECT revision,status,project_id,area_id FROM tasks WHERE id=?",
    ).get(request.taskId) as {
      revision:number;status:string;project_id:string|null;area_id:string|null;
    }|undefined;
    if (!row || row.revision !== 0 || row.status !== "open" ||
        row.project_id !== null || row.area_id !== request.areaId) return failed();
    // No content is stored in the receipt, journal or downstream task change log.
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key,digest);
    if (!sessionLive() || !context.stillPinned()) return {ok:false,reason:"session_revoked"};
    // Atomic SQLite commit / content-free external anchor journal boundary.
    // A false post-commit confirm means the client must reconcile; never claim
    // a definitely successful operation without its verified journal.
    if (!context.commit({kind:"task_create", payload:{}})) return failed();
    return {ok:true};
  }, denied, failed);
}
