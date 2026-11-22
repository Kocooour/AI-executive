/**
 * C-3b: cryptographically sealed, short-lived commitment to one *displayed*
 * suggestion. The bearer cannot alter action/why/Area/When, and cannot decode
 * actor-private metadata. It is NOT an authorization or a write capability.
 *
 * Accept MUST still revalidate live actor/session, the entire candidate
 * fingerprint, task/When/Area/project CAS, consent/restore and current ACL in
 * ONE pinned BEGIN IMMEDIATE transaction. Never regenerate this token or call
 * AI while accepting. Undo needs an independent, atomic receipt protocol.
 */
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from "node:crypto";
import type {InboxSuggestedChanges,InboxSuggestion} from "./target-inbox-suggestions";

const ID=/^[A-Za-z0-9_.:@-]{1,120}$/;
const TASK=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[0-9a-f]{64}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const DOMAIN="lumi:c3b:inbox-displayed-action:aes256gcm:v1";
const TOKEN_TTL_MS=180_000;
const MAX_TOKEN_CHARS=8192;
const MAX_PLAINTEXT_BYTES=4096;

export type InboxActionCommitmentInput={
  actorUserId:string;taskId:string;sessionTokenHash:string;
  restoreGeneration:string;candidateFingerprint:string;taskWriteRevision:string;
  taskRevision:number;triageRevision:number;
  personalPlanEpoch:number;personalWhenRevision:number|null;
  /** Monotonic revision of authoritative personal timezone/settings. */
  notificationEpoch:number;
  consentEpoch:number;dataScopeVersion:string;
  localDate:string;timeZone:string;
  suggestion:InboxSuggestion;
};
export type InboxActionCommitment=InboxActionCommitmentInput&{
  issuedAtMs:number;expiresAtMs:number;
};
export type InboxActionCommitmentExpect={
  actorUserId:string;taskId:string;sessionTokenHash:string;
  restoreGeneration:string;
  /** Exact fields the client rendered with this token, not a fresh AI choice. */
  displayedChanges:InboxSuggestedChanges;
  displayedWhy:string;
};
const epoch=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const clean=(s:unknown):s is string=>typeof s==="string"&&s.length>0&&
  s.trim()===s&&!/[\u0000-\u001f\u007f]/u.test(s);
const validAreaId=(value:unknown)=>typeof value==="string"&&ID.test(value);
const validChanges=(value:unknown):value is InboxSuggestedChanges=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="effectiveAreaId,projectId,taskAreaId,whenOn"||
     (v.whenOn!=="unchanged"&&(typeof v.whenOn!=="string"||
       !DAY.test(v.whenOn)))||
     (v.projectId!=="unchanged"&&!validAreaId(v.projectId))||
     (v.taskAreaId!=="unchanged"&&v.taskAreaId!==null&&!validAreaId(v.taskAreaId))||
     (v.effectiveAreaId!=="unchanged"&&!validAreaId(v.effectiveAreaId)))return false;
  // Project move: the physical task area MUST be NULL and effective Area
  // MUST explicitly witness the inherited project Area.
  if(v.projectId!=="unchanged")
    return v.taskAreaId===null&&v.effectiveAreaId!=="unchanged";
  // Area-only move does not detach the current project implicitly.
  if(v.taskAreaId!==null&&v.taskAreaId!=="unchanged")
    return v.effectiveAreaId===v.taskAreaId;
  return v.taskAreaId==="unchanged"&&v.effectiveAreaId==="unchanged";
};
const validSuggestion=(value:unknown):value is InboxSuggestion=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).sort().join(",")==="changes,source,why"&&
    (v.source==="rule"||v.source==="ai")&&
    clean(v.why)&&Buffer.byteLength(v.why as string,"utf8")<=512&&
    validChanges(v.changes);
};
export function inboxLocalDate(nowMs:number,timeZone:string):string|null{
  if(!Number.isSafeInteger(nowMs)||nowMs<0||typeof timeZone!=="string"||
     !clean(timeZone)||timeZone.length>80)return null;
  try{
    const parts=new Intl.DateTimeFormat("en-GB",{
      timeZone,year:"numeric",month:"2-digit",day:"2-digit",
    }).formatToParts(new Date(nowMs));
    const field=(name:string)=>parts.find(x=>x.type===name)?.value;
    const year=field("year"),month=field("month"),day=field("day");
    return year&&month&&day?`${year}-${month}-${day}`:null;
  }catch{return null;}
}
const validPayload=(v:unknown,nowMs:number):v is InboxActionCommitmentInput=>{
  if(!v||typeof v!=="object"||Array.isArray(v))return false;
  const x=v as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!==
    "actorUserId,candidateFingerprint,consentEpoch,dataScopeVersion,localDate,notificationEpoch,personalPlanEpoch,personalWhenRevision,restoreGeneration,sessionTokenHash,suggestion,taskId,taskRevision,taskWriteRevision,timeZone,triageRevision")return false;
  if(!validAreaId(x.actorUserId)||typeof x.taskId!=="string"||
     !TASK.test(x.taskId)||x.taskId==="."||x.taskId===".."||
     typeof x.sessionTokenHash!=="string"||!HEX64.test(x.sessionTokenHash)||
     typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
     typeof x.candidateFingerprint!=="string"||!HEX64.test(x.candidateFingerprint)||
     typeof x.taskWriteRevision!=="string"||!HEX64.test(x.taskWriteRevision)||
     !epoch(x.taskRevision)||!epoch(x.triageRevision)||!epoch(x.personalPlanEpoch)||
     (x.personalWhenRevision!==null&&!epoch(x.personalWhenRevision))||
     !epoch(x.notificationEpoch)||!epoch(x.consentEpoch)||!clean(x.dataScopeVersion)||
     (x.dataScopeVersion as string).length>64||
     typeof x.localDate!=="string"||!DAY.test(x.localDate)||
     typeof x.timeZone!=="string"||
     inboxLocalDate(nowMs,x.timeZone)!==x.localDate||
     !validSuggestion(x.suggestion)||
     (x.suggestion.changes.whenOn!=="unchanged"&&
       x.suggestion.changes.whenOn!==x.localDate))return false;
  return x.suggestion.source==="ai"
    ? x.consentEpoch>0
    : x.consentEpoch===0;
};

function encryptionKey(key:Uint8Array):Buffer|null{
  if(!(key instanceof Uint8Array)||key.byteLength<32)return null;
  return createHmac("sha256",Buffer.from(key))
    .update(DOMAIN+"\0key").digest();
}
/** Issue only from a trusted authorized server snapshot and current consent. */
export function sealInboxDisplayedAction(
  payload:InboxActionCommitmentInput,key:Uint8Array,
  nowMs=Date.now(),
):string|null{
  if(!validPayload(payload,nowMs))return null;
  const derived=encryptionKey(key);
  if(!derived)return null;
  const encoded=Buffer.from(JSON.stringify({
    v:1,issuedAtMs:nowMs,expiresAtMs:nowMs+TOKEN_TTL_MS,...payload,
  }),"utf8");
  if(encoded.length>MAX_PLAINTEXT_BYTES)return null;
  try{
    const iv=randomBytes(12);
    const cipher=createCipheriv("aes-256-gcm",derived,iv);
    cipher.setAAD(Buffer.from(DOMAIN,"utf8"));
    const encrypted=Buffer.concat([cipher.update(encoded),cipher.final()]);
    const token="c3b1."+Buffer.concat([iv,cipher.getAuthTag(),encrypted])
      .toString("base64url");
    return token.length<=MAX_TOKEN_CHARS?token:null;
  }catch{return null;}
}

/** Verify exact displayed action and current actor/session/day; nothing is written. */
export function unsealInboxDisplayedAction(
  token:string,key:Uint8Array,expect:InboxActionCommitmentExpect,
  nowMs=Date.now(),
):InboxActionCommitment|null{
  if(typeof token!=="string"||token.length>MAX_TOKEN_CHARS||
     !/^c3b1\.[A-Za-z0-9_-]{48,8192}$/.test(token)||
     !expect||typeof expect!=="object"||Array.isArray(expect)||
     !validChanges(expect.displayedChanges)||!clean(expect.displayedWhy)||
     !Number.isSafeInteger(nowMs)||nowMs<0)return null;
  const derived=encryptionKey(key);
  if(!derived)return null;
  try{
    const buffer=Buffer.from(token.slice(5),"base64url");
    if(buffer.length<29||buffer.toString("base64url")!==token.slice(5))return null;
    const iv=buffer.subarray(0,12),tag=buffer.subarray(12,28);
    const cipherText=buffer.subarray(28);
    if(cipherText.length>MAX_PLAINTEXT_BYTES)return null;
    const decipher=createDecipheriv("aes-256-gcm",derived,iv);
    decipher.setAAD(Buffer.from(DOMAIN,"utf8"));
    decipher.setAuthTag(tag);
    const raw=Buffer.concat([decipher.update(cipherText),decipher.final()]);
    if(raw.length>MAX_PLAINTEXT_BYTES)return null;
    const value:unknown=JSON.parse(raw.toString("utf8"));
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const x=value as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!==
      "actorUserId,candidateFingerprint,consentEpoch,dataScopeVersion,expiresAtMs,issuedAtMs,localDate,notificationEpoch,personalPlanEpoch,personalWhenRevision,restoreGeneration,sessionTokenHash,suggestion,taskId,taskRevision,taskWriteRevision,timeZone,triageRevision,v"||
       x.v!==1||!Number.isSafeInteger(x.issuedAtMs)||
       !Number.isSafeInteger(x.expiresAtMs)||
       (x.issuedAtMs as number)>nowMs||
       (x.expiresAtMs as number)<=nowMs||
       (x.expiresAtMs as number)-(x.issuedAtMs as number)!==TOKEN_TTL_MS)return null;
    const {v,issuedAtMs,expiresAtMs,...p}=x;
    if(!validPayload(p,nowMs)||p.actorUserId!==expect.actorUserId||
       p.taskId!==expect.taskId||
       p.sessionTokenHash!==expect.sessionTokenHash||
       p.restoreGeneration!==expect.restoreGeneration||
       p.suggestion.why!==expect.displayedWhy||
       p.suggestion.changes.whenOn!==expect.displayedChanges.whenOn||
       p.suggestion.changes.projectId!==expect.displayedChanges.projectId||
       p.suggestion.changes.taskAreaId!==expect.displayedChanges.taskAreaId||
       p.suggestion.changes.effectiveAreaId!==expect.displayedChanges.effectiveAreaId)return null;
    return {...p,issuedAtMs:issuedAtMs as number,expiresAtMs:expiresAtMs as number};
  }catch{return null;}
}
