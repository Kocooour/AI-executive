/**
 * R2d.3k.4a: isolated actor-private set/clear whenOn writer.
 * No HTTP route, UI, production activation or migration. The principal is a
 * server-issued WRITE credential; command payloads cannot select an actor.
 */
import {createHash} from "node:crypto";
import {TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX} from "./target-store-bootstrap";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {verifiedActor} from "./target-task-authenticated-read";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {fingerprint} from "./target-task-staging-writer";
import {validTargetDueOn} from "./target-task-temporal-due-on-writer";
import {checkTargetTaskWriteContract,targetTaskWriteRevision,
  validTargetTaskTitleEditPreviewRequest} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
const epoch=(value:unknown):value is number=>
  typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;

export interface TargetStagingPersonalWhenCommand {
  readonly commandId:string;
  readonly taskId:string;
  /** Private day: null clears the actor's plan, never the shared dueOn. */
  readonly whenOn:string|null;
  /** Task/Area/restore snapshot CAS token, not a substitute for live ACL. */
  readonly expectedRevision:string;
  /** Independent actor-private CAS: protects the plan even if task unchanged. */
  readonly expectedPrivateEpoch:number;
  /** Null for an absent plan; otherwise expected per-row plan revision. */
  readonly expectedPlanRevision:number|null;
  readonly writeAreaId:string;
  readonly restoreGeneration:string;
}
export type TargetStagingPersonalWhenResult =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "stale_revision"|"idempotency_conflict"|"unchanged"|"write_failed"|
      "session_revoked"|"resync_required"|"write_area_mismatch"};

const denied=():TargetStagingPersonalWhenResult=>({ok:false,reason:"unauthorized"});
const failed=():TargetStagingPersonalWhenResult=>({ok:false,reason:"write_failed"});

export function validTargetStagingPersonalWhenCommand(
  input:unknown,
):input is TargetStagingPersonalWhenCommand {
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
      "commandId,expectedPlanRevision,expectedPrivateEpoch,expectedRevision,restoreGeneration,taskId,whenOn,writeAreaId" &&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    validTargetDueOn(x.whenOn)&&epoch(x.expectedPrivateEpoch)&&
    (x.expectedPlanRevision===null||epoch(x.expectedPlanRevision))&&
    typeof x.writeAreaId==="string"&&AREA.test(x.writeAreaId)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    validTargetTaskTitleEditPreviewRequest({
      taskId:x.taskId,expectedRevision:x.expectedRevision,
    });
}

export function personalWhenReceiptKey(
  actor:string,taskId:string,commandId:string,
):string {
  return TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX+createHash("sha256")
    .update(JSON.stringify(["personal-when-v1",actor,taskId,commandId.toLowerCase()]))
    .digest("hex");
}
export function personalWhenReceiptDigest(
  command:TargetStagingPersonalWhenCommand,
):string {
  return createHash("sha256").update(JSON.stringify([
    "personal-when-v1",command.taskId,command.whenOn,command.expectedRevision,
    command.expectedPrivateEpoch,command.expectedPlanRevision,
    command.writeAreaId,command.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

/** One authenticated, preflighted BEGIN IMMEDIATE transaction. All failed
 * branches roll back, including a revocation immediately before journal commit. */
export function writePreflightedPersonalWhen(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetStagingPersonalWhenCommand,durableSessionTokenHash?:string,
):TargetStagingPersonalWhenResult {
  if(!validTargetStagingPersonalWhenCommand(command))
    return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetStagingPersonalWhenResult>(
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
      // A valid write on a shared task requires the actor's own assignment.
      // This is stricter than being an editor of the enclosing Area.
      const contract=checkTargetTaskWriteContract(db,actor,command);
      if(contract.ok===false)return {ok:false,reason:contract.reason};
      const task=db.prepare(
        "SELECT t.status AS status,t.assignee_user_id AS assignee,"+
        " a.kind AS kind,a.owner_user_id AS owner"+
        " FROM tasks t LEFT JOIN projects p ON p.id=t.project_id"+
        " JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id) WHERE t.id=?"
      ).get(command.taskId) as
        {status:string;assignee:string|null;kind:string;owner:string}|undefined;
      if(!task||task.status!=="open"||
          !((task.kind==="private"&&task.owner===actor)||
            (task.kind==="shared"&&task.assignee===actor)))
        return {ok:false,reason:"unavailable"};

      // Receipt lookup AFTER current task/Area/assignment authorization.
      const receipt=personalWhenReceiptKey(actor,command.taskId,command.commandId);
      const digest=personalWhenReceiptDigest(command);
      const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receipt) as {value:string}|undefined;
      if(prior)return prior.value===digest
        ? {ok:true,replayed:true}:{ok:false,reason:"idempotency_conflict"};

      fingerprint(databaseFd);
      if(targetTaskWriteRevision(db,command.taskId)!==command.expectedRevision)
        return {ok:false,reason:"stale_revision"};
      const privateRow=db.prepare(
        "SELECT revision FROM personal_plan_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!privateRow||!epoch(privateRow.revision))return failed();
      if(privateRow.revision!==command.expectedPrivateEpoch)
        return {ok:false,reason:"stale_revision"};
      const plan=db.prepare(
        "SELECT when_on AS whenOn,revision FROM personal_task_plans WHERE user_id=? AND task_id=?"
      ).get(actor,command.taskId) as {whenOn:string;revision:number}|undefined;
      if(plan&&(!validTargetDueOn(plan.whenOn)||!epoch(plan.revision)))
        return failed();
      if((plan?.revision??null)!==command.expectedPlanRevision)
        return {ok:false,reason:"stale_revision"};
      if((plan?.whenOn??null)===command.whenOn)
        return {ok:false,reason:"unchanged"};
      if(!context.stillPinned()||!context.noSidecars())return denied();
      const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX+"%") as {n:number};
      if(existing.n>=TARGET_STAGING_MAX_RECEIPTS)return failed();

      if(command.whenOn===null){
        if(db.prepare(
          "DELETE FROM personal_task_plans WHERE user_id=? AND task_id=?"
        ).run(actor,command.taskId).changes!==1)return failed();
      }else if(plan){
        if(db.prepare(
          "UPDATE personal_task_plans SET when_on=? WHERE user_id=? AND task_id=?"
        ).run(command.whenOn,actor,command.taskId).changes!==1)return failed();
      }else{
        if(db.prepare(
          "INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)"
        ).run(actor,command.taskId,command.whenOn).changes!==1)return failed();
      }
      const next=db.prepare(
        "SELECT revision FROM personal_plan_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!next||next.revision!==privateRow.revision+1)return failed();
      const updated=db.prepare(
        "SELECT revision FROM personal_task_plans WHERE user_id=? AND task_id=?"
      ).get(actor,command.taskId) as {revision:number}|undefined;
      if(command.whenOn===null?updated!==undefined:
          !updated||updated.revision!==(plan?plan.revision+1:0))return failed();
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
      if(!sessionLive()||!context.stillPinned())
        return {ok:false,reason:"session_revoked"};
      // No actor, task ID or date in the append-only journal.
      context.commit({kind:"personal_when",payload:{
        receiptHash:receipt.slice(TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX.length),
        epoch:next.revision,set:command.whenOn===null?0:1,
      }});
      return {ok:true};
    },denied,failed);
}
