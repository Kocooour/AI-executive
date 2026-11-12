/** Bounded child result adapter: no title or actor data ever returned to HTTP. */
import {runStagingWriteChild} from "./target-staging-title-http-process";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {PrivateTaskCreateCommand} from "./target-private-task-create-writer";

export type TaskCreateReply =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"unavailable" | "session_revoked" | "resync_required" |
      "idempotency_conflict" | "write_failed"};
export type TaskCreateStatusReply =
  | {ok:true;status:"committed" | "not_recorded"}
  | {ok:false;reason:"unavailable" | "idempotency_conflict"};

const createErrors=new Set(["unavailable","session_revoked","resync_required",
  "idempotency_conflict","write_failed"]);
export function parseTaskCreateReply(value:unknown):TaskCreateReply|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const r=value as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if(r.ok===true&&keys==="ok")return {ok:true};
  if(r.ok===true&&keys==="ok,replayed"&&r.replayed===true)
    return {ok:true,replayed:true};
  if(r.ok===false&&keys==="ok,reason"&&
    typeof r.reason==="string"&&createErrors.has(r.reason))
    return {ok:false,reason:r.reason as Exclude<TaskCreateReply,{ok:true}>["reason"]};
  return null;
}
export function parseTaskCreateStatusReply(value:unknown):TaskCreateStatusReply|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const r=value as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if(r.ok===true&&keys==="ok,status"&&
    (r.status==="committed"||r.status==="not_recorded"))
    return {ok:true,status:r.status};
  if(r.ok===false&&keys==="ok,reason"&&
    (r.reason==="unavailable"||r.reason==="idempotency_conflict"))
    return {ok:false,reason:r.reason};
  return null;
}
export async function createPrivateTaskInChild(
  config:StagingPersonalReadConfig,request:PrivateTaskCreateCommand,
):Promise<TaskCreateReply|null>{
  return parseTaskCreateReply(await runStagingWriteChild(
    config,"target-staging-task-create-child.mjs",JSON.stringify(request)));
}
export async function readPrivateTaskCreateStatusInChild(
  config:StagingPersonalReadConfig,request:PrivateTaskCreateCommand,
):Promise<TaskCreateStatusReply|null>{
  return parseTaskCreateStatusReply(await runStagingWriteChild(
    config,"target-staging-task-create-status-child.mjs",JSON.stringify(request)));
}

/** Worker-only, strict result: task/Area IDs are not sent to the browser. */
export type TaskCreateRecoveryReply=
  |{ok:true;status:"not_recorded"}
  |{ok:true;status:"committed";taskId:string;areaId:string}
  |{ok:false;reason:"unavailable"};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
export function parseTaskCreateRecoveryReply(v:unknown):TaskCreateRecoveryReply|null{
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const r=v as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if(keys==="ok,status"&&r.ok===true&&r.status==="not_recorded")
    return {ok:true,status:"not_recorded"};
  if(keys==="areaId,ok,status,taskId"&&r.ok===true&&r.status==="committed"&&
    typeof r.taskId==="string"&&UUID.test(r.taskId)&&r.taskId===r.taskId.toLowerCase()&&
    typeof r.areaId==="string"&&AREA.test(r.areaId))
    return {ok:true,status:"committed",taskId:r.taskId,areaId:r.areaId};
  if(keys==="ok,reason"&&r.ok===false&&r.reason==="unavailable")
    return {ok:false,reason:"unavailable"};
  return null;
}
export async function readPrivateTaskCreateRecoveryInChild(
  config:StagingPersonalReadConfig,commandId:string,
):Promise<TaskCreateRecoveryReply|null>{
  if(!UUID.test(commandId))return null;
  return parseTaskCreateRecoveryReply(await runStagingWriteChild(
    config,"target-staging-task-create-status-child.mjs",JSON.stringify({commandId})));
}

/** Strict, content-free cancellation result: no task/Area ID may escape. */
export type TaskCreateCancelReply=
  |{ok:true;status:"cancelled"|"committed"}
  |{ok:false;reason:"unavailable"|"resync_required"|"session_revoked"|"write_failed"};
export function parseTaskCreateCancelReply(v:unknown):TaskCreateCancelReply|null{
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const x=v as Record<string,unknown>,keys=Object.keys(x).sort().join(",");
  if(keys==="ok,status"&&x.ok===true&&
    (x.status==="cancelled"||x.status==="committed"))
    return {ok:true,status:x.status};
  if(keys==="ok,reason"&&x.ok===false&&
    (x.reason==="unavailable"||x.reason==="resync_required"||
      x.reason==="session_revoked"||x.reason==="write_failed"))
    return {ok:false,reason:x.reason};
  return null;
}
export async function cancelPrivateTaskCreateInChild(
  config:StagingPersonalReadConfig,commandId:string,
):Promise<TaskCreateCancelReply|null>{
  if(!UUID.test(commandId))return null;
  return parseTaskCreateCancelReply(await runStagingWriteChild(
    config,"target-staging-task-create-cancel-child.mjs",JSON.stringify({commandId})));
}
