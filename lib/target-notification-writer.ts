/**
 * R2d.5d.2: isolated actor-private notification settings and push target
 * writers (staging only). No HTTP route, UI, web-push call, scheduler or
 * production activation. The principal is a server-issued WRITE credential;
 * command payloads cannot select an actor, and only the actor's OWN settings
 * row and OWN targets can change. Enabling push sends nothing: it only lets
 * the push pass record a baseline later. Targets store only the SHA-256 of the
 * endpoint (computed by the caller), never the endpoint or keys.
 */
import {createHash,randomBytes} from "node:crypto";
import {TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX,
  TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX,
  TARGET_STAGING_PUSH_BASELINE_PREFIX} from "./target-store-bootstrap";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {verifiedActor} from "./target-task-authenticated-read";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {fingerprint} from "./target-task-staging-writer";
import {attentionEvaluationWindow} from "./target-attention-read-model";
import {targetStoreRestoreGeneration} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HHMM=/^([01]\d|2[0-3]):[0-5]\d$/;
const HASH=/^[a-f0-9]{64}$/;
const TARGET_ID=/^pt_[0-9a-f]{32}$/;
const epoch=(value:unknown):value is number=>
  typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&
  value<9007199254740991;
const OP={settings:0,register:1,revoke:2} as const;

/** Content-free baseline marker key of one identity (see push pass). */
export const targetPushBaselineKey=(userId:string):string=>
  TARGET_STAGING_PUSH_BASELINE_PREFIX+
  createHash("sha256").update(userId).digest("hex");
export const targetPushBaselineValue=(userId:string):string=>
  createHash("sha256").update(JSON.stringify(["push-baseline-v1",userId])).digest("hex");

// ---------------------------------------------------------------- settings
export interface TargetStagingNotificationSettingsCommand {
  readonly commandId:string;
  readonly timeZone:string;
  readonly attentionPush:boolean;
  readonly quietStart:string;
  readonly quietEnd:string;
  readonly dailyLimit:number;
  readonly paused:boolean;
  /** personal_notification_settings.revision of the actor's row. */
  readonly expectedSettingsRevision:number;
  /** Actor's personal_notification_epochs.revision. */
  readonly expectedNotificationEpoch:number;
  readonly restoreGeneration:string;
}
export type TargetStagingNotificationReason=
  "invalid_request"|"unauthorized"|"unavailable"|"stale_revision"|
  "idempotency_conflict"|"unchanged"|"write_failed"|"session_revoked"|
  "resync_required";
export type TargetStagingNotificationSettingsResult=
  | {ok:true;replayed?:true}
  | {ok:false;reason:TargetStagingNotificationReason};

const denied=():{ok:false;reason:"unauthorized"}=>({ok:false,reason:"unauthorized"});
const failed=():{ok:false;reason:"write_failed"}=>({ok:false,reason:"write_failed"});

export function validTargetStagingNotificationSettingsCommand(
  input:unknown,
):input is TargetStagingNotificationSettingsCommand {
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
      "attentionPush,commandId,dailyLimit,expectedNotificationEpoch,expectedSettingsRevision,paused,quietEnd,quietStart,restoreGeneration,timeZone"&&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.timeZone==="string"&&attentionEvaluationWindow(0,x.timeZone)!==null&&
    typeof x.attentionPush==="boolean"&&typeof x.paused==="boolean"&&
    typeof x.quietStart==="string"&&HHMM.test(x.quietStart)&&
    typeof x.quietEnd==="string"&&HHMM.test(x.quietEnd)&&
    typeof x.dailyLimit==="number"&&Number.isInteger(x.dailyLimit)&&
    x.dailyLimit>=0&&x.dailyLimit<=10&&
    epoch(x.expectedSettingsRevision)&&epoch(x.expectedNotificationEpoch)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration);
}

export function notificationSettingsReceiptKey(actor:string,commandId:string):string {
  return TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX+createHash("sha256")
    .update(JSON.stringify(["personal-notification-settings-v1",actor,commandId.toLowerCase()]))
    .digest("hex");
}
export function notificationSettingsReceiptDigest(
  c:TargetStagingNotificationSettingsCommand,
):string {
  return createHash("sha256").update(JSON.stringify([
    "personal-notification-settings-v1",c.timeZone,c.attentionPush,c.quietStart,
    c.quietEnd,c.dailyLimit,c.paused,c.expectedSettingsRevision,
    c.expectedNotificationEpoch,c.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

/** One authenticated, preflighted BEGIN IMMEDIATE transaction; every refusal rolls back. */
export function writePreflightedNotificationSettings(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetStagingNotificationSettingsCommand,durableSessionTokenHash?:string,
):TargetStagingNotificationSettingsResult {
  if(!validTargetStagingNotificationSettingsCommand(command))
    return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetStagingNotificationSettingsResult>(
    store,context=>{
      const {db,databaseFd}=context;
      const actor=verifiedActor(db,credential,true);
      if(!actor)return denied();
      const sessionLive=():boolean=>{
        if(durableSessionTokenHash===undefined)return true;
        const live=lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now());
        return live!==null&&live.userId===actor;
      };
      if(!sessionLive())return {ok:false,reason:"session_revoked"};
      const generation=targetStoreRestoreGeneration(db);
      if(generation===null||generation!==command.restoreGeneration.toLowerCase())
        return {ok:false,reason:"resync_required"};
      const receipt=notificationSettingsReceiptKey(actor,command.commandId);
      const digest=notificationSettingsReceiptDigest(command);
      const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receipt) as {value:string}|undefined;
      if(prior)return prior.value===digest
        ? {ok:true,replayed:true}:{ok:false,reason:"idempotency_conflict"};
      fingerprint(databaseFd);
      const row=db.prepare(
        "SELECT time_zone AS zone,attention_push AS push,quiet_start AS qs,quiet_end AS qe,"+
        " daily_limit AS lim,paused,revision FROM personal_notification_settings WHERE user_id=?"
      ).get(actor) as {zone:string;push:number;qs:string;qe:string;lim:number;
        paused:number;revision:number}|undefined;
      const epochRow=db.prepare(
        "SELECT revision FROM personal_notification_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!row||!epoch(row.revision)||!epochRow||!epoch(epochRow.revision))return failed();
      if(row.revision!==command.expectedSettingsRevision||
          epochRow.revision!==command.expectedNotificationEpoch)
        return {ok:false,reason:"stale_revision"};
      const next={push:command.attentionPush?1:0,paused:command.paused?1:0};
      if(row.zone===command.timeZone&&row.push===next.push&&row.qs===command.quietStart&&
          row.qe===command.quietEnd&&row.lim===command.dailyLimit&&row.paused===next.paused)
        return {ok:false,reason:"unchanged"};
      if(!context.stillPinned()||!context.noSidecars())return denied();
      const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX+"%") as {n:number};
      if(existing.n>=TARGET_STAGING_MAX_RECEIPTS)return failed();
      if(db.prepare(
        "UPDATE personal_notification_settings SET time_zone=?,attention_push=?,quiet_start=?,"+
        "quiet_end=?,daily_limit=?,paused=? WHERE user_id=?"
      ).run(command.timeZone,next.push,command.quietStart,command.quietEnd,
        command.dailyLimit,next.paused,actor).changes!==1)return failed();
      // Turning push OFF forgets the baseline (legacy parity): a later enable
      // starts from a fresh baseline instead of announcing the backlog.
      if(row.push===1&&next.push===0)
        db.prepare("DELETE FROM metadata WHERE key=?").run(targetPushBaselineKey(actor));
      const after=db.prepare(
        "SELECT revision FROM personal_notification_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      const rev=db.prepare(
        "SELECT revision FROM personal_notification_settings WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!after||after.revision!==epochRow.revision+1||!rev||rev.revision!==row.revision+1)
        return failed();
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
      if(!sessionLive()||!context.stillPinned())
        return {ok:false,reason:"session_revoked"};
      // No actor, zone, times or flags in the append-only journal.
      context.commit({kind:"personal_notification",payload:{
        receiptHash:receipt.slice(TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX.length),
        epoch:after.revision,op:OP.settings,
      }});
      return {ok:true};
    },denied,failed);
}

// ----------------------------------------------------------------- targets
export type TargetStagingPushTargetCommand=
  | {readonly commandId:string;readonly action:"register";
     /** SHA-256 hex of the endpoint, computed by the caller; the endpoint is never stored. */
     readonly endpointHash:string;
     readonly expectedNotificationEpoch:number;readonly restoreGeneration:string}
  | {readonly commandId:string;readonly action:"revoke";readonly targetId:string;
     readonly expectedNotificationEpoch:number;readonly restoreGeneration:string};
export type TargetStagingPushTargetResult=
  | {ok:true;targetId:string;replayed?:true}
  | {ok:true;targetId:null;replayed?:true}
  | {ok:false;reason:"unchanged";targetId:string}
  | {ok:false;reason:Exclude<TargetStagingNotificationReason,"unchanged">};

export function validTargetStagingPushTargetCommand(
  input:unknown,
):input is TargetStagingPushTargetCommand {
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const x=input as Record<string,unknown>;
  const common=typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    epoch(x.expectedNotificationEpoch)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration);
  if(x.action==="register")
    return common&&Object.keys(x).sort().join(",")===
        "action,commandId,endpointHash,expectedNotificationEpoch,restoreGeneration"&&
      typeof x.endpointHash==="string"&&HASH.test(x.endpointHash);
  if(x.action==="revoke")
    return common&&Object.keys(x).sort().join(",")===
        "action,commandId,expectedNotificationEpoch,restoreGeneration,targetId"&&
      typeof x.targetId==="string"&&TARGET_ID.test(x.targetId);
  return false;
}

export function pushTargetReceiptKey(actor:string,commandId:string):string {
  return TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX+createHash("sha256")
    .update(JSON.stringify(["personal-push-target-v1",actor,commandId.toLowerCase()]))
    .digest("hex");
}
export function pushTargetReceiptDigest(c:TargetStagingPushTargetCommand):string {
  return createHash("sha256").update(JSON.stringify([
    "personal-push-target-v1",c.action,
    c.action==="register"?c.endpointHash:c.targetId,
    c.expectedNotificationEpoch,c.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

export function writePreflightedPushTarget(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  command:TargetStagingPushTargetCommand,durableSessionTokenHash?:string,
):TargetStagingPushTargetResult {
  if(!validTargetStagingPushTargetCommand(command))
    return {ok:false,reason:"invalid_request"};
  if(durableSessionTokenHash!==undefined&&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<TargetStagingPushTargetResult>(
    store,context=>{
      const {db,databaseFd}=context;
      const actor=verifiedActor(db,credential,true);
      if(!actor)return denied();
      const sessionLive=():boolean=>{
        if(durableSessionTokenHash===undefined)return true;
        const live=lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now());
        return live!==null&&live.userId===actor;
      };
      if(!sessionLive())return {ok:false,reason:"session_revoked"};
      const generation=targetStoreRestoreGeneration(db);
      if(generation===null||generation!==command.restoreGeneration.toLowerCase())
        return {ok:false,reason:"resync_required"};
      const receipt=pushTargetReceiptKey(actor,command.commandId);
      const digest=pushTargetReceiptDigest(command);
      const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receipt) as {value:string}|undefined;
      if(prior){
        if(prior.value!==digest)return {ok:false,reason:"idempotency_conflict"};
        // Replay: only this actor's own row can be named; nothing else leaks.
        const own=command.action==="register"
          ? db.prepare("SELECT target_id AS id FROM personal_push_targets WHERE user_id=? AND endpoint_hash=?")
              .get(actor,command.endpointHash) as {id:string}|undefined
          : {id:command.targetId};
        return {ok:true,replayed:true,targetId:own?.id??null};
      }
      fingerprint(databaseFd);
      const epochRow=db.prepare(
        "SELECT revision FROM personal_notification_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!epochRow||!epoch(epochRow.revision))return failed();
      if(epochRow.revision!==command.expectedNotificationEpoch)
        return {ok:false,reason:"stale_revision"};
      if(!context.stillPinned()||!context.noSidecars())return denied();
      const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX+"%") as {n:number};
      if(existing.n>=TARGET_STAGING_MAX_RECEIPTS)return failed();
      const now=Date.now();
      let targetId:string;
      if(command.action==="register"){
        const owned=db.prepare(
          "SELECT user_id AS userId,target_id AS id,revoked_at_ms AS revoked FROM personal_push_targets WHERE endpoint_hash=?"
        ).get(command.endpointHash) as {userId:string;id:string;revoked:number|null}|undefined;
        // Another identity's endpoint (even a revoked row) is never transferred
        // and is indistinguishable from any other unavailable answer.
        if(owned&&owned.userId!==actor)return {ok:false,reason:"unavailable"};
        if(owned)return owned.revoked===null
          ? {ok:false,reason:"unchanged",targetId:owned.id}
          : {ok:false,reason:"unavailable"};
        const mine=db.prepare("SELECT COUNT(*) AS n FROM personal_push_targets WHERE user_id=?")
          .get(actor) as {n:number};
        const total=db.prepare("SELECT COUNT(*) AS n FROM personal_push_targets")
          .get() as {n:number};
        if(mine.n>=64||total.n>=4096)return failed();
        targetId="pt_"+randomBytes(16).toString("hex");
        if(db.prepare(
          "INSERT INTO personal_push_targets(user_id,target_id,endpoint_hash,created_at_ms) VALUES (?,?,?,?)"
        ).run(actor,targetId,command.endpointHash,now).changes!==1)return failed();
      }else{
        const own=db.prepare(
          "SELECT created_at_ms AS created,revoked_at_ms AS revoked FROM personal_push_targets WHERE user_id=? AND target_id=?"
        ).get(actor,command.targetId) as {created:number;revoked:number|null}|undefined;
        if(!own||own.revoked!==null)return {ok:false,reason:"unavailable"};
        targetId=command.targetId;
        if(db.prepare(
          "UPDATE personal_push_targets SET revoked_at_ms=? WHERE user_id=? AND target_id=? AND revoked_at_ms IS NULL"
        ).run(Math.max(now,own.created),actor,targetId).changes!==1)return failed();
      }
      const after=db.prepare(
        "SELECT revision FROM personal_notification_epochs WHERE user_id=?"
      ).get(actor) as {revision:number}|undefined;
      if(!after||after.revision!==epochRow.revision+1)return failed();
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
      if(!sessionLive()||!context.stillPinned())
        return {ok:false,reason:"session_revoked"};
      // No actor, target ID or endpoint hash in the append-only journal.
      context.commit({kind:"personal_notification",payload:{
        receiptHash:receipt.slice(TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX.length),
        epoch:after.revision,op:command.action==="register"?OP.register:OP.revoke,
      }});
      return {ok:true,targetId};
    },denied,failed);
}

// -------------------------------------------------------------------- read
export interface TargetNotificationSettingsView {
  readonly timeZone:string;readonly attentionPush:boolean;
  readonly quietStart:string;readonly quietEnd:string;readonly dailyLimit:number;
  readonly paused:boolean;readonly settingsRevision:number;
  readonly notificationEpoch:number;
  /** The actor's own live target IDs, oldest first. Never hashes or endpoints. */
  readonly targetIds:readonly string[];
}

/** Snapshot read of ONE verified actor's settings, epoch and live target IDs. */
export function readNotificationSettingsInSnapshot(
  db:import("node:sqlite").DatabaseSync,actor:string,
):TargetNotificationSettingsView|null {
  const row=db.prepare(
    "SELECT time_zone AS zone,attention_push AS push,quiet_start AS qs,quiet_end AS qe,"+
    " daily_limit AS lim,paused,revision FROM personal_notification_settings WHERE user_id=?"
  ).get(actor) as {zone:string;push:number;qs:string;qe:string;lim:number;
    paused:number;revision:number}|undefined;
  const e=db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?")
    .get(actor) as {revision:number}|undefined;
  if(!row||!e||!epoch(row.revision)||!epoch(e.revision))return null;
  const ids=(db.prepare(
    "SELECT target_id AS id FROM personal_push_targets WHERE user_id=? AND revoked_at_ms IS NULL ORDER BY created_at_ms,target_id"
  ).all(actor) as {id:string}[]).map(r=>r.id);
  return {timeZone:row.zone,attentionPush:row.push===1,quietStart:row.qs,
    quietEnd:row.qe,dailyLimit:row.lim,paused:row.paused===1,
    settingsRevision:row.revision,notificationEpoch:e.revision,targetIds:ids};
}
