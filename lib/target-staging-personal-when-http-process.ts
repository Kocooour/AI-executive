/** Bounded subprocess serializers for opt-in R2d.3k.4b private whenOn command/receipt. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {TargetStagingPersonalWhenCommand} from "./target-personal-when-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";

export type PersonalWhenWriteReply =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"unavailable" | "stale_revision" | "idempotency_conflict" |
      "unchanged" | "write_failed" | "session_revoked" | "resync_required" |
      "write_area_mismatch"};
export type PersonalWhenReceiptReply =
  | {ok:true;status:"committed" | "not_recorded"}
  | {ok:false;reason:"unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch"};

export function parsePersonalWhenWriteReply(v:unknown):PersonalWhenWriteReply|null {
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
          Extract<PersonalWhenWriteReply,{ok:false}>["reason"]};
  return null;
}
export function parsePersonalWhenReceiptReply(v:unknown):PersonalWhenReceiptReply|null {
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
      Extract<PersonalWhenReceiptReply,{ok:false}>["reason"]};
  return null;
}
export async function writePersonalWhenInChild(
  config:StagingPersonalReadConfig,command:TargetStagingPersonalWhenCommand,
):Promise<PersonalWhenWriteReply|null> {
  return parsePersonalWhenWriteReply(await runStagingWriteChild(
    config,"target-staging-personal-when-write-child.mjs",JSON.stringify(command)));
}
export async function readPersonalWhenReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingPersonalWhenCommand,
):Promise<PersonalWhenReceiptReply|null> {
  return parsePersonalWhenReceiptReply(await runStagingWriteChild(
    config,"target-staging-personal-when-receipt-child.mjs",JSON.stringify(command)));
}
