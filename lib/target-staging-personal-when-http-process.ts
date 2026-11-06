/** Bounded subprocess serializers for opt-in R2d.3k.4b private whenOn command/receipt. */
import {parseStagingPersonalWhenPreview,type StagingPersonalReadConfig}
  from "./target-staging-read-process";
import type {PersonalWhenCommandPreview} from "./target-personal-when-command-read";
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
/** BE-06: no receipt can be published without the exact same snapshot's
 * actor-private epoch and task/Area linearization witness. */
export type PersonalWhenAtomicReceiptReply=
  | {ok:true;preview:PersonalWhenCommandPreview;receipt:PersonalWhenReceiptReply}
  | {ok:false;reason:"inaccessible"};

export function parsePersonalWhenAtomicReceiptReply(
  value:unknown,taskId:string,
):PersonalWhenAtomicReceiptReply|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(keys==="ok,reason"&&v.ok===false&&v.reason==="inaccessible")
    return {ok:false,reason:"inaccessible"};
  if(keys!=="ok,preview,receipt"||v.ok!==true||
    !v.preview||typeof v.preview!=="object"||Array.isArray(v.preview))
    return null;
  const preview=v.preview as Record<string,unknown>;
  if(Object.keys(preview).sort().join(",")!==
    "expectedPlanRevision,expectedPrivateEpoch,expectedRevision,guard,linearization,whenOn,writeAreaId")
    return null;
  const parsed=parseStagingPersonalWhenPreview({ok:true,...preview},taskId);
  if(!parsed||parsed.ok!==true)return null;
  const receipt=parsePersonalWhenReceiptReply(v.receipt);
  return receipt?{ok:true,preview:parsed.preview,receipt}:null;
}

export async function readPersonalWhenAtomicReceiptInChild(
  config:StagingPersonalReadConfig,command:TargetStagingPersonalWhenCommand,
):Promise<PersonalWhenAtomicReceiptReply|null> {
  // Task IDs and Area witnesses can exceed the legacy 1 KiB receipt-only cap.
  // Restrict the higher bound to this allowlisted worker, not other commands.
  return parsePersonalWhenAtomicReceiptReply(await runStagingWriteChild(
    config,"target-staging-personal-when-atomic-receipt-child.mjs",
    JSON.stringify(command),32*1024),command.taskId);
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
