/** C-3a: explicitly retire an ambiguous Inbox UUID without risking a late write.
 * The irreversible fence and Process/Undo share the same pinned BEGIN IMMEDIATE.
 * This is a write operation, never an inference from a read-only missing receipt.
 */
import {TARGET_STAGING_MAX_RECEIPTS} from "./target-store-bootstrap";
import {canWriteIsolatedTargetArea,targetStoreRestoreGeneration,targetTaskWriteTarget}
  from "./target-task-write-preflight";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {verifiedActor,type TargetStagingReadCredential}
  from "./target-task-authenticated-read";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {targetInboxTriageCancellationShardKeys,targetInboxTriageCancelled,
  targetInboxTriageDigest,targetInboxTriageReceiptKey,validTargetInboxTriageCommand,
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
    // An actor can retire only UUIDs associated with an Area they can STILL
    // write. Do not reveal whether a missing task, foreign task or tombstone exists.
    if(!canWriteIsolatedTargetArea(db,actor,command.writeAreaId)&&
        !targetTaskWriteTarget(db,actor,command.taskId))return denied();
    const receipt=db.prepare(
      "SELECT request_digest,actor_user_id,task_id FROM task_triage_receipts WHERE receipt_key=?"
    ).get(targetInboxTriageReceiptKey(actor,command.commandId)) as
      {request_digest:string;actor_user_id:string;task_id:string}|undefined;
    if(receipt){
      if(receipt.actor_user_id!==actor||receipt.task_id!==command.taskId||
          receipt.request_digest!==targetInboxTriageDigest(command))
        return {ok:false,reason:"idempotency_conflict"};
      // A previous Process did commit; current task/tombstone write ACL still
      // governs even this content-free historical acknowledgement.
      if(!targetTaskWriteTarget(db,actor,command.taskId))return denied();
      return sessionLive()?{ok:true,status:"committed"}:
        {ok:false,reason:"session_revoked"};
    }
    const prior=targetInboxTriageCancelled(db,actor,command);
    if(prior)return prior==="cancelled"?{ok:true,status:"cancelled"}:
      {ok:false,reason:"idempotency_conflict"};
    // Keep all earlier permanent fences. Once one actor/shard has 4096
    // commands, narrow the receipt-hash partition rather than failing every
    // subsequent cancellation or deleting a fence a late POST may still need.
    // The 64-hex terminal shard is unique to this command (already checked
    // above), so it cannot be full. Prefix-range probes use metadata's PK.
    const count=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key>=? AND key<?");
    let selected:string|null=null;
    for(const key of targetInboxTriageCancellationShardKeys(actor,command.commandId)){
      const prefix=key.slice(0,-64);
      const row=count.get(prefix,prefix+"g") as {n:number};
      if(!Number.isSafeInteger(row.n))return failed();
      if(row.n<TARGET_STAGING_MAX_RECEIPTS){selected=key;break;}
    }
    if(!selected||!context.stillPinned()||!context.noSidecars()||!sessionLive())
      return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(
      selected,targetInboxTriageDigest(command));
    if(!sessionLive())return {ok:false,reason:"session_revoked"};
    return context.commit({kind:"task_triage",payload:{cancel:1}})
      ?{ok:true,status:"cancelled"}:failed();
  },denied,failed);
}
