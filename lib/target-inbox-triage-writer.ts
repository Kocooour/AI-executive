/** C-3a isolated target triage transition primitive.
 * Caller MUST hold a preflighted, pinned BEGIN IMMEDIATE target transaction,
 * an authenticated actor-bound write credential and a live session. This
 * primitive never opens files, commits, touches legacy or exposes an HTTP route.
 * The pinned caller commits one content-free journal intent with this receipt.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {canEditIsolatedTargetTaskTitle} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9_.:@-]{1,120}$/;

export type TargetTriageAction="process"|"undo";
export type TargetTriageCommand={
  action:TargetTriageAction;
  commandId:string;
  taskId:string;
  expectedRevision:number;
  restoreGeneration:string;
  undoOfCommandId?:string;
};
export type TargetTriageResult=
  |{ok:true;replayed:boolean;revision:number;state:"processed"|"unprocessed"}
  |{ok:false;reason:"invalid_request"|"unavailable"|"resync_required"|"idempotency_conflict"|"conflict"};

const hash=(data:unknown)=>createHash("sha256")
  .update(JSON.stringify(data)).digest("hex");
export function validTargetTriageCommand(input:unknown):input is TargetTriageCommand{
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  if(!["process","undo"].includes(String(x.action))||
    typeof x.commandId!=="string"||!UUID.test(x.commandId)||
    typeof x.taskId!=="string"||!ID.test(x.taskId)||
    typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
    !Number.isSafeInteger(x.expectedRevision)||Number(x.expectedRevision)<0||
    Number(x.expectedRevision)>=9007199254740991)return false;
  const keys=Object.keys(x).sort().join(",");
  if(x.action==="process")
    return keys==="action,commandId,expectedRevision,restoreGeneration,taskId";
  return keys==="action,commandId,expectedRevision,restoreGeneration,taskId,undoOfCommandId"&&
    typeof x.undoOfCommandId==="string"&&UUID.test(x.undoOfCommandId)&&
    x.undoOfCommandId!==x.commandId;
}
const key=(actor:string,uuid:string)=>hash(["c3a:triage-receipt:v1",actor,uuid.toLowerCase()]);
const digest=(command:TargetTriageCommand)=>hash(["c3a:triage-command:v1",command.action,
  command.commandId.toLowerCase(),command.taskId,command.expectedRevision,
  command.restoreGeneration.toLowerCase(),
  command.action==="undo"?command.undoOfCommandId?.toLowerCase():null]);

type Receipt={
  request_digest:string;actor_user_id:string;task_id:string;action:TargetTriageAction;
  revision_before:number;revision_after:number;triaged_at_ms:number|null;
  restore_generation:string;
};
type TriageRow={triage_state:"unprocessed"|"processed";triaged_at_ms:number|null;triage_revision:number};

/** Return is only meaningful after the surrounding pinned context successfully
 * commits and confirms the journal. No response may be released otherwise.
 * Replays must still pass current ACL and restore-generation checks. */
export function transitionTargetInboxTriageInTransaction(
  db:DatabaseSync,actorUserId:string,command:unknown,nowMs=Date.now(),
):TargetTriageResult{
  if(!db.isTransaction)throw new Error("C-3a transition requires pinned BEGIN IMMEDIATE");
  if(!validTargetTriageCommand(command)||!Number.isSafeInteger(nowMs)||nowMs<=0)
    return {ok:false,reason:"invalid_request"};
  if(!ID.test(actorUserId)||!canEditIsolatedTargetTaskTitle(db,actorUserId,command.taskId,true))
    return {ok:false,reason:"unavailable"};
  const meta=db.prepare("SELECT key,value FROM metadata WHERE key IN ('schema_version','restore_generation')")
    .all() as {key:string;value:string}[];
  const settings=new Map(meta.map(m=>[m.key,m.value]));
  if(settings.get("schema_version")!=="27")return {ok:false,reason:"unavailable"};
  if(settings.get("restore_generation")!==command.restoreGeneration.toLowerCase())
    return {ok:false,reason:"resync_required"};
  const receiptKey=key(actorUserId,command.commandId),requestDigest=digest(command);
  const already=db.prepare("SELECT request_digest,actor_user_id,task_id,action,revision_after FROM task_triage_commands WHERE receipt_key=?")
    .get(receiptKey) as (Receipt & {revision_after:number})|undefined;
  if(already){
    if(already.request_digest!==requestDigest||already.actor_user_id!==actorUserId||
      already.task_id!==command.taskId||already.action!==command.action)
      return {ok:false,reason:"idempotency_conflict"};
    return {ok:true,replayed:true,revision:already.revision_after,
      state:already.action==="process"?"processed":"unprocessed"};
  }
  const row=db.prepare("SELECT triage_state,triaged_at_ms,triage_revision FROM task_triage WHERE task_id=?")
    .get(command.taskId) as TriageRow|undefined;
  if(!row||row.triage_revision!==command.expectedRevision)
    return {ok:false,reason:"conflict"};
  let undoOf:string|null=null;
  if(command.action==="process"){
    if(row.triage_state!=="unprocessed"||row.triaged_at_ms!==null)
      return {ok:false,reason:"conflict"};
  }else{
    undoOf=key(actorUserId,command.undoOfCommandId!);
    const prior=db.prepare(`SELECT actor_user_id,task_id,action,revision_after,
      triaged_at_ms,restore_generation FROM task_triage_commands WHERE receipt_key=?`)
      .get(undoOf) as Receipt|undefined;
    if(!prior||prior.actor_user_id!==actorUserId||prior.task_id!==command.taskId||
      prior.action!=="process"||prior.restore_generation!==command.restoreGeneration.toLowerCase()||
      prior.revision_after!==row.triage_revision||
      prior.triaged_at_ms!==row.triaged_at_ms||row.triage_state!=="processed")
      return {ok:false,reason:"conflict"};
  }
  const processed=command.action==="process",at=processed?nowMs:null;
  const changed=db.prepare(`UPDATE task_triage SET triage_state=?,triaged_at_ms=?
    WHERE task_id=? AND triage_revision=?`).run(
    processed?"processed":"unprocessed",at,command.taskId,command.expectedRevision);
  if(changed.changes!==1)throw new Error("C-3a triage CAS failed after validation");
  const revision=command.expectedRevision+1;
  const next=db.prepare("SELECT triage_state,triaged_at_ms,triage_revision FROM task_triage WHERE task_id=?")
    .get(command.taskId) as TriageRow|undefined;
  if(!next||next.triage_revision!==revision||
    next.triage_state!==(processed?"processed":"unprocessed")||next.triaged_at_ms!==at)
    throw new Error("C-3a triage revision witness failed");
  db.prepare(`INSERT INTO task_triage_commands(receipt_key,request_digest,actor_user_id,
    task_id,action,undo_of_key,revision_before,revision_after,triaged_at_ms,
    restore_generation,committed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    receiptKey,requestDigest,actorUserId,command.taskId,command.action,undoOf,
    command.expectedRevision,revision,at,command.restoreGeneration.toLowerCase(),nowMs);
  return {ok:true,replayed:false,revision,state:processed?"processed":"unprocessed"};
}
