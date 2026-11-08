/** R2d.5c.2: single-snapshot, current-actor-only Attention lifecycle CAS preview
 * and read-only receipt lookup. No actor, Area, session or epoch is accepted
 * from the HTTP request; nothing about the task other than CAS inputs is returned.
 */
import type {DatabaseSync} from "node:sqlite";
import {readAuthorizedTemporalTaskDetail} from "./target-task-temporal-read-model";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {TargetTemporalTaskLiveGuard} from "./target-task-temporal-read-model";
import {targetTaskWriteRevision,checkTargetTaskWriteContract} from "./target-task-write-preflight";
import {validTargetDueOn} from "./target-task-temporal-due-on-writer";
import {attentionLifecycleReceiptKey,attentionLifecycleReceiptDigest,
  type TargetStagingAttentionLifecycleCommand,type TargetAttentionLifecycleRuleId}
  from "./target-attention-lifecycle-writer";

export type AttentionCommandLifecycle="active"|"snoozed"|"dismissed";
export type AttentionCommandPreview={
  expectedRevision:string;
  expectedAttentionEpoch:number;
  /** Null for an absent state row. An expired snooze keeps its row revision. */
  expectedStateRevision:number|null;
  writeAreaId:string;
  lifecycle:AttentionCommandLifecycle;
  snoozedUntilMs:number|null;
  /** Internal witnesses, never returned to the HTTP caller. */
  linearization:TargetReadLinearization;
  guard:TargetTemporalTaskLiveGuard;
};
export type AttentionReceiptResult=
  | {ok:true;status:"committed"|"not_recorded"}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "idempotency_conflict"|"resync_required"|"write_area_mismatch"};

const epoch=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const RULES=new Set<unknown>(["deadline_overdue","deadline_soon","planned_date_passed"]);

/** Read/write permission, current shared assignment, occurrence currency and
 * the full CAS state are checked on ONE already-preflighted pinned read transaction. */
export function readAuthorizedAttentionCommandPreview(
  db:DatabaseSync,actor:string,taskId:string,ruleId:TargetAttentionLifecycleRuleId,
  occurrenceOn:string,restoreGeneration:string,nowMs:number,
):AttentionCommandPreview|null {
  try {
    if(!RULES.has(ruleId)||!validTargetDueOn(occurrenceOn)||!epoch(nowMs))return null;
    const detail=readAuthorizedTemporalTaskDetail(db,actor,taskId);
    if(!detail||detail.task.status!=="open")return null;
    const access=detail.linearization.areas[0]?.access;
    if(access!=="private-owner"&&access!=="editor"&&access!=="admin")return null;
    if(detail.task.areaKind==="shared"&&detail.task.assignedToMe!==true)return null;
    if(detail.task.areaKind==="private"&&access!=="private-owner")return null;
    const contract=checkTargetTaskWriteContract(db,actor,{
      taskId,writeAreaId:detail.task.areaId,restoreGeneration,
    });
    if(contract.ok!==true)return null;
    // The occurrence must still be the task's own date (same as the writer).
    if(ruleId==="planned_date_passed"){
      const plan=db.prepare(
        "SELECT when_on AS whenOn FROM personal_task_plans WHERE user_id=? AND task_id=?"
      ).get(actor,taskId) as {whenOn:string}|undefined;
      if(!plan||plan.whenOn!==occurrenceOn)return null;
    }else if(detail.task.dueOn!==occurrenceOn)return null;
    const expectedRevision=targetTaskWriteRevision(db,taskId);
    if(!expectedRevision||!/^[a-f0-9]{64}$/.test(expectedRevision))return null;
    const epochRow=db.prepare(
      "SELECT revision FROM personal_attention_epochs WHERE user_id=?"
    ).get(actor) as {revision:number}|undefined;
    if(!epochRow||!epoch(epochRow.revision))return null;
    const row=db.prepare(
      "SELECT state,snoozed_until_ms AS until,revision FROM personal_attention_states"+
      " WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?"
    ).get(actor,taskId,ruleId,occurrenceOn) as
      {state:string;until:number|null;revision:number}|undefined;
    let lifecycle:AttentionCommandLifecycle="active",snoozedUntilMs:number|null=null;
    if(row){
      if(!epoch(row.revision))return null;
      if(row.state==="dismissed"){
        if(row.until!==null)return null;
        lifecycle="dismissed";
      }else if(row.state==="snoozed"){
        if(!epoch(row.until)||row.until<=0)return null;
        // Server clock: an expired snooze is active again (row revision retained).
        if(row.until>nowMs){lifecycle="snoozed";snoozedUntilMs=row.until;}
      }else return null;
    }
    return {expectedRevision,expectedAttentionEpoch:epochRow.revision,
      expectedStateRevision:row?.revision??null,writeAreaId:detail.task.areaId,
      lifecycle,snoozedUntilMs,
      linearization:detail.linearization,guard:detail.guard};
  }catch{return null;}
}

/** Shared receipt validation, always called from an already-pinned actor
 * snapshot. Never compares the old command's CAS against live revisions. */
export function attentionReceiptInSnapshot(
  db:DatabaseSync,actor:string,command:TargetStagingAttentionLifecycleCommand,
  restoreGeneration:string,nowMs:number,preview?:AttentionCommandPreview,
):AttentionReceiptResult {
  const check=checkTargetTaskWriteContract(db,actor,command);
  if(check.ok===false)return {ok:false,reason:check.reason};
  if(!preview&&!readAuthorizedAttentionCommandPreview(
    db,actor,command.taskId,command.ruleId,command.occurrenceOn,restoreGeneration,nowMs))
    return {ok:false,reason:"unavailable"};
  const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(attentionLifecycleReceiptKey(actor,command.taskId,command.commandId)) as
      {value:string}|undefined;
  if(!prior)return {ok:true,status:"not_recorded"};
  return prior.value===attentionLifecycleReceiptDigest(command)
    ? {ok:true,status:"committed"}
    : {ok:false,reason:"idempotency_conflict"};
}
