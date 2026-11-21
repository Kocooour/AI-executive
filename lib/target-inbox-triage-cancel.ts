/** C-3a: retire an ambiguous Inbox UUID without an unbounded tombstone ledger.
 * A pinned task-revision increment invalidates the EXACT original CAS forever;
 * a tombstone or already-stale revision also prevents any future commit.
 * Legacy permanent fences are still checked and never removed.
 */
import {checkTargetTaskWriteContract,targetStoreRestoreGeneration,
  targetTaskWriteRevision,targetTaskWriteTarget} from "./target-task-write-preflight";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {verifiedActor,type TargetStagingReadCredential}
  from "./target-task-authenticated-read";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {targetInboxTriageCancelled,targetInboxTriageDigest,
  targetInboxTriageReceiptKey,validTargetInboxTriageCommand,
  type TargetInboxTriageCommand} from "./target-inbox-triage-writer";
import type {TargetStagingReadStore} from "./target-task-staging-reader";

export type TargetInboxTriageCancelResult=
  |{ok:true;status:"cancelled"|"committed"}
  |{ok:false;reason:"unavailable"|"invalid_request"|"session_revoked"|
    "resync_required"|"write_failed"|"idempotency_conflict"};

export function cancelPreflightedTargetInboxTriage(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetInboxTriageCommand,durableSessionTokenHash?:string,
):TargetInboxTriageCancelResult{
  const denied=():TargetInboxTriageCancelResult=>({ok:false,reason:"unavailable"});
  const failed=():TargetInboxTriageCancelResult=>({ok:false,reason:"write_failed"});
  if(!validTargetInboxTriageCommand(command))return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetInboxTriageCancelResult>(store,context=>{
    const {db}=context,actor=verifiedActor(db,credential,true);
    if(!actor)return denied();
    const sessionLive=()=>durableSessionTokenHash===undefined||
      lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now())?.userId===actor;
    if(!sessionLive())return {ok:false,reason:"session_revoked"};
    if(targetStoreRestoreGeneration(db)!==command.restoreGeneration.toLowerCase()||
        store.expectedRestoreGeneration.toLowerCase()!==command.restoreGeneration.toLowerCase())
      return {ok:false,reason:"resync_required"};
    // Never insert a cancellation for an arbitrary ID merely because its
    // claimed Area is writable. Live task or immutable tombstone ACL is needed.
    const target=targetTaskWriteTarget(db,actor,command.taskId);
    if(!target)return denied();
    const receipt=db.prepare(
      "SELECT request_digest,actor_user_id,task_id FROM task_triage_receipts WHERE receipt_key=?"
    ).get(targetInboxTriageReceiptKey(actor,command.commandId)) as
      {request_digest:string;actor_user_id:string;task_id:string}|undefined;
    if(receipt){
      if(receipt.actor_user_id!==actor||receipt.task_id!==command.taskId||
          receipt.request_digest!==targetInboxTriageDigest(command))
        return {ok:false,reason:"idempotency_conflict"};
      return sessionLive()?{ok:true,status:"committed"}:
        {ok:false,reason:"session_revoked"};
    }
    // Prior draft cancellation records are immutable, even if their actor
    // bucket was full. Never weaken the old UUID+digest conflict guarantee.
    const prior=targetInboxTriageCancelled(db,actor,command);
    if(prior)return prior==="cancelled"?{ok:true,status:"cancelled"}:
      {ok:false,reason:"idempotency_conflict"};

    // A tombstone forbids task-ID recycling. A changed CAS (including a
    // monotonic policy revision, move or triage update) can never match again
    // within the same restore generation. Both are terminal *negative* proofs
    // under the pinned lock; no additional permanent metadata is necessary.
    if(target==="tombstone"||
        targetTaskWriteRevision(db,command.taskId)!==command.expectedRevision)
      return sessionLive()?{ok:true,status:"cancelled"}:
        {ok:false,reason:"session_revoked"};

    // The current CAS is still live: serialize an irrevocable monotonic
    // revision advance against the original Process/Undo. This uses the same
    // bounded task change log and normal Area-content epoch as other edits;
    // it never adds an actor+UUID cancellation row.
    const contract=checkTargetTaskWriteContract(db,actor,command);
    if(!contract.ok)return denied();
    const row=db.prepare(
      "SELECT triage_state,triage_revision,revision FROM tasks WHERE id=?"
    ).get(command.taskId) as
      {triage_state:string;triage_revision:number;revision:number}|undefined;
    if(!row||!Number.isSafeInteger(row.revision)||row.revision<0||
        row.revision>=9007199254740990)return failed();
    if(row.triage_revision!==command.expectedTriageRevision||
        (command.mode==="process"&&row.triage_state!=="unprocessed")||
        (command.mode==="undo"&&row.triage_state!=="processed"))
      return sessionLive()?{ok:true,status:"cancelled"}:
        {ok:false,reason:"session_revoked"};
    if(command.mode==="undo"){
      // Without a committed exact Process, this Undo could never execute.
      const original=db.prepare(
        "SELECT action,actor_user_id,task_id FROM task_triage_receipts WHERE receipt_key=?"
      ).get(targetInboxTriageReceiptKey(actor,command.undoOfCommandId!)) as
        {action:string;actor_user_id:string;task_id:string}|undefined;
      if(!original||original.action!=="process"||
          original.actor_user_id!==actor||original.task_id!==command.taskId)
        return sessionLive()?{ok:true,status:"cancelled"}:
          {ok:false,reason:"session_revoked"};
    }
    if(!context.stillPinned()||!context.noSidecars()||!sessionLive())return failed();
    const changed=db.prepare(
      "UPDATE tasks SET revision=revision+1 WHERE id=? AND revision=?"
    ).run(command.taskId,row.revision);
    if(changed.changes!==1||
        targetTaskWriteRevision(db,command.taskId)===command.expectedRevision||
        !sessionLive()||!context.stillPinned())return failed();
    return context.commit({kind:"task_triage",payload:{cancel:1}})
      ?{ok:true,status:"cancelled"}:failed();
  },denied,failed);
}
