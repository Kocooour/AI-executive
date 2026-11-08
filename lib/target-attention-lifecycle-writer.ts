/**
 * R2d.5b.2: isolated actor-private Attention lifecycle writer (snooze, dismiss,
 * restore). No HTTP route, UI, push, production activation or migration. The
 * principal is a server-issued WRITE credential; command payloads cannot
 * select an actor. Only the actor's own personal_attention_states rows change.
 */
import {createHash} from "node:crypto";
import {TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX} from "./target-store-bootstrap";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {verifiedActor} from "./target-task-authenticated-read";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {fingerprint} from "./target-task-staging-writer";
import {validTargetDueOn} from "./target-task-temporal-due-on-writer";
import {attentionEvaluationWindow,attentionKey,currentAttentionRule}
  from "./target-attention-read-model";
import {planTargetAttentionLifecycle,type TargetAttentionLifecycleOutcome,
  type TargetAttentionLifecycleRow} from "./target-attention-lifecycle-policy";
import {checkTargetTaskWriteContract,targetTaskWriteRevision,
  validTargetTaskTitleEditPreviewRequest} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
const epoch=(value:unknown):value is number=>
  typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
/** Longest snooze accepted by the writer (30 days, R2d.5b.0 / PR #317 policy). */
export const TARGET_ATTENTION_MAX_SNOOZE_MS=30*24*60*60*1000;

export type TargetAttentionLifecycleRuleId=
  "deadline_overdue"|"deadline_soon"|"planned_date_passed";
export type TargetAttentionLifecycleAction="snooze"|"dismiss"|"restore";
const RULES=new Set<unknown>(["deadline_overdue","deadline_soon","planned_date_passed"]);
const ACTIONS=new Set<unknown>(["snooze","dismiss","restore"]);
const ACTION_CODE={snooze:0,dismiss:1,restore:2} as const;

export interface TargetStagingAttentionLifecycleCommand {
  readonly commandId:string;
  readonly taskId:string;
  readonly ruleId:TargetAttentionLifecycleRuleId;
  /** Strict date of the occurrence the actor acts on (never null). */
  readonly occurrenceOn:string;
  readonly action:TargetAttentionLifecycleAction;
  /** Safe positive integer for snooze, null for dismiss/restore. */
  readonly snoozedUntilMs:number|null;
  readonly expectedRevision:string;
  /** Actor's personal_attention_epochs.revision. */
  readonly expectedAttentionEpoch:number;
  /** Null for an absent state row; otherwise the expected row revision. */
  readonly expectedStateRevision:number|null;
  readonly writeAreaId:string;
  readonly restoreGeneration:string;
  /** Actor's IANA zone: snooze/dismiss require the rule to fire NOW there. */
  readonly timeZone:string;
}
export type TargetStagingAttentionLifecycleResult =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "stale_revision"|"idempotency_conflict"|"unchanged"|"not_active"|"write_failed"|
      "session_revoked"|"resync_required"|"write_area_mismatch"};

const denied=():TargetStagingAttentionLifecycleResult=>({ok:false,reason:"unauthorized"});
const failed=():TargetStagingAttentionLifecycleResult=>({ok:false,reason:"write_failed"});

export function validTargetStagingAttentionLifecycleCommand(
  input:unknown,
):input is TargetStagingAttentionLifecycleCommand {
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
      "action,commandId,expectedAttentionEpoch,expectedRevision,expectedStateRevision,occurrenceOn,restoreGeneration,ruleId,snoozedUntilMs,taskId,timeZone,writeAreaId" &&
    typeof x.timeZone==="string"&&attentionEvaluationWindow(0,x.timeZone)!==null&&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.expectedRevision==="string"&&/^[a-f0-9]{64}$/.test(x.expectedRevision)&&
    RULES.has(x.ruleId)&&ACTIONS.has(x.action)&&
    typeof x.occurrenceOn==="string"&&validTargetDueOn(x.occurrenceOn)&&
    (x.action==="snooze"
      ? typeof x.snoozedUntilMs==="number"&&Number.isSafeInteger(x.snoozedUntilMs)&&x.snoozedUntilMs>0
      : x.snoozedUntilMs===null)&&
    epoch(x.expectedAttentionEpoch)&&
    (x.expectedStateRevision===null||epoch(x.expectedStateRevision))&&
    typeof x.writeAreaId==="string"&&AREA.test(x.writeAreaId)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    validTargetTaskTitleEditPreviewRequest({
      taskId:x.taskId,expectedRevision:x.expectedRevision,
    });
}

export function attentionLifecycleReceiptKey(
  actor:string,taskId:string,commandId:string,
):string {
  return TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX+createHash("sha256")
    .update(JSON.stringify(["personal-attention-v1",actor,taskId,commandId.toLowerCase()]))
    .digest("hex");
}
export function attentionLifecycleReceiptDigest(
  command:TargetStagingAttentionLifecycleCommand,
):string {
  return createHash("sha256").update(JSON.stringify([
    "personal-attention-v1",command.taskId,command.ruleId,command.occurrenceOn,
    command.action,command.snoozedUntilMs,command.expectedRevision,
    command.expectedAttentionEpoch,command.expectedStateRevision,
    command.writeAreaId,command.restoreGeneration.toLowerCase(),command.timeZone,
  ])).digest("hex");
}

/** One authenticated, preflighted BEGIN IMMEDIATE transaction. All failed
 * branches roll back, including a revocation immediately before journal commit. */
export function writePreflightedAttentionLifecycle(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetStagingAttentionLifecycleCommand,durableSessionTokenHash?:string,
):TargetStagingAttentionLifecycleResult {
  if(!validTargetStagingAttentionLifecycleCommand(command))
    return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetStagingAttentionLifecycleResult>(
    store,context=>{
      const {db,databaseFd}=context;
      const actor=verifiedActor(db,credential,true);
      if(!actor)return denied();
      const sessionLive=():boolean=>{
        if(durableSessionTokenHash===undefined)return true;
        const live=lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now());
        return live!==null&&live.userId===actor;
      };
      if(!sessionLive())return {ok:false,reason:"session_revoked"};
      const contract=checkTargetTaskWriteContract(db,actor,command);
      if(contract.ok===false)return {ok:false,reason:contract.reason};
      const task=db.prepare(
        "SELECT t.status AS status,t.assignee_user_id AS assignee,t.due_on AS dueOn,"+
        " a.kind AS kind,a.owner_user_id AS owner"+
        " FROM tasks t LEFT JOIN projects p ON p.id=t.project_id"+
        " JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id) WHERE t.id=?"
      ).get(command.taskId) as
        {status:string;assignee:string|null;dueOn:string|null;kind:string;owner:string}|undefined;
      if(!task||task.status!=="open"||
          !((task.kind==="private"&&task.owner===actor)||
            (task.kind==="shared"&&task.assignee===actor)))
        return {ok:false,reason:"unavailable"};
      // The occurrence must still be current; nothing about it is echoed back.
      const plan=db.prepare(
        "SELECT when_on AS whenOn FROM personal_task_plans WHERE user_id=? AND task_id=?"
      ).get(actor,command.taskId) as {whenOn:string}|undefined;
      if(command.ruleId==="planned_date_passed"){
        if(!plan||plan.whenOn!==command.occurrenceOn)
          return {ok:false,reason:"unavailable"};
      }else if(task.dueOn!==command.occurrenceOn)
        return {ok:false,reason:"unavailable"};

      // Receipt lookup AFTER current task/Area/assignment/occurrence authorization.
      const receipt=attentionLifecycleReceiptKey(actor,command.taskId,command.commandId);
      const digest=attentionLifecycleReceiptDigest(command);
      const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receipt) as {value:string}|undefined;
      if(prior)return prior.value===digest
        ? {ok:true,replayed:true}:{ok:false,reason:"idempotency_conflict"};

      fingerprint(databaseFd);
      if(targetTaskWriteRevision(db,command.taskId)!==command.expectedRevision)
        return {ok:false,reason:"stale_revision"};
      const epochRow=db.prepare(
        "SELECT revision FROM personal_attention_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!epochRow||!epoch(epochRow.revision))return failed();
      if(epochRow.revision!==command.expectedAttentionEpoch)
        return {ok:false,reason:"stale_revision"};
      const row=db.prepare(
        "SELECT state,snoozed_until_ms AS until,revision FROM personal_attention_states"+
        " WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?"
      ).get(actor,command.taskId,command.ruleId,command.occurrenceOn) as
        {state:string;until:number|null;revision:number}|undefined;
      if(row&&(!epoch(row.revision)||(row.state!=="snoozed"&&row.state!=="dismissed")))
        return failed();
      if((row?.revision??null)!==command.expectedStateRevision)
        return {ok:false,reason:"stale_revision"};

      const now=Date.now();
      // Snooze/dismiss act only on a CURRENT candidate (same rule evaluation as
      // the selector, server clock, actor zone): no pre-dismissal of a future
      // deadline or of a soon item outside 48 h. Restore (Undo) needs no window.
      if(command.action!=="restore"){
        const window=attentionEvaluationWindow(now,command.timeZone);
        if(!window)return {ok:false,reason:"invalid_request"};
        if(currentAttentionRule(task.dueOn,plan?.whenOn??null,window)!==command.ruleId)
          return {ok:false,reason:"unavailable"};
      }
      if(command.action==="snooze"){
        const until=command.snoozedUntilMs as number;
        if(!(now<until&&until<=now+TARGET_ATTENTION_MAX_SNOOZE_MS))
          return {ok:false,reason:"invalid_request"};
      }
      // Transitions come from the merged R2d.5b.0 policy (#317), evaluated on
      // the RAW row inside this transaction: active = no row; snooze/dismiss =
      // INSERT revision 0; restore = DELETE. An expired snooze row is first
      // deleted by a policy "recheck" (snooze_expired) and only then may a new
      // snooze/dismiss be inserted, exactly as the policy prescribes.
      const taskRow=db.prepare("SELECT revision FROM tasks WHERE id=?")
        .get(command.taskId) as {revision:number}|undefined;
      if(!taskRow||!epoch(taskRow.revision))return failed();
      const occurrence={attentionKey:attentionKey(command.ruleId,command.taskId,command.occurrenceOn),
        taskId:command.taskId,ruleId:command.ruleId,relevantOn:command.occurrenceOn};
      const planStep=(stored:TargetAttentionLifecycleRow|null,attentionEpoch:number,
        kind:"snooze"|"dismiss"|"restore"|"recheck"):TargetAttentionLifecycleOutcome=>{
        const expected={nowMs:now,expectedSourceRevision:taskRow.revision,
          expectedAttentionEpoch:attentionEpoch,
          expectedLifecycleRevision:stored?.revision??null};
        return planTargetAttentionLifecycle(
          {actorUserId:actor,restoreGeneration:command.restoreGeneration,
            ...occurrence,attentionEpoch,row:stored},
          {actorUserId:actor,restoreGeneration:command.restoreGeneration,attentionEpoch,
            candidate:{...occurrence,sourceRevision:taskRow.revision}},
          kind==="snooze"?{kind,...expected,untilMs:command.snoozedUntilMs as number}
            :{kind,...expected});
      };
      const stored:TargetAttentionLifecycleRow|null=row?{
        state:row.state as "snoozed"|"dismissed",snoozedUntilMs:row.until,revision:row.revision,
      }:null;
      const steps:TargetAttentionLifecycleOutcome[]=[];
      let observedRow=stored,observedEpoch=epochRow.revision;
      if(command.action!=="restore"&&stored?.state==="snoozed"&&
          stored.snoozedUntilMs!==null&&stored.snoozedUntilMs<=now){
        const expiry=planStep(stored,observedEpoch,"recheck");
        if(!expiry.ok||expiry.operation!=="delete")return failed();
        steps.push(expiry);observedRow=null;observedEpoch++;
      }
      const main=planStep(observedRow,observedEpoch,command.action);
      if(main.ok===false){
        if(main.reason==="invalid")return {ok:false,reason:"invalid_request"};
        if(main.reason==="stale")return {ok:false,reason:"stale_revision"};
        if(main.reason==="not-active")
          return {ok:false,reason:command.action==="restore"?"unchanged":"not_active"};
        return failed();
      }
      if(main.operation==="none")return failed();
      steps.push(main);
      if(!context.stillPinned()||!context.noSidecars())return denied();
      const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX+"%") as {n:number};
      if(existing.n>=TARGET_STAGING_MAX_RECEIPTS)return failed();

      let changes=0;
      const key=[actor,command.taskId,command.ruleId,command.occurrenceOn] as const;
      for(const step of steps){
        if(!step.ok)return failed();
        if(step.operation==="delete"){
          if(db.prepare(
            "DELETE FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?"
          ).run(...key).changes!==1)return failed();
        }else if(step.operation==="insert"&&step.row){
          if(db.prepare(
            "INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms)"+
            " VALUES (?,?,?,?,?,?)"
          ).run(...key,step.row.state,step.row.snoozedUntilMs).changes!==1)return failed();
        }else return failed();
        changes++;
      }
      // Hygiene: once an occurrence is overdue its "soon" condition can never
      // recur, so the actor's own stale deadline_soon row is removed with it.
      if(command.ruleId==="deadline_overdue"){
        const soon=db.prepare(
          "DELETE FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id='deadline_soon' AND occurrence_on=?"
        ).run(actor,command.taskId,command.occurrenceOn).changes;
        if(soon!==0&&soon!==1)return failed();
        changes+=Number(soon);
      }
      const next=db.prepare(
        "SELECT revision FROM personal_attention_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!next||next.revision!==epochRow.revision+changes)return failed();
      const updated=db.prepare(
        "SELECT revision FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?"
      ).get(...key) as {revision:number}|undefined;
      if(command.action==="restore"?updated!==undefined:
          !updated||updated.revision!==0)return failed();
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
      if(!sessionLive()||!context.stillPinned())
        return {ok:false,reason:"session_revoked"};
      // No actor, task ID, rule or date in the append-only journal.
      context.commit({kind:"personal_attention",payload:{
        receiptHash:receipt.slice(TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX.length),
        epoch:next.revision,action:ACTION_CODE[command.action],
      }});
      return {ok:true};
    },denied,failed);
}
