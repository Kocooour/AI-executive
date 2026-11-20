/**
 * C-3a staging-only, pinned atomic Process / Undo writer.
 *
 * Triage changes only task.triage_* columns, never a task's dueOn, personal
 * whenOn, project, Area, assignee or completion state. Authorization, session,
 * CAS and receipt lineage are rechecked inside BEGIN IMMEDIATE. This module is
 * not directly callable from HTTP without the same-origin identity boundary.
 */
import { createHash } from "node:crypto";
import { TARGET_INBOX_RECEIPT_RETENTION_DAYS, TARGET_INBOX_MAX_RECEIPTS } from "./target-inbox-schema";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession }
  from "./target-staging-durable-session";
import { verifiedActor,type TargetStagingReadCredential } from "./target-task-authenticated-read";
import { fingerprint } from "./target-task-staging-writer";
import {
  checkTargetTaskWriteContract,targetTaskWriteRevision,
  validTargetTaskTitleEditPreviewRequest,
} from "./target-task-write-preflight";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import type { DatabaseSync } from "node:sqlite";

export type TargetInboxTriageMode = "process" | "undo";
export interface TargetInboxTriageCommand {
  commandId:string;
  taskId:string;
  mode:TargetInboxTriageMode;
  /** Required on Undo: exact successful Process command to reverse. */
  undoOfCommandId:string|null;
  expectedRevision:string;
  expectedTriageRevision:number;
  writeAreaId:string;
  restoreGeneration:string;
}
export type TargetInboxTriageResult =
  | {ok:true; replayed?:true}
  | {ok:false; reason:"invalid_request"|"unavailable"|"resync_required"|
    "write_area_mismatch"|"session_revoked"|"stale_revision"|
    "idempotency_conflict"|"write_failed" };

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const area=/^[A-Za-z0-9_.:@-]{1,120}$/;
const sha=/^[a-f0-9]{64}$/;
const denied=():TargetInboxTriageResult=>({ok:false,reason:"unavailable"});
const failed=():TargetInboxTriageResult=>({ok:false,reason:"write_failed"});
const validEpoch=(n:unknown):n is number=>
  typeof n==="number"&&Number.isSafeInteger(n)&&n>=0&&n<9007199254740991;

export function validTargetInboxTriageCommand(value:unknown):value is TargetInboxTriageCommand{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const x=value as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
    "commandId,expectedRevision,expectedTriageRevision,mode,restoreGeneration,taskId,undoOfCommandId,writeAreaId"&&
    typeof x.commandId==="string"&&uuid.test(x.commandId)&&
    typeof x.taskId==="string"&&
    validTargetTaskTitleEditPreviewRequest({taskId:x.taskId,expectedRevision:x.expectedRevision})&&
    typeof x.expectedRevision==="string"&&sha.test(x.expectedRevision)&&
    validEpoch(x.expectedTriageRevision)&&
    typeof x.writeAreaId==="string"&&area.test(x.writeAreaId)&&
    typeof x.restoreGeneration==="string"&&uuid.test(x.restoreGeneration)&&
    (x.mode==="process"&&x.undoOfCommandId===null||
      x.mode==="undo"&&typeof x.undoOfCommandId==="string"&&
      uuid.test(x.undoOfCommandId)&&x.undoOfCommandId.toLowerCase()!==x.commandId.toLowerCase());
}
export function targetInboxTriageReceiptKey(actor:string,commandId:string):string{
  return createHash("sha256").update(
    JSON.stringify(["target-inbox-triage-v1",actor,commandId.toLowerCase()]),
  ).digest("hex");
}
export function targetInboxTriageDigest(command:TargetInboxTriageCommand):string{
  return createHash("sha256").update(JSON.stringify([
    "target-inbox-triage-v1",command.taskId,command.mode,
    command.undoOfCommandId?.toLowerCase()??null,
    command.expectedRevision,command.expectedTriageRevision,
    command.writeAreaId,command.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}
type Before={triage_state:string;triaged_at:number|null;triage_revision:number;revision:number};
type Receipt={
  request_digest:string;actor_user_id:string;task_id:string;action:string;
  restore_generation:string;triage_revision_after:number;task_revision_after:number;
  committed_at_ms:number;
};

/**
 * No writer may acknowledge "not recorded" as proof of no future commit.
 * Callers may use a receipt lookup to reconcile an uncertain response, and
 * retry the SAME UUID when the old transaction has definitely quiesced.
 * Status must be queried only with the verified actor and exact command.
 */
export function readTargetInboxTriageReceipt(
  db:DatabaseSync,actor:string,command:TargetInboxTriageCommand,
):"committed"|"not_recorded"|"conflict"|null{
  if(!validTargetInboxTriageCommand(command)||!area.test(actor))return null;
  const contract=checkTargetTaskWriteContract(db,actor,command);
  if(contract.ok===false)return null;
  try {
    const row=db.prepare("SELECT request_digest FROM task_triage_receipts WHERE receipt_key=?")
      .get(targetInboxTriageReceiptKey(actor,command.commandId)) as {request_digest:string}|undefined;
    if(!row)return "not_recorded";
    return row.request_digest===targetInboxTriageDigest(command)?"committed":"conflict";
  }catch{return null;}
}

export function writePreflightedTargetInboxTriage(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetInboxTriageCommand,durableSessionTokenHash?:string,
):TargetInboxTriageResult{
  if(!validTargetInboxTriageCommand(command))return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetInboxTriageResult>(store,context=>{
    const {db,databaseFd}=context;
    const actor=verifiedActor(db,credential,true);
    if(!actor)return denied();
    const sessionLive=():boolean=>durableSessionTokenHash===undefined||
      lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now())?.userId===actor;
    if(!sessionLive())return {ok:false,reason:"session_revoked"};
    const contract=checkTargetTaskWriteContract(db,actor,command);
    if(contract.ok===false)return {ok:false,reason:contract.reason};
    if(store.expectedRestoreGeneration.toLowerCase()!==command.restoreGeneration.toLowerCase())
      return {ok:false,reason:"resync_required"};
    const receiptKey=targetInboxTriageReceiptKey(actor,command.commandId);
    const digest=targetInboxTriageDigest(command);
    const prior=db.prepare("SELECT request_digest FROM task_triage_receipts WHERE receipt_key=?")
      .get(receiptKey) as {request_digest:string}|undefined;
    if(prior)return prior.request_digest===digest?{ok:true,replayed:true}:
      {ok:false,reason:"idempotency_conflict"};
    fingerprint(databaseFd);
    if(targetTaskWriteRevision(db,command.taskId)!==command.expectedRevision)
      return {ok:false,reason:"stale_revision"};
    const before=db.prepare(
      "SELECT triage_state,triaged_at,triage_revision,revision FROM tasks WHERE id=?",
    ).get(command.taskId) as Before|undefined;
    if(!before||!validEpoch(before.triage_revision)||!validEpoch(before.revision)||
        before.triage_revision!==command.expectedTriageRevision)
      return {ok:false,reason:"stale_revision"};
    if((command.mode==="process"&&
          (before.triage_state!=="unprocessed"||before.triaged_at!==null))||
        (command.mode==="undo"&&
          (before.triage_state!=="processed"||
            !validEpoch(before.triaged_at)||before.triaged_at<=0)))
      return {ok:false,reason:"stale_revision"};
    let originalKey:string|null=null;
    let original:Receipt|undefined;
    if(command.mode==="undo"&&command.undoOfCommandId){
      originalKey=targetInboxTriageReceiptKey(actor,command.undoOfCommandId);
      original=db.prepare(
        "SELECT request_digest,actor_user_id,task_id,action,restore_generation,"+
        "triage_revision_after,task_revision_after,committed_at_ms FROM task_triage_receipts WHERE receipt_key=?",
      ).get(originalKey) as Receipt|undefined;
      if(!original||original.action!=="process"||original.actor_user_id!==actor||
          original.task_id!==command.taskId||
          original.restore_generation.toLowerCase()!==command.restoreGeneration.toLowerCase()||
          original.triage_revision_after!==before.triage_revision||
          original.task_revision_after!==before.revision||
          db.prepare("SELECT 1 FROM task_triage_receipts WHERE undo_of_receipt_key=?").get(originalKey))
        return {ok:false,reason:"stale_revision"};
    }
    if(!context.stillPinned()||!context.noSidecars())return denied();
    const now=Date.now();
    if(!Number.isSafeInteger(now)||now<=0||
        (original&&now<original.committed_at_ms))return failed();
    const countReceipts=():number=>
      (db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts")
        .get() as {n:number}).n;
    const countActive=():number=>
      (db.prepare(`SELECT COUNT(*) AS n FROM task_triage_receipts r
        WHERE r.action='process'
          AND NOT EXISTS (SELECT 1 FROM task_triage_receipts u
            WHERE u.undo_of_receipt_key=r.receipt_key)
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=r.task_id
            AND t.triage_state='processed'
            AND t.triage_revision=r.triage_revision_after
            AND t.revision=r.task_revision_after)`).get() as {n:number}).n;
    let rows=countReceipts(),active=countActive();
    if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(active))return failed();
    const reserved=()=>rows+active+(command.mode==="process"?2:0);
    if(rows>=TARGET_INBOX_MAX_RECEIPTS/2||
        reserved()>TARGET_INBOX_MAX_RECEIPTS){
      // Keep previous 4096-row maintenance cadence even though we now reserve
      // additional hard-bounded slots for an active Process's future Undo.
      // Bounded, pinned maintenance in the *same transaction*. Newer receipts
      // (90-day minimum) stay immutable, and an active Process retains its
      // original proof so Undo remains possible even long afterwards.
      // Prune Undo children before their parents (FK is RESTRICT by default).
      const cutoff=now-TARGET_INBOX_RECEIPT_RETENTION_DAYS*86_400_000-60_000;
      if(cutoff<=0)return failed();
      db.prepare("DELETE FROM task_triage_receipts WHERE action='undo' AND committed_at_ms<=?")
        .run(cutoff);
      db.prepare(`DELETE FROM task_triage_receipts
        WHERE action='process' AND committed_at_ms<=?
        AND NOT EXISTS (SELECT 1 FROM task_triage_receipts u
          WHERE u.undo_of_receipt_key=task_triage_receipts.receipt_key)
        AND NOT EXISTS (SELECT 1 FROM tasks t
          WHERE t.id=task_triage_receipts.task_id AND t.triage_state='processed'
            AND t.triage_revision=task_triage_receipts.triage_revision_after
            AND t.revision=task_triage_receipts.task_revision_after)`).run(cutoff);
      rows=countReceipts();
      active=countActive();
    }
    // One reserved slot for every live Process guarantees its Undo can
    // commit, even when all other receipt history is still within 90 days.
    // A new Process consumes two units (receipt + future Undo reserve);
    // Undo exchanges its reserve for a receipt.
    if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(active)||
        rows>=TARGET_INBOX_MAX_RECEIPTS||reserved()>TARGET_INBOX_MAX_RECEIPTS)
      return failed();
    const nextState=command.mode==="process"?"processed":"unprocessed";
    const nextAt=command.mode==="process"?now:null;
    const updated=db.prepare(
      "UPDATE tasks SET triage_state=?,triaged_at=?,triage_revision=triage_revision+1"+
      " WHERE id=? AND triage_state=? AND triage_revision=?",
    ).run(nextState,nextAt,command.taskId,before.triage_state,before.triage_revision);
    if(updated.changes!==1)return failed();
    const after=db.prepare(
      "SELECT triage_state,triaged_at,triage_revision,revision FROM tasks WHERE id=?",
    ).get(command.taskId) as Before|undefined;
    if(!after||after.triage_state!==nextState||after.triaged_at!==nextAt||
        after.triage_revision!==before.triage_revision+1||
        after.revision!==before.revision+1)return failed();
    db.prepare(
      "INSERT INTO task_triage_receipts(receipt_key,request_digest,actor_user_id,task_id,action,"+
      "undo_of_receipt_key,restore_generation,triage_revision_before,triage_revision_after,"+
      "task_revision_before,task_revision_after,committed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(receiptKey,digest,actor,command.taskId,command.mode,
      originalKey,command.restoreGeneration.toLowerCase(),
      before.triage_revision,after.triage_revision,before.revision,after.revision,now);
    if(!sessionLive()||!context.stillPinned())return {ok:false,reason:"session_revoked"};
    if(!context.commit({kind:"task_triage",payload:{}}))return failed();
    return {ok:true};
  },denied,failed);
}
