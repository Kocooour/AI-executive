/** Bounded, content-free result adapter for the private note create HTTP worker. */
import { runStagingWriteChild } from "./target-staging-title-http-process";
import type { StagingPersonalReadConfig } from "./target-staging-read-process";
import type { TargetStagingNoteLifecycleRequest } from "./target-note-lifecycle-writer";

type Reason = "unavailable" | "session_revoked" | "resync_required" |
  "idempotency_conflict" | "write_failed";
export type NoteCreateReply = { ok: true; replayed?: true } |
  { ok: false; reason: Reason };
const reasons = new Set<string>([
  "unavailable", "session_revoked", "resync_required",
  "idempotency_conflict", "write_failed",
]);

export function parseNoteCreateReply(value: unknown): NoteCreateReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (r.ok === true && keys === "ok") return { ok: true };
  if (r.ok === true && keys === "ok,replayed" && r.replayed === true)
    return { ok: true, replayed: true };
  if (r.ok === false && keys === "ok,reason" &&
      typeof r.reason === "string" && reasons.has(r.reason))
    return { ok: false, reason: r.reason as Reason };
  return null;
}

export async function createPrivateStagingNoteInChild(
  config: StagingPersonalReadConfig,
  request: Extract<TargetStagingNoteLifecycleRequest, { kind: "create" }>,
): Promise<NoteCreateReply | null> {
  const value = await runStagingWriteChild(
    config, "target-staging-note-create-child.mjs", JSON.stringify(request),
  );
  return parseNoteCreateReply(value);
}

/** Only receipt metadata crosses the worker boundary. Never note content. */
export type NoteCreateRecoveryReply=
  |{ok:true;status:"not_recorded"}
  |{ok:true;status:"committed";noteId:string;areaId:string}
  |{ok:false;reason:"unavailable"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
export function parseNoteCreateRecoveryReply(value:unknown):NoteCreateRecoveryReply|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join(",");
  if(v.ok===true&&keys==="ok,status"&&v.status==="not_recorded")
    return {ok:true,status:"not_recorded"};
  if(v.ok===true&&keys==="areaId,noteId,ok,status"&&v.status==="committed"&&
     typeof v.noteId==="string"&&uuid.test(v.noteId)&&
     typeof v.areaId==="string"&&v.areaId.trim()===v.areaId&&
     v.areaId.length>0&&Buffer.byteLength(v.areaId,"utf8")<=512&&
     !/[\u0000-\u001f\u007f]/u.test(v.areaId))
    return {ok:true,status:"committed",noteId:v.noteId,areaId:v.areaId};
  if(v.ok===false&&keys==="ok,reason"&&v.reason==="unavailable")
    return {ok:false,reason:"unavailable"};
  return null;
}
export async function readStagingNoteCreateRecoveryInChild(
  config:StagingPersonalReadConfig,commandId:string,
):Promise<NoteCreateRecoveryReply|null>{
  if(!uuid.test(commandId))return null;
  const value=await runStagingWriteChild(config,
    "target-staging-note-create-recovery-child.mjs",
    JSON.stringify({commandId}));
  return parseNoteCreateRecoveryReply(value);
}
