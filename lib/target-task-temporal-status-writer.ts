/**
 * R2d.3h.1: staging-only idempotent complete/reopen command. Never called from
 * HTTP or the production store. Exactly one authenticated task is updated in a
 * pinned BEGIN IMMEDIATE transaction with an opaque receipt and journal intent.
 *
 * The request intentionally does not accept completedAtMs: the writer chooses
 * a bounded server timestamp. Reopening atomically clears that timestamp.
 */
import { createHash } from "node:crypto";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";
import {
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX,
} from "./target-store-bootstrap";
import { isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession }
  from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { fingerprint } from "./target-task-staging-writer";
import {
  checkTargetTaskWriteContract, targetTaskWriteRevision,
  validTargetTaskTitleEditPreviewRequest,
} from "./target-task-write-preflight";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA = /^[A-Za-z0-9_.:@-]{1,120}$/;

export interface TargetStagingTemporalStatusCommand {
  readonly commandId: string;
  readonly taskId: string;
  readonly status: "open" | "completed";
  /** Existing task+policy snapshot token (same CAS as title/delete). */
  readonly expectedRevision: string;
  readonly writeAreaId: string;
  readonly restoreGeneration: string;
  /** Captured personal day on completion; validated against the pinned store. */
  readonly previousWhenOn?: string|null;
  /** Undo only: exact committed completion whose before-day is restored atomically. */
  readonly undoOf?: Omit<TargetStagingTemporalStatusCommand,"undoOf">;
}
export type TargetStagingTemporalStatusResult =
  | { ok: true; replayed?: true }
  | { ok: false; reason:
      "invalid_request" | "unauthorized" | "unavailable" | "stale_revision" |
      "idempotency_conflict" | "unchanged" | "write_failed" | "session_revoked" |
      "resync_required" | "write_area_mismatch" };

const denied = (): TargetStagingTemporalStatusResult => ({ok:false,reason:"unauthorized"});
const failed = (): TargetStagingTemporalStatusResult => ({ok:false,reason:"write_failed"});

export function validTargetStagingTemporalStatusCommand(
  input: unknown,
): input is TargetStagingTemporalStatusCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const v = input as Record<string,unknown>;
  const base="commandId,expectedRevision,restoreGeneration,status,taskId,writeAreaId";
  const undo=Object.prototype.hasOwnProperty.call(v,"undoOf");
  const previous=Object.prototype.hasOwnProperty.call(v,"previousWhenOn");
  const expected=undo?base.replace("taskId,","taskId,undoOf,"):
    previous?base.replace("expectedRevision,","expectedRevision,previousWhenOn,"):base;
  if(Object.keys(v).sort().join(",")!==expected||
    (previous&&(v.status!=="completed"||
      (v.previousWhenOn!==null&&(typeof v.previousWhenOn!=="string"||
        temporalCalendarOrdinal(v.previousWhenOn)===null)))))return false;
  if(undo){
    const prior=v.undoOf;
    if(v.status!=="open"||!prior||typeof prior!=="object"||Array.isArray(prior))return false;
    const p=prior as Record<string,unknown>;
    if(!Object.prototype.hasOwnProperty.call(p,"previousWhenOn")||
      p.status!=="completed"||
      !validTargetStagingTemporalStatusCommand(p)||p.taskId!==v.taskId||
      p.writeAreaId!==v.writeAreaId||p.restoreGeneration!==v.restoreGeneration||
      p.commandId===v.commandId)return false;
  }
  return typeof v.commandId === "string" && UUID.test(v.commandId) &&
    (v.status === "open" || v.status === "completed") &&
    typeof v.writeAreaId === "string" && AREA.test(v.writeAreaId) &&
    typeof v.restoreGeneration === "string" && UUID.test(v.restoreGeneration) &&
    validTargetTaskTitleEditPreviewRequest({
      taskId:v.taskId,expectedRevision:v.expectedRevision,
    });
}

export function temporalStatusReceiptKey(
  actor: string, taskId: string, commandId: string,
): string {
  return TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify(["temporal-status-v1",actor,taskId,commandId.toLowerCase()]))
    .digest("hex");
}
export function temporalStatusReceiptDigest(
  request: TargetStagingTemporalStatusCommand,
): string {
  return createHash("sha256").update(JSON.stringify([
    "temporal-status-v1",request.taskId,request.status,request.expectedRevision,
    request.writeAreaId,request.restoreGeneration.toLowerCase(),
    ...(Object.prototype.hasOwnProperty.call(request,"previousWhenOn")
      ?[request.previousWhenOn]:[]),
    ...(request.undoOf?[temporalStatusReceiptDigest(request.undoOf)]:[]),
  ])).digest("hex");
}

export function writePreflightedTemporalTaskStatus(
  store: TargetStagingReadStore,
  credential: TargetStagingReadCredential,
  request: TargetStagingTemporalStatusCommand,
  durableSessionTokenHash?: string,
): TargetStagingTemporalStatusResult {
  if (!validTargetStagingTemporalStatusCommand(request))
    return {ok:false,reason:"invalid_request"};
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();

  return withPinnedTargetStagingWrite<TargetStagingTemporalStatusResult>(store,context=>{
    const { db, databaseFd } = context;
    const actor = verifiedActor(db,credential,true);
    if (!actor) return denied();
    const sessionLive=(): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live=lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return {ok:false,reason:"session_revoked"};
    // No receipt lookup until the request's current write permission and Area
    // contract have been checked, even on a repeated commandId.
    const contract=checkTargetTaskWriteContract(db,actor,request);
    if (contract.ok === false) return {ok:false,reason:contract.reason};
    const receipt=temporalStatusReceiptKey(actor,request.taskId,request.commandId);
    const digest=temporalStatusReceiptDigest(request);
    const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(receipt) as {value:string}|undefined;
    if (prior) return prior.value === digest
      ? {ok:true,replayed:true} : {ok:false,reason:"idempotency_conflict"};

    fingerprint(databaseFd);
    if (targetTaskWriteRevision(db,request.taskId)!==request.expectedRevision)
      return {ok:false,reason:"stale_revision"};
    const row=db.prepare("SELECT status, completed_at_ms AS completedAtMs, revision FROM tasks WHERE id=?")
      .get(request.taskId) as {status:string;completedAtMs:number|null;revision:number}|undefined;
    if (!row || (row.status!=="open" && row.status!=="completed") ||
        !Number.isSafeInteger(row.revision) || row.revision<0) return failed();
    if (row.status===request.status) return {ok:false,reason:"unchanged"};
    let restoreWhenOn:string|null=null;
    if(request.undoOf){
      const original=request.undoOf;
      const originalReceipt=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(temporalStatusReceiptKey(actor,request.taskId,original.commandId)) as
        {value:string}|undefined;
      if(originalReceipt?.value!==temporalStatusReceiptDigest(original)||
        row.revision<1||
        targetTaskWriteRevision(db,request.taskId,row.revision-1)!==original.expectedRevision)
        return {ok:false,reason:"stale_revision"};
      restoreWhenOn=original.previousWhenOn??null;
    }
    if(request.status==="completed"&&
       Object.prototype.hasOwnProperty.call(request,"previousWhenOn")){
      const plan=db.prepare(
        "SELECT when_on AS whenOn FROM personal_task_plans WHERE user_id=? AND task_id=?"
      ).get(actor,request.taskId) as {whenOn:string}|undefined;
      if((plan?.whenOn??null)!==request.previousWhenOn)
        return {ok:false,reason:"stale_revision"};
    }
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX+"%") as {n:number};
    if (existing.n>=TARGET_STAGING_MAX_RECEIPTS) return failed();
    const now=Date.now();
    if (!Number.isSafeInteger(now)||now<=0) return failed();
    const completedAtMs=request.status==="completed"?now:null;
    const written=db.prepare("UPDATE tasks SET status=?, completed_at_ms=? WHERE id=?")
      .run(request.status,completedAtMs,request.taskId);
    if (written.changes!==1) return failed();
    const next=db.prepare("SELECT revision FROM tasks WHERE id=?")
      .get(request.taskId) as {revision:number}|undefined;
    if (!next || next.revision!==row.revision+1) return failed();
    if(request.undoOf&&restoreWhenOn!==null){
      // Reconcile trigger removed the old row on completion. Its INSERT guard
      // now checks CURRENT effective Area, assignment and task status again.
      db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)")
        .run(actor,request.taskId,restoreWhenOn);
    }
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
    if (!sessionLive() || !context.stillPinned())
      return {ok:false,reason:"session_revoked"};
    // Tamper-evident, append-only audit journal. No task titles, user IDs,
    // credentials, or completion timestamp are serialized into it.
    context.commit({kind:"temporal_status",payload:{
      receiptHash:receipt.slice(TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX.length),
      revision:next.revision,completed:request.status==="completed"?1:0,
    }});
    return {ok:true};
  },denied,failed);
}
