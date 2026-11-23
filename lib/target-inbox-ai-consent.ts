/**
 * C-3b actor-private target-store AI consent record (v27 metadata namespace).
 *
 * This is only ONE side of the two-store consent contract. A remote call is
 * allowed exclusively when this record AND the separate outside-restore
 * fence agree on actor, enabled, epoch, scope and restore generation.
 *
 * Initial owner-only grant is never executed during import/startup or as a
 * side effect of a read. The operator must explicitly invoke a privileged
 * first-release grant with the 2026-11-19 owner decision. Regrant after a
 * revoke is a new explicit user action, never inferred from restored data.
 *
 * No task names, prompts or AI outputs are stored here.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import {verifiedActor} from "./target-task-authenticated-read";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {lookupLiveTargetStagingSession,isTargetStagingSessionTokenHash}
  from "./target-staging-durable-session";
import {targetStoreRestoreGeneration} from "./target-task-write-preflight";
import {validateC3BMetadataBeforeCommit} from "./target-inbox-metadata-validation";

const USER=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISION=/^[A-Za-z0-9_.:#-]{1,120}$/;
const SCOPE="c3b:v1";
const FIRST_DECISION="owner-2026-11-19-issue-471";
const KEY_PREFIX="r3:c3b:ai-target-consent:v1:";
const HISTORY_PREFIX="r3:c3b:ai-target-decision:v1:";
const epoch=(x:unknown):x is number=>typeof x==="number"&&
  Number.isSafeInteger(x)&&x>0;

export type TargetInboxAIConsent={
  readonly version:1;readonly actorUserId:string;
  readonly enabled:boolean;readonly epoch:number;
  readonly restoreGeneration:string;readonly dataScopeVersion:string;
  readonly ownerDecision:string;readonly decisionSource:string;
  readonly updatedAtMs:number;
};
export type InboxConsentCommand={
  mode:"grant"|"revoke";epoch:number;
  restoreGeneration:string;ownerDecision:string;
  dataScopeVersion:"c3b:v1";
};
export type InboxConsentResult={ok:true;replayed?:true;record:TargetInboxAIConsent}|
  {ok:false;reason:"invalid_request"|"unavailable"|"stale_revision"|
    "session_revoked"|"write_failed"|"resync_required"};

const recordKey=(actor:string):string=>
  KEY_PREFIX+createHash("sha256").update(JSON.stringify([
    "lumi:c3b:target-ai-consent:v1",actor,
  ])).digest("hex");
const historyKey=(actor:string,decision:string):string=>
  HISTORY_PREFIX+createHash("sha256").update(JSON.stringify([
    "lumi:c3b:target-ai-decision:v1",actor,decision,
  ])).digest("hex");
const validCommand=(c:unknown):c is InboxConsentCommand=>{
  if(!c||typeof c!=="object"||Array.isArray(c))return false;
  const x=c as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
    "dataScopeVersion,epoch,mode,ownerDecision,restoreGeneration"&&
    (x.mode==="grant"||x.mode==="revoke")&&epoch(x.epoch)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    typeof x.ownerDecision==="string"&&DECISION.test(x.ownerDecision)&&
    x.dataScopeVersion===SCOPE;
};
const validRecord=(value:unknown):value is TargetInboxAIConsent=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const x=value as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
    "actorUserId,dataScopeVersion,decisionSource,enabled,epoch,ownerDecision,restoreGeneration,updatedAtMs,version"&&
    x.version===1&&typeof x.actorUserId==="string"&&USER.test(x.actorUserId)&&
    typeof x.enabled==="boolean"&&epoch(x.epoch)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    x.dataScopeVersion===SCOPE&&
    typeof x.ownerDecision==="string"&&DECISION.test(x.ownerDecision)&&
    (x.decisionSource==="2026-11-19:#471"||x.decisionSource==="settings:explicit")&&
    typeof x.updatedAtMs==="number"&&Number.isSafeInteger(x.updatedAtMs)&&
    x.updatedAtMs>0;
};
export function readTargetInboxAIConsent(
  db:DatabaseSync,actorUserId:string,
):TargetInboxAIConsent|null{
  if(typeof actorUserId!=="string"||!USER.test(actorUserId))return null;
  try{
    const row=db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(recordKey(actorUserId)) as {value:string}|undefined;
    if(!row||typeof row.value!=="string"||row.value.length>2048)return null;
    const data:unknown=JSON.parse(row.value);
    return validRecord(data)&&data.actorUserId===actorUserId?data:null;
  }catch{return null;}
}
export function targetInboxAIConsentMatchesFence(
  target:TargetInboxAIConsent|null,
  fence:{actorUserId:string;active:boolean;epoch:number;
    restoreGeneration:string;dataScopeVersion:string}|null,
  generation:string,
):boolean{
  return Boolean(target&&fence&&target.enabled&&fence.active&&
    target.actorUserId===fence.actorUserId&&
    target.restoreGeneration===generation.toLowerCase()&&
    fence.restoreGeneration===generation.toLowerCase()&&
    target.epoch===fence.epoch&&
    target.dataScopeVersion===fence.dataScopeVersion&&
    target.dataScopeVersion===SCOPE);
}
/**
 * One safe SQL mutation inside the pinned transaction. The external fence
 * coordinator MUST perform:
 *  grant: target record -> external fence (or vice versa), AI disabled until BOTH;
 *  revoke: external fence marks off FIRST -> target record off.
 *
 * An external fence outage means AI remains off; this writer does not fetch.
 */
export function writePreflightedInboxAIConsent(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  ownerUserId:string,c:InboxConsentCommand,
  durableSessionTokenHash?:string,
):InboxConsentResult{
  const denied=():InboxConsentResult=>({ok:false,reason:"unavailable"});
  const failed=():InboxConsentResult=>({ok:false,reason:"write_failed"});
  if(!validCommand(c)||!USER.test(ownerUserId)||
     (durableSessionTokenHash!==undefined&&
       !isTargetStagingSessionTokenHash(durableSessionTokenHash)))
    return {ok:false,reason:"invalid_request"};
  return withPinnedTargetStagingWrite<InboxConsentResult>(store,ctx=>{
    const actor=verifiedActor(ctx.db,credential,true);
    if(!actor||actor!==ownerUserId)return denied();
    const sessionLive=()=>durableSessionTokenHash===undefined||
      lookupLiveTargetStagingSession(ctx.db,durableSessionTokenHash,Date.now())?.userId===actor;
    if(!sessionLive())return {ok:false,reason:"session_revoked"};
    if(targetStoreRestoreGeneration(ctx.db)!==c.restoreGeneration.toLowerCase()||
       store.expectedRestoreGeneration.toLowerCase()!==c.restoreGeneration.toLowerCase())
      return {ok:false,reason:"resync_required"};
    const prior=readTargetInboxAIConsent(ctx.db,actor);
    const exists=ctx.db.prepare("SELECT 1 FROM metadata WHERE key=?")
      .get(recordKey(actor));
    if(exists&&!prior)return denied(); // malformed prior cannot be overwritten
    if(prior&&prior.epoch===c.epoch&&prior.enabled===(c.mode==="grant")&&
       prior.ownerDecision===c.ownerDecision&&
       prior.restoreGeneration===c.restoreGeneration.toLowerCase()&&
       prior.dataScopeVersion===SCOPE)
      return {ok:true,replayed:true,record:prior};
    if(c.mode==="grant"){
      if(!prior){
        if(c.epoch!==1||c.ownerDecision!==FIRST_DECISION)return denied();
      }else if(prior.enabled||c.epoch!==prior.epoch+1||
         c.ownerDecision===prior.ownerDecision||
         ctx.db.prepare("SELECT 1 FROM metadata WHERE key=?")
           .get(historyKey(actor,c.ownerDecision)))return denied();
    }else{
      // Only an epoch increase toward a REVOKED state is permitted. A partial
      // fence regrant/revoke can advance farther than the stale target epoch.
      if(!prior||c.epoch<=prior.epoch||
         c.ownerDecision!==prior.ownerDecision)return denied();
    }
    if(!ctx.stillPinned()||!ctx.noSidecars())return denied();
    const now=Date.now();
    if(!Number.isSafeInteger(now)||now<=0)return failed();
    const record:TargetInboxAIConsent={version:1,actorUserId:actor,
      enabled:c.mode==="grant",epoch:c.epoch,
      restoreGeneration:c.restoreGeneration.toLowerCase(),
      dataScopeVersion:SCOPE,ownerDecision:c.ownerDecision,
      decisionSource:!prior?"2026-11-19:#471":"settings:explicit",
      updatedAtMs:now};
    if(prior){
      const changed=ctx.db.prepare("UPDATE metadata SET value=? WHERE key=?")
        .run(JSON.stringify(record),recordKey(actor));
      if(changed.changes!==1)return failed();
    }else{
      ctx.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
        .run(recordKey(actor),JSON.stringify(record));
    }
    if(c.mode==="grant")
      ctx.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
        .run(historyKey(actor,c.ownerDecision),String(c.epoch));
    if(!sessionLive()||!ctx.stillPinned())
      return {ok:false,reason:"session_revoked"};
    if(!validateC3BMetadataBeforeCommit(ctx.db))return failed();
    if(!ctx.commit({kind:"inbox_consent",payload:{}}))return failed();
    return {ok:true,record};
  },denied,failed);
}

export const INBOX_FIRST_OWNER_DECISION=FIRST_DECISION;
export const INBOX_AI_DATA_SCOPE_VERSION=SCOPE;
