/** Bounded subprocess serializers for opt-in R2d.3h status command/receipt. */
import {parseStagingTemporalDetail,type StagingPersonalReadConfig}
  from "./target-staging-read-process";
import type {TemporalTaskDetail} from "./target-task-temporal-read-model";
import type {TargetStagingTemporalStatusCommand} from "./target-task-temporal-status-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";

export type TemporalStatusWriteReply =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"unavailable" | "stale_revision" | "idempotency_conflict" |
      "unchanged" | "write_failed" | "session_revoked" | "resync_required" |
      "write_area_mismatch"};
export type TemporalStatusReceiptReply =
  | {ok:true;status:"committed" | "not_recorded"}
  | {ok:false;reason:"unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch"};

export function parseTemporalStatusWriteReply(v:unknown):TemporalStatusWriteReply|null {
  if (!v || typeof v!=="object" || Array.isArray(v)) return null;
  const r=v as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if (r.ok===true && keys==="ok") return {ok:true};
  if (r.ok===true && keys==="ok,replayed" && r.replayed===true)
    return {ok:true,replayed:true};
  if (r.ok===false && keys==="ok,reason" && typeof r.reason==="string" &&
      ["unavailable","stale_revision","idempotency_conflict","unchanged",
        "write_failed","session_revoked","resync_required","write_area_mismatch"]
        .includes(r.reason)) return {ok:false,reason:r.reason as
          Extract<TemporalStatusWriteReply,{ok:false}>["reason"]};
  return null;
}
export function parseTemporalStatusReceiptReply(v:unknown):TemporalStatusReceiptReply|null {
  if (!v || typeof v!=="object" || Array.isArray(v)) return null;
  const r=v as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if (r.ok===true && keys==="ok,status" &&
      (r.status==="committed"||r.status==="not_recorded"))
    return {ok:true,status:r.status};
  if (r.ok===false && keys==="ok,reason" && typeof r.reason==="string" &&
      ["unavailable","idempotency_conflict","resync_required",
        "write_area_mismatch"].includes(r.reason))
    return {ok:false,reason:r.reason as
      Extract<TemporalStatusReceiptReply,{ok:false}>["reason"]};
  return null;
}
/** BE-05: exact child DTO; no receipt is released without the same
 * snapshot's task/Area witness and current writer role. */
export type TemporalStatusAtomicReceiptReply =
  | {ok:true;detail:TemporalTaskDetail;receipt:TemporalStatusReceiptReply}
  | {ok:false;reason:"inaccessible"};

export function parseTemporalStatusAtomicReceiptReply(
  value:unknown,taskId:string,
):TemporalStatusAtomicReceiptReply|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(keys==="ok,reason"&&v.ok===false&&v.reason==="inaccessible")
    return {ok:false,reason:"inaccessible"};
  if(keys!=="detail,ok,receipt"||v.ok!==true||
      !v.detail||typeof v.detail!=="object"||Array.isArray(v.detail))
    return null;
  const d=v.detail as Record<string,unknown>;
  if(Object.keys(d).sort().join(",")!=="guard,linearization,task")return null;
  const parsed=parseStagingTemporalDetail({ok:true,...d},taskId);
  if(!parsed||parsed.ok!==true)return null;
  const access=parsed.detail.linearization.areas[0]?.access;
  if(access!=="private-owner"&&access!=="editor"&&access!=="admin")return null;
  const receipt=parseTemporalStatusReceiptReply(v.receipt);
  return receipt?{ok:true,detail:parsed.detail,receipt}:null;
}

export async function readTemporalStatusAtomicReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalStatusCommand,
):Promise<TemporalStatusAtomicReceiptReply|null> {
  // A full task detail can exceed the legacy receipt-only 1 KiB limit.
  // The subprocess remains bounded and its output is allowlisted.
  return parseTemporalStatusAtomicReceiptReply(await runStagingWriteChild(
    config,"target-staging-temporal-status-atomic-receipt-child.mjs",
    JSON.stringify(command),64*1024),command.taskId);
}

export async function writeTemporalTaskStatusInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalStatusCommand,
):Promise<TemporalStatusWriteReply|null> {
  return parseTemporalStatusWriteReply(await runStagingWriteChild(
    config,"target-staging-temporal-status-write-child.mjs",JSON.stringify(command)));
}
export async function readTemporalTaskStatusReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalStatusCommand,
):Promise<TemporalStatusReceiptReply|null> {
  return parseTemporalStatusReceiptReply(await runStagingWriteChild(
    config,"target-staging-temporal-status-receipt-child.mjs",JSON.stringify(command)));
}
