/** Strict subprocess boundary for private project and project-child task commands. */
import {runStagingWriteChild} from "./target-staging-title-http-process";
import {isReadableStagingProjectId} from "./target-project-id";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {PrivateStructureKind,PrivateStructureCreateCommand,
  PrivateStructureCreateRecovery} from "./target-private-structure-create-writer";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
export type StructureCreateReply=
  |{ok:true;replayed?:true}
  |{ok:false;reason:"unavailable"|"session_revoked"|"resync_required"|
      "idempotency_conflict"|"write_failed"};
export type StructureStatusReply=
  |{ok:true;status:"committed"|"not_recorded"}
  |{ok:false;reason:"unavailable"|"idempotency_conflict"};
const failure=new Set(["unavailable","session_revoked","resync_required",
  "idempotency_conflict","write_failed"]);
const record=(v:unknown):Record<string,unknown>|null=>
  v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
export function parseStructureCreateReply(v:unknown):StructureCreateReply|null{
  const r=record(v);if(!r)return null;
  const keys=Object.keys(r).sort().join(",");
  if(r.ok===true&&keys==="ok")return {ok:true};
  if(r.ok===true&&keys==="ok,replayed"&&r.replayed===true)return {ok:true,replayed:true};
  if(r.ok===false&&keys==="ok,reason"&&typeof r.reason==="string"&&failure.has(r.reason))
    return {ok:false,reason:r.reason as Exclude<StructureCreateReply,{ok:true}>["reason"]};
  return null;
}
export function parseStructureStatusReply(v:unknown):StructureStatusReply|null{
  const r=record(v);if(!r)return null;
  const keys=Object.keys(r).sort().join(",");
  if(keys==="ok,status"&&r.ok===true&&(r.status==="committed"||r.status==="not_recorded"))
    return {ok:true,status:r.status};
  if(keys==="ok,reason"&&r.ok===false&&
    (r.reason==="unavailable"||r.reason==="idempotency_conflict"))
    return {ok:false,reason:r.reason};
  return null;
}
export function parseStructureRecoveryReply(v:unknown):PrivateStructureCreateRecovery|null{
  const r=record(v);if(!r)return null;
  const keys=Object.keys(r).sort().join(",");
  if(r.ok===true&&keys==="ok,status"&&r.status==="not_recorded")
    return {ok:true,status:"not_recorded"};
  if(r.ok===false&&keys==="ok,reason"&&r.reason==="unavailable")
    return {ok:false,reason:"unavailable"};
  if(r.ok===true&&keys==="areaId,id,ok,projectId,status"&&r.status==="committed"&&
    typeof r.id==="string"&&UUID.test(r.id)&&r.id===r.id.toLowerCase()&&
    isReadableStagingProjectId(r.projectId)&&
    typeof r.areaId==="string"&&AREA.test(r.areaId))
    return {ok:true,status:"committed",id:r.id,projectId:r.projectId,areaId:r.areaId};
  return null;
}
async function run(config:StagingPersonalReadConfig,kind:PrivateStructureKind,
  mode:"create"|"status"|"recovery",command:PrivateStructureCreateCommand|{commandId:string},
):Promise<unknown|null>{
  return runStagingWriteChild(config,"target-staging-structure-create-child.mjs",
    JSON.stringify({kind,mode,command}));
}
export async function createStructureInChild(
  cfg:StagingPersonalReadConfig,kind:PrivateStructureKind,command:PrivateStructureCreateCommand,
):Promise<StructureCreateReply|null>{
  return parseStructureCreateReply(await run(cfg,kind,"create",command));
}
export async function readStructureCreateStatusInChild(
  cfg:StagingPersonalReadConfig,kind:PrivateStructureKind,command:PrivateStructureCreateCommand,
):Promise<StructureStatusReply|null>{
  return parseStructureStatusReply(await run(cfg,kind,"status",command));
}
export async function readStructureCreateRecoveryInChild(
  cfg:StagingPersonalReadConfig,kind:PrivateStructureKind,commandId:string,
):Promise<PrivateStructureCreateRecovery|null>{
  if(!UUID.test(commandId))return null;
  return parseStructureRecoveryReply(await run(cfg,kind,"recovery",{commandId}));
}
