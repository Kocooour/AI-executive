/** Bounded subprocess serializers for opt-in R2d.3h status command/receipt. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
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
