/** Milestone A/2: isolated owner-private project and project-child task creation.
 * A child task NEVER supplies areaId: its effective Area is the live parent Area.
 * All decisions and idempotency state live inside the pinned BEGIN IMMEDIATE.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {fingerprint} from "./target-task-staging-writer";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {verifiedActor,type TargetStagingReadCredential} from "./target-task-authenticated-read";
import {canWriteIsolatedTargetArea} from "./target-task-write-preflight";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {TARGET_STAGING_MAX_RECEIPTS,TARGET_STAGING_AUDIT_MAX_EVENTS}
  from "./target-store-bootstrap";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
const HEX=/^[a-f0-9]{64}$/;
export type PrivateStructureKind="project"|"project-task";
export interface PrivateProjectCreateCommand {
  readonly projectId:string;readonly commandId:string;readonly areaId:string;
  readonly restoreGeneration:string;readonly title:string;
}
export interface PrivateProjectTaskCreateCommand {
  readonly taskId:string;readonly commandId:string;readonly projectId:string;
  readonly restoreGeneration:string;readonly title:string;
}
export type PrivateStructureCreateCommand=PrivateProjectCreateCommand|PrivateProjectTaskCreateCommand;
export type PrivateStructureCreateResult=
  |{ok:true;replayed?:true}
  |{ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "resync_required"|"idempotency_conflict"|"session_revoked"|"write_failed"};
export type PrivateStructureCreateStatus=
  |{ok:true;status:"committed"|"not_recorded"}
  |{ok:false;reason:"unavailable"|"idempotency_conflict"};
export type PrivateStructureCreateRecovery=
  |{ok:true;status:"not_recorded"}
  |{ok:true;status:"committed";id:string;projectId:string;areaId:string}
  |{ok:false;reason:"unavailable"};

export const PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX="r3:private-structure-create-receipt-v1:";
export const PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX="r3:private-structure-create-recovery-v1:";

const canonicalUUID=(x:unknown):x is string=>typeof x==="string"&&UUID.test(x)&&x===x.toLowerCase();
const validTitle=(x:unknown):x is string=>typeof x==="string"&&x.length>0&&
  x.trim()===x&&x.isWellFormed()&&Buffer.byteLength(x,"utf8")<=4096&&
  !/[\u0000-\u001f\u007f]/u.test(x);
export function validPrivateStructureCreateCommand(
  kind:PrivateStructureKind,value:unknown,
):value is PrivateStructureCreateCommand{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const r=value as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if(kind==="project"){
    return keys==="areaId,commandId,projectId,restoreGeneration,title"&&
      canonicalUUID(r.projectId)&&typeof r.areaId==="string"&&AREA.test(r.areaId)&&
      typeof r.commandId==="string"&&UUID.test(r.commandId)&&
      typeof r.restoreGeneration==="string"&&UUID.test(r.restoreGeneration)&&validTitle(r.title);
  }
  return keys==="commandId,projectId,restoreGeneration,taskId,title"&&
    canonicalUUID(r.projectId)&&canonicalUUID(r.taskId)&&
    typeof r.commandId==="string"&&UUID.test(r.commandId)&&
    typeof r.restoreGeneration==="string"&&UUID.test(r.restoreGeneration)&&validTitle(r.title);
}
const keyHash=(actor:string,commandId:string)=>createHash("sha256")
  .update(JSON.stringify([actor,commandId.toLowerCase()])).digest("hex");
const receiptKey=(actor:string,commandId:string)=>PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX+
  keyHash(actor,commandId);
const recoveryKey=(actor:string,commandId:string)=>PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX+
  keyHash(actor,commandId);
// Use a fixed field order; semantically identical JSON with reordered keys
// must be an idempotent replay, never a conflict.
const digest=(kind:PrivateStructureKind,command:PrivateStructureCreateCommand)=>{
  const fields=kind==="project"
    ?[command.projectId,(command as PrivateProjectCreateCommand).areaId]
    :[(command as PrivateProjectTaskCreateCommand).taskId,command.projectId];
  return createHash("sha256").update(JSON.stringify([
    "private-structure-create-v1",kind,...fields,
    command.restoreGeneration.toLowerCase(),command.title,
  ])).digest("hex");
};
type Witness={kind:PrivateStructureKind;id:string;projectId:string;areaId:string;restoreGeneration:string};
const witnessValue=(w:Witness)=>JSON.stringify(w);
function parseWitness(value:string):Witness|null{
  try{
    if(value.length>450)return null;
    const v:unknown=JSON.parse(value);
    if(!v||typeof v!=="object"||Array.isArray(v))return null;
    const w=v as Record<string,unknown>;
    if(Object.keys(w).sort().join(",")!=="areaId,id,kind,projectId,restoreGeneration"||
      (w.kind!=="project"&&w.kind!=="project-task")||
      !canonicalUUID(w.id)||!canonicalUUID(w.projectId)||
      typeof w.areaId!=="string"||!AREA.test(w.areaId)||
      typeof w.restoreGeneration!=="string"||!UUID.test(w.restoreGeneration)||
      (w.kind==="project"&&w.id!==w.projectId))return null;
    return w as Witness;
  }catch{return null;}
}
function generation(db:DatabaseSync):string|null{
  const r=db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
    .get() as {value:string}|undefined;
  return r?.value?.toLowerCase()||null;
}
function liveProjectArea(db:DatabaseSync,actor:string,projectId:string):string|null{
  const row=db.prepare("SELECT area_id FROM projects WHERE id=? COLLATE NOCASE")
    .get(projectId) as {area_id:string}|undefined;
  if(!row||!canWriteIsolatedTargetArea(db,actor,row.area_id,true))return null;
  return row.area_id;
}
function liveWitness(db:DatabaseSync,actor:string,w:Witness):boolean{
  if(!canWriteIsolatedTargetArea(db,actor,w.areaId,true))return false;
  if(w.kind==="project"){
    const p=db.prepare("SELECT id,area_id FROM projects WHERE id=? COLLATE NOCASE")
      .get(w.id) as {id:string;area_id:string}|undefined;
    return p?.id===w.id&&p.area_id===w.areaId;
  }
  if(liveProjectArea(db,actor,w.projectId)!==w.areaId)return false;
  const t=db.prepare("SELECT id,project_id,area_id FROM tasks WHERE id=? COLLATE NOCASE")
    .get(w.id) as {id:string;project_id:string|null;area_id:string|null}|undefined;
  return t?.id===w.id&&t.project_id===w.projectId&&t.area_id===null;
}
const denied=():PrivateStructureCreateResult=>({ok:false,reason:"unauthorized"});
const failed=():PrivateStructureCreateResult=>({ok:false,reason:"write_failed"});

/** Never accepts client identity or client-defined Area for a project child. */
export function createPreflightedPrivateStructure(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  kind:PrivateStructureKind,command:PrivateStructureCreateCommand,
  durableSessionTokenHash?:string,
):PrivateStructureCreateResult{
  if(!validPrivateStructureCreateCommand(kind,command))
    return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
    !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<PrivateStructureCreateResult>(store,context=>{
    const {db,databaseFd}=context;
    const actor=verifiedActor(db,credential,true);if(!actor)return denied();
    const sessionLive=()=>durableSessionTokenHash===undefined||
      lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now())?.userId===actor;
    if(!sessionLive())return {ok:false,reason:"session_revoked"};
    const g=generation(db);
    if(!g||g!==command.restoreGeneration.toLowerCase()||
      g!==store.expectedRestoreGeneration.toLowerCase())
      return {ok:false,reason:"resync_required"};
    const areaId=kind==="project"
      ?(command as PrivateProjectCreateCommand).areaId
      :liveProjectArea(db,actor,(command as PrivateProjectTaskCreateCommand).projectId);
    if(!areaId||!canWriteIsolatedTargetArea(db,actor,areaId,true))
      return {ok:false,reason:"unavailable"};
    const id=kind==="project"
      ?(command as PrivateProjectCreateCommand).projectId
      :(command as PrivateProjectTaskCreateCommand).taskId;
    const projectId=(command as PrivateProjectCreateCommand).projectId;
    const witness:Witness={kind,id,projectId,areaId,restoreGeneration:g};
    const k=receiptKey(actor,command.commandId),wk=recoveryKey(actor,command.commandId);
    const hash=digest(kind,command);
    const prior=db.prepare("SELECT value FROM metadata WHERE key=?").get(k) as
      {value:string}|undefined;
    if(prior){
      if(prior.value!==hash)return {ok:false,reason:"idempotency_conflict"};
      const w=db.prepare("SELECT value FROM metadata WHERE key=?").get(wk) as
        {value:string}|undefined;
      if(!w||w.value!==witnessValue(witness))return {ok:false,reason:"idempotency_conflict"};
      return liveWitness(db,actor,witness)
        ?{ok:true,replayed:true}:{ok:false,reason:"unavailable"};
    }
    // A stale, partially corrupted receipt/witness pair fails closed.
    if(db.prepare("SELECT 1 FROM metadata WHERE key=?").get(wk))
      return {ok:false,reason:"unavailable"};
    const table=kind==="project"?"projects":"tasks";
    const tombstones=kind==="project"?"project_tombstones":"task_tombstones";
    const used=db.prepare(
      `SELECT 1 FROM ${table} WHERE id=? COLLATE NOCASE
       UNION ALL SELECT 1 FROM ${tombstones} WHERE id=? COLLATE NOCASE LIMIT 1`,
    ).get(id,id);
    if(used)return {ok:false,reason:"unavailable"};
    for(const prefix of [PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX,
      PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX]){
      const n=(db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(prefix+"%") as {n:number}).n;
      if(!Number.isSafeInteger(n)||n>=TARGET_STAGING_MAX_RECEIPTS)return failed();
    }
    const events=(db.prepare("SELECT COUNT(*) AS n FROM change_log").get() as {n:number}).n;
    if(!Number.isSafeInteger(events)||events>=TARGET_STAGING_AUDIT_MAX_EVENTS)return failed();
    fingerprint(databaseFd);
    if(!context.stillPinned()||!context.noSidecars())return denied();
    const inserted=kind==="project"
      ?db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
        .run(id,areaId,command.title)
      :db.prepare("INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)")
        .run(id,projectId,command.title);
    if(inserted.changes!==1||!liveWitness(db,actor,witness))return failed();
    if(kind==="project"){
      const p=db.prepare("SELECT revision FROM projects WHERE id=?")
        .get(id) as {revision:number}|undefined;
      if(p?.revision!==0)return failed();
    }else{
      const t=db.prepare("SELECT revision,status,assignee_user_id FROM tasks WHERE id=?")
        .get(id) as {revision:number;status:string;assignee_user_id:string|null}|undefined;
      if(t?.revision!==0||t.status!=="open"||t.assignee_user_id!==null)return failed();
    }
    db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(k,hash);
    db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
      .run(wk,witnessValue(witness));
    if(!sessionLive()||!context.stillPinned())
      return {ok:false,reason:"session_revoked"};
    if(!context.commit({kind:kind==="project"?"project_create":"project_task_create",
      payload:{}}))return failed();
    return {ok:true};
  },denied,failed);
}

export function readPrivateStructureCreateStatus(
  db:DatabaseSync,actor:string,kind:PrivateStructureKind,command:PrivateStructureCreateCommand,
):PrivateStructureCreateStatus{
  const no=():PrivateStructureCreateStatus=>({ok:false,reason:"unavailable"});
  if(!validPrivateStructureCreateCommand(kind,command))return no();
  if(generation(db)!==command.restoreGeneration.toLowerCase())return no();
  const area=kind==="project"?(command as PrivateProjectCreateCommand).areaId:
    liveProjectArea(db,actor,(command as PrivateProjectTaskCreateCommand).projectId);
  if(!area||!canWriteIsolatedTargetArea(db,actor,area,true))return no();
  const r=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(receiptKey(actor,command.commandId)) as {value:string}|undefined;
  if(!r)return {ok:true,status:"not_recorded"};
  if(r.value!==digest(kind,command))return {ok:false,reason:"idempotency_conflict"};
  const w=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(recoveryKey(actor,command.commandId)) as {value:string}|undefined;
  if(!w)return no();
  const witness=parseWitness(w.value);
  if(!witness||witness.kind!==kind||witness.areaId!==area||
    witness.id!==(kind==="project"?command.projectId:
      (command as PrivateProjectTaskCreateCommand).taskId)||
    witness.projectId!==command.projectId||
    witness.restoreGeneration!==command.restoreGeneration.toLowerCase()||
    !liveWitness(db,actor,witness))return no();
  return {ok:true,status:"committed"};
}

export function readPrivateStructureCreateRecovery(
  db:DatabaseSync,actor:string,kind:PrivateStructureKind,commandId:string,
):PrivateStructureCreateRecovery{
  const no=():PrivateStructureCreateRecovery=>({ok:false,reason:"unavailable"});
  if(!UUID.test(commandId))return no();
  const r=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(receiptKey(actor,commandId)) as {value:string}|undefined;
  const w=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(recoveryKey(actor,commandId)) as {value:string}|undefined;
  if(!r&&!w)return {ok:true,status:"not_recorded"};
  if(!r||!HEX.test(r.value)||!w)return no();
  const witness=parseWitness(w.value);
  if(!witness||witness.kind!==kind||generation(db)!==witness.restoreGeneration||
    !liveWitness(db,actor,witness))return no();
  return {ok:true,status:"committed",id:witness.id,
    projectId:witness.projectId,areaId:witness.areaId};
}
