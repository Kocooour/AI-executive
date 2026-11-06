/** Bounded subprocess serializers for opt-in R2d.3i.2 dueOn command/receipt. */
import {parseStagingTemporalDetail,type StagingPersonalReadConfig}
  from "./target-staging-read-process";
import type {TemporalTaskDetail} from "./target-task-temporal-read-model";
import type {TargetStagingTemporalDueOnCommand} from "./target-task-temporal-due-on-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";

export type TemporalDueOnWriteReply =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"unavailable" | "stale_revision" | "idempotency_conflict" |
      "unchanged" | "write_failed" | "session_revoked" | "resync_required" |
      "write_area_mismatch"};
export type TemporalDueOnReceiptReply =
  | {ok:true;status:"committed" | "not_recorded"}
  | {ok:false;reason:"unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch"};

export function parseTemporalDueOnWriteReply(v:unknown):TemporalDueOnWriteReply|null {
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
          Extract<TemporalDueOnWriteReply,{ok:false}>["reason"]};
  return null;
}
export function parseTemporalDueOnReceiptReply(v:unknown):TemporalDueOnReceiptReply|null {
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
      Extract<TemporalDueOnReceiptReply,{ok:false}>["reason"]};
  return null;
}
/** BE-07 exact allowlist: current writable task witness and original
 * dueOn command receipt are from the same pinned database snapshot. */
export type TemporalDueOnAtomicReceiptReply=
  | {ok:true;detail:TemporalTaskDetail;receipt:TemporalDueOnReceiptReply}
  | {ok:false;reason:"inaccessible"};

export function parseTemporalDueOnAtomicReceiptReply(
  value:unknown,taskId:string,
):TemporalDueOnAtomicReceiptReply|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(keys==="ok,reason"&&v.ok===false&&v.reason==="inaccessible")
    return {ok:false,reason:"inaccessible"};
  if(keys!=="detail,ok,receipt"||v.ok!==true||
    !v.detail||typeof v.detail!=="object"||Array.isArray(v.detail))return null;
  const d=v.detail as Record<string,unknown>;
  if(Object.keys(d).sort().join(",")!=="guard,linearization,task")return null;
  const parsed=parseStagingTemporalDetail({ok:true,...d},taskId);
  if(!parsed||parsed.ok!==true)return null;
  const access=parsed.detail.linearization.areas[0]?.access;
  if(access!=="private-owner"&&access!=="editor"&&access!=="admin")return null;
  const receipt=parseTemporalDueOnReceiptReply(v.receipt);
  return receipt?{ok:true,detail:parsed.detail,receipt}:null;
}

export async function readTemporalDueOnAtomicReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalDueOnCommand,
):Promise<TemporalDueOnAtomicReceiptReply|null> {
  // A task detail can exceed a legacy receipt-only 1 KiB response. Only
  // this worker receives a larger explicit cap and exact response parser.
  return parseTemporalDueOnAtomicReceiptReply(await runStagingWriteChild(
    config,"target-staging-temporal-due-on-atomic-receipt-child.mjs",
    JSON.stringify(command),64*1024),command.taskId);
}

export async function writeTemporalDueOnInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalDueOnCommand,
):Promise<TemporalDueOnWriteReply|null> {
  return parseTemporalDueOnWriteReply(await runStagingWriteChild(
    config,"target-staging-temporal-due-on-write-child.mjs",JSON.stringify(command)));
}
export async function readTemporalDueOnReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingTemporalDueOnCommand,
):Promise<TemporalDueOnReceiptReply|null> {
  return parseTemporalDueOnReceiptReply(await runStagingWriteChild(
    config,"target-staging-temporal-due-on-receipt-child.mjs",JSON.stringify(command)));
}
