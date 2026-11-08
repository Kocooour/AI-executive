/** Bounded subprocess serializers for opt-in R2d.5c.2 Attention command/receipt. */
import {parseStagingAttentionCommandPreview,type StagingPersonalReadConfig}
  from "./target-staging-read-process";
import type {AttentionCommandPreview} from "./target-attention-command-read";
import type {TargetStagingAttentionLifecycleCommand}
  from "./target-attention-lifecycle-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";

export type AttentionCommandWriteReply =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"invalid_request" | "unavailable" | "stale_revision" |
      "idempotency_conflict" | "unchanged" | "not_active" | "write_failed" |
      "session_revoked" | "resync_required" | "write_area_mismatch"};
export type AttentionCommandReceiptReply =
  | {ok:true;status:"committed" | "not_recorded"}
  | {ok:false;reason:"unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch"};
const WRITE_REASONS=["invalid_request","unavailable","stale_revision",
  "idempotency_conflict","unchanged","not_active","write_failed","session_revoked",
  "resync_required","write_area_mismatch"];
export const ATTENTION_WRITE_REASONS:readonly string[]=WRITE_REASONS;
export const ATTENTION_RECEIPT_REASONS:readonly string[]=
  ["unavailable","idempotency_conflict","resync_required","write_area_mismatch"];

export function parseAttentionCommandWriteReply(v:unknown):AttentionCommandWriteReply|null {
  if (!v || typeof v!=="object" || Array.isArray(v)) return null;
  const r=v as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if (r.ok===true && keys==="ok") return {ok:true};
  if (r.ok===true && keys==="ok,replayed" && r.replayed===true)
    return {ok:true,replayed:true};
  if (r.ok===false && keys==="ok,reason" && typeof r.reason==="string" &&
      WRITE_REASONS.includes(r.reason)) return {ok:false,reason:r.reason as
        Extract<AttentionCommandWriteReply,{ok:false}>["reason"]};
  return null;
}
export function parseAttentionCommandReceiptReply(v:unknown):AttentionCommandReceiptReply|null {
  if (!v || typeof v!=="object" || Array.isArray(v)) return null;
  const r=v as Record<string,unknown>;
  const keys=Object.keys(r).sort().join(",");
  if (r.ok===true && keys==="ok,status" &&
      (r.status==="committed"||r.status==="not_recorded"))
    return {ok:true,status:r.status};
  if (r.ok===false && keys==="ok,reason" && typeof r.reason==="string" &&
      ATTENTION_RECEIPT_REASONS.includes(r.reason))
    return {ok:false,reason:r.reason as
      Extract<AttentionCommandReceiptReply,{ok:false}>["reason"]};
  return null;
}
/** No receipt can be published without the exact same snapshot's attention
 * epoch and task/Area linearization witness. */
export type AttentionCommandReceiptSnapshotReply=
  | {ok:true;preview:AttentionCommandPreview;receipt:AttentionCommandReceiptReply}
  | {ok:false;reason:"inaccessible"};

export function parseAttentionCommandReceiptSnapshotReply(
  value:unknown,taskId:string,
):AttentionCommandReceiptSnapshotReply|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(keys==="ok,reason"&&v.ok===false&&v.reason==="inaccessible")
    return {ok:false,reason:"inaccessible"};
  if(keys!=="ok,preview,receipt"||v.ok!==true||
    !v.preview||typeof v.preview!=="object"||Array.isArray(v.preview))
    return null;
  const parsed=parseStagingAttentionCommandPreview(
    {ok:true,...(v.preview as Record<string,unknown>)},taskId);
  if(!parsed||parsed.ok!==true)return null;
  const receipt=parseAttentionCommandReceiptReply(v.receipt);
  return receipt?{ok:true,preview:parsed.preview,receipt}:null;
}

export async function readAttentionCommandReceiptSnapshotInChild(
  config:StagingPersonalReadConfig,command:TargetStagingAttentionLifecycleCommand,
):Promise<AttentionCommandReceiptSnapshotReply|null> {
  return parseAttentionCommandReceiptSnapshotReply(await runStagingWriteChild(
    config,"target-staging-attention-command-receipt-child.mjs",
    JSON.stringify(command),32*1024),command.taskId);
}
export async function writeAttentionCommandInChild(
  config:StagingPersonalReadConfig,command:TargetStagingAttentionLifecycleCommand,
):Promise<AttentionCommandWriteReply|null> {
  return parseAttentionCommandWriteReply(await runStagingWriteChild(
    config,"target-staging-attention-command-write-child.mjs",JSON.stringify(command)));
}
