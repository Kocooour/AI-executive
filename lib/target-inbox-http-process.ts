/** C-3a strict bounded worker responses. No untrusted actor/Area witness reaches UI. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import {parseStagingTargetInboxPage} from "./target-staging-read-process";
import type {TargetInboxTriageCommand} from "./target-inbox-triage-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";

export type InboxWriteReply={ok:true;replayed?:true}|{ok:false;reason:
  "unavailable"|"resync_required"|"write_area_mismatch"|"session_revoked"|
  "stale_revision"|"idempotency_conflict"|"write_failed"|"cancelled"};
export type InboxReceiptReply={
  ok:true;status:"committed"|"not_recorded"|"cancelled"|"conflict";
  next:{expectedRevision:string;triageRevision:number;writeAreaId:string}|null;
  areaEpochs:HomeSummaryAreaEpoch[];
  linearization:TargetReadLinearization;
};
const revision=/^[a-f0-9]{64}$/;
export function parseInboxWriteReply(raw:unknown):InboxWriteReply|null{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>,keys=Object.keys(v).sort().join(",");
  if(v.ok===true&&keys==="ok")return {ok:true};
  if(v.ok===true&&keys==="ok,replayed"&&v.replayed===true)
    return {ok:true,replayed:true};
  if(v.ok===false&&keys==="ok,reason"&&[
    "unavailable","resync_required","write_area_mismatch","session_revoked",
    "stale_revision","idempotency_conflict","write_failed","cancelled",
  ].includes(v.reason as string))return {ok:false,reason:v.reason as
    Extract<InboxWriteReply,{ok:false}>["reason"]};
  return null;
}
export function parseInboxReceiptReply(raw:unknown):InboxReceiptReply|null{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="areaEpochs,linearization,next,ok,status"||
      v.ok!==true||!["committed","not_recorded","cancelled","conflict"].includes(v.status as string))
    return null;
  const witness=parseStagingTargetInboxPage({ok:true,count:0,items:[],
    nextCursor:null,areaEpochs:v.areaEpochs,linearization:v.linearization},50);
  if(!witness)return null;
  let next:InboxReceiptReply["next"]=null;
  if(v.next!==null){
    if(!["committed","cancelled"].includes(v.status as string)||
        !v.next||typeof v.next!=="object"||Array.isArray(v.next))
      return null;
    const n=v.next as Record<string,unknown>;
    if(Object.keys(n).sort().join(",")!=="expectedRevision,triageRevision,writeAreaId"||
        typeof n.expectedRevision!=="string"||!revision.test(n.expectedRevision)||
        !Number.isSafeInteger(n.triageRevision)||(n.triageRevision as number)<0||
        typeof n.writeAreaId!=="string"||!n.writeAreaId||
        Buffer.byteLength(n.writeAreaId)>512)return null;
    next={expectedRevision:n.expectedRevision,triageRevision:n.triageRevision as number,
      writeAreaId:n.writeAreaId};
    if(!witness.areaEpochs.some(a=>a.areaId===next!.writeAreaId&&
      (a.access==="private-owner"||a.access==="editor"||a.access==="admin")))return null;
  }
  return {ok:true,status:v.status as InboxReceiptReply["status"],next,
    linearization:witness.linearization,areaEpochs:witness.areaEpochs};
}
export type InboxCancelReply={ok:true;status:"committed"|"cancelled"}|
  {ok:false;reason:"unavailable"|"resync_required"|"session_revoked"|
    "write_failed"|"idempotency_conflict"};
export function parseInboxCancelReply(raw:unknown):InboxCancelReply|null{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")==="ok,status"&&v.ok===true&&
      (v.status==="committed"||v.status==="cancelled"))
    return {ok:true,status:v.status};
  if(Object.keys(v).sort().join(",")==="ok,reason"&&v.ok===false&&
      ["unavailable","resync_required","session_revoked","write_failed",
        "idempotency_conflict"].includes(v.reason as string))
    return {ok:false,reason:v.reason as Extract<InboxCancelReply,{ok:false}>["reason"]};
  return null;
}
export const cancelInboxTriageInChild=async(
  config:StagingPersonalReadConfig,command:TargetInboxTriageCommand,
):Promise<InboxCancelReply|null>=>parseInboxCancelReply(await runStagingWriteChild(
  config,"target-staging-inbox-cancel-child.mjs",JSON.stringify(command)));

export const writeInboxTriageInChild=async(
  config:StagingPersonalReadConfig,command:TargetInboxTriageCommand,
):Promise<InboxWriteReply|null>=>parseInboxWriteReply(await runStagingWriteChild(
  config,"target-staging-inbox-triage-child.mjs",JSON.stringify(command)));
export const readInboxTriageReceiptInChild=async(
  config:StagingPersonalReadConfig,command:TargetInboxTriageCommand,
):Promise<InboxReceiptReply|null>=>parseInboxReceiptReply(await runStagingWriteChild(
  config,"target-staging-inbox-receipt-child.mjs",JSON.stringify(command),512*1024));
