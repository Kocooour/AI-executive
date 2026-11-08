/** Bounded subprocess serializers for opt-in R2d.5d.3 notification settings / push device writes. */
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {
  TargetStagingNotificationSettingsCommand,TargetStagingPushTargetCommand,
} from "./target-notification-writer";
import {runStagingWriteChild} from "./target-staging-title-http-process";

/** `unauthorized` stays a 503 as in the template; never forwarded to a client. */
export const NOTIFICATION_WRITE_REASONS:readonly string[]=[
  "invalid_request","unavailable","stale_revision","idempotency_conflict","unchanged",
  "write_failed","session_revoked","resync_required",
];
type Reason="invalid_request"|"unavailable"|"stale_revision"|"idempotency_conflict"|
  "unchanged"|"write_failed"|"session_revoked"|"resync_required";
export type NotificationSettingsWriteReply=
  | {ok:true;replayed?:true}
  | {ok:false;reason:Reason};
export type NotificationTargetWriteReply=
  | {ok:true;targetId:string|null;replayed?:true}
  | {ok:false;reason:"unchanged";targetId:string}
  | {ok:false;reason:Exclude<Reason,"unchanged">};

const record=(v:unknown):Record<string,unknown>|null=>
  !v||typeof v!=="object"||Array.isArray(v)?null:v as Record<string,unknown>;
const TARGET_ID=/^pt_[0-9a-f]{32}$/;

export function parseNotificationSettingsWriteReply(v:unknown):NotificationSettingsWriteReply|null {
  const r=record(v);if(!r)return null;
  const keys=Object.keys(r).sort().join(",");
  if(r.ok===true&&keys==="ok")return {ok:true};
  if(r.ok===true&&keys==="ok,replayed"&&r.replayed===true)return {ok:true,replayed:true};
  if(r.ok===false&&keys==="ok,reason"&&typeof r.reason==="string"&&
    NOTIFICATION_WRITE_REASONS.includes(r.reason))
    return {ok:false,reason:r.reason as Reason};
  return null;
}
export function parseNotificationTargetWriteReply(v:unknown):NotificationTargetWriteReply|null {
  const r=record(v);if(!r)return null;
  const keys=Object.keys(r).sort().join(",");
  const id=(x:unknown)=>typeof x==="string"&&TARGET_ID.test(x);
  if(r.ok===true&&keys==="ok,targetId"&&(id(r.targetId)||r.targetId===null))
    return {ok:true,targetId:r.targetId as string|null};
  if(r.ok===true&&keys==="ok,replayed,targetId"&&r.replayed===true&&
    (id(r.targetId)||r.targetId===null))
    return {ok:true,replayed:true,targetId:r.targetId as string|null};
  if(r.ok===false&&keys==="ok,reason,targetId"&&r.reason==="unchanged"&&id(r.targetId))
    return {ok:false,reason:"unchanged",targetId:r.targetId as string};
  if(r.ok===false&&keys==="ok,reason"&&typeof r.reason==="string"&&r.reason!=="unchanged"&&
    NOTIFICATION_WRITE_REASONS.includes(r.reason))
    return {ok:false,reason:r.reason as Exclude<Reason,"unchanged">};
  return null;
}

export async function writeNotificationSettingsInChild(
  config:StagingPersonalReadConfig,command:TargetStagingNotificationSettingsCommand,
):Promise<NotificationSettingsWriteReply|null> {
  return parseNotificationSettingsWriteReply(await runStagingWriteChild(
    config,"target-staging-notification-settings-write-child.mjs",JSON.stringify(command)));
}
/** The command carries only the endpoint HASH; the raw endpoint never reaches a child. */
export async function writeNotificationTargetInChild(
  config:StagingPersonalReadConfig,command:TargetStagingPushTargetCommand,
):Promise<NotificationTargetWriteReply|null> {
  return parseNotificationTargetWriteReply(await runStagingWriteChild(
    config,"target-staging-notification-target-write-child.mjs",JSON.stringify(command)));
}
