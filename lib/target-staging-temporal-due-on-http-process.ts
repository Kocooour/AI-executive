/** Bounded subprocess serializers for opt-in R2d.3h dueOn command/receipt. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
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
