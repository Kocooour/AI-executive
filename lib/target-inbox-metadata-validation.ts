/**
 * Canonical v27 metadata preflight for the C-3b namespaces. Do not weaken the
 * global unknown-metadata rejection: only these exact four prefixes are legal.
 * The public ledger contains no task titles, notes, prompts, AI outputs or
 * provider credentials; however it DOES hold owner-private task/plan IDs and
 * dates, so never include values in errors, logs or an HTTP response.
 */
import {createHash} from "node:crypto";

export const C3B_ACCEPT_PREFIX="r3:c3b:accept:v1:";
export const C3B_UNDO_PREFIX="r3:c3b:undo:v1:";
export const C3B_CONSENT_PREFIX="r3:c3b:ai-target-consent:v1:";
export const C3B_DECISION_PREFIX="r3:c3b:ai-target-decision:v1:";
const PREFIXES=[C3B_ACCEPT_PREFIX,C3B_UNDO_PREFIX,
  C3B_CONSENT_PREFIX,C3B_DECISION_PREFIX] as const;
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_ACCEPT=4096,MAX_CONSENT=4096,MAX_BYTES=8192;
const epoch=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const keys=(value:Record<string,unknown>,names:string):boolean=>
  Object.keys(value).sort().join(",")===names;
const object=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&
  typeof x==="object"&&!Array.isArray(x);
const optionalId=(x:unknown):boolean=>x===null||
  (typeof x==="string"&&x.length>0&&x.length<=512&&
    x.trim()===x&&!/[\u0000-\u001f\u007f]/u.test(x));
const day=(x:unknown):boolean=>x===null||(typeof x==="string"&&
  /^\d{4}-\d{2}-\d{2}$/.test(x)&&
  Number.isFinite(Date.parse(x+"T00:00:00Z"))&&
  new Date(x+"T00:00:00Z").toISOString().slice(0,10)===x);
const digest=(parts:unknown[]):string=>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const entryKey=(prefix:string,actor:string,id:string):string=>prefix+digest([
  "lumi:c3b:compound-inbox-receipt:v1",actor,id.toLowerCase(),
]);
const consentKey=(actor:string):string=>C3B_CONSENT_PREFIX+digest([
  "lumi:c3b:target-ai-consent:v1",actor,
]);
const decisionKey=(actor:string,decision:string):string=>
  C3B_DECISION_PREFIX+digest(["lumi:c3b:target-ai-decision:v1",actor,decision]);

export type C3BMetadataPreflight={
  valid:boolean;
  count:number;
  /** Caller still checks the exact whitelist and v27 schema before acceptance. */
  prefixes:readonly string[];
};
export function validateC3BMetadata(
  rows:readonly {key:unknown;value:unknown}[],
  actorIds:readonly string[],
):C3BMetadataPreflight{
  const list=rows.filter(r=>typeof r.key==="string"&&
    PREFIXES.some(p=>r.key.startsWith(p)));
  const invalid={valid:false,count:list.length,prefixes:PREFIXES};
  const accept=list.filter(r=>(r.key as string).startsWith(C3B_ACCEPT_PREFIX));
  const undo=list.filter(r=>(r.key as string).startsWith(C3B_UNDO_PREFIX));
  const consents=list.filter(r=>(r.key as string).startsWith(C3B_CONSENT_PREFIX));
  const decisions=list.filter(r=>(r.key as string).startsWith(C3B_DECISION_PREFIX));
  if(accept.length+undo.length>MAX_ACCEPT||consents.length>actorIds.length||
    decisions.length>MAX_CONSENT)return invalid;
  const actors=new Set(actorIds);
  const accepted=new Map<string,Record<string,unknown>>();
  try{
    for(const row of accept){
      if(typeof row.key!=="string"||typeof row.value!=="string"||
         Buffer.byteLength(row.value,"utf8")>MAX_BYTES||
         !HEX.test(row.key.slice(C3B_ACCEPT_PREFIX.length)))return invalid;
      const x:unknown=JSON.parse(row.value);
      if(!object(x)||!keys(x,
        "actor,after,before,commandId,committedAtMs,digest,kind,restoreGeneration,taskId,v")||
        x.v!==1||x.kind!=="accept"||typeof x.actor!=="string"||
        !actors.has(x.actor)||typeof x.taskId!=="string"||
        !optionalId(x.taskId)||x.taskId===null||
        typeof x.commandId!=="string"||!UUID.test(x.commandId)||
        typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
        typeof x.digest!=="string"||!HEX.test(x.digest)||
        !epoch(x.committedAtMs)||(x.committedAtMs as number)<=0||
        row.key!==entryKey(C3B_ACCEPT_PREFIX,x.actor,x.commandId)||
        !object(x.before)||!object(x.after))return invalid;
      const b=x.before,a=x.after;
      if(!keys(b,"areaId,effectiveAreaId,planRevision,projectId,taskRevision,triageRevision,whenOn")||
         !keys(a,"areaId,effectiveAreaId,planRevision,projectId,taskRevision,triageRevision,triagedAtMs,whenOn")||
         !optionalId(b.projectId)||!optionalId(a.projectId)||
         !optionalId(b.areaId)||!optionalId(a.areaId)||
         typeof b.effectiveAreaId!=="string"||!optionalId(b.effectiveAreaId)||
         typeof a.effectiveAreaId!=="string"||!optionalId(a.effectiveAreaId)||
         !day(b.whenOn)||!day(a.whenOn)||
         (b.planRevision!==null&&!epoch(b.planRevision))||
         (a.planRevision!==null&&!epoch(a.planRevision))||
         !epoch(b.taskRevision)||!epoch(a.taskRevision)||
         !epoch(b.triageRevision)||!epoch(a.triageRevision)||
         a.triageRevision!==b.triageRevision+1||
         (a.taskRevision!==b.taskRevision+1&&a.taskRevision!==b.taskRevision+2)||
         !epoch(a.triagedAtMs)||(a.triagedAtMs as number)<=0)return invalid;
      accepted.set(row.key,x);
    }
    const usedOriginals=new Set<string>();
    for(const row of undo){
      if(typeof row.key!=="string"||typeof row.value!=="string"||
         Buffer.byteLength(row.value,"utf8")>MAX_BYTES||
         !HEX.test(row.key.slice(C3B_UNDO_PREFIX.length)))return invalid;
      const x:unknown=JSON.parse(row.value);
      if(!object(x)||!keys(x,
        "actor,commandId,committedAtMs,digest,kind,restoreGeneration,taskId,undoOfCommandId,v")||
        x.v!==1||x.kind!=="undo"||
        typeof x.actor!=="string"||!actors.has(x.actor)||
        typeof x.commandId!=="string"||!UUID.test(x.commandId)||
        typeof x.undoOfCommandId!=="string"||!UUID.test(x.undoOfCommandId)||
        x.commandId.toLowerCase()===x.undoOfCommandId.toLowerCase()||
        typeof x.taskId!=="string"||!optionalId(x.taskId)||
        typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
        typeof x.digest!=="string"||!HEX.test(x.digest)||
        !epoch(x.committedAtMs)||(x.committedAtMs as number)<=0||
        row.key!==entryKey(C3B_UNDO_PREFIX,x.actor,x.undoOfCommandId))
        return invalid;
      const origKey=entryKey(C3B_ACCEPT_PREFIX,x.actor,x.undoOfCommandId);
      const orig=accepted.get(origKey);
      if(!orig||orig.taskId!==x.taskId||
         orig.restoreGeneration!==x.restoreGeneration||
         (orig.committedAtMs as number)>=(x.committedAtMs as number)||
         usedOriginals.has(origKey))return invalid;
      usedOriginals.add(origKey);
    }
    for(const row of consents){
      if(typeof row.key!=="string"||typeof row.value!=="string"||
         Buffer.byteLength(row.value,"utf8")>2048||
         !HEX.test(row.key.slice(C3B_CONSENT_PREFIX.length)))return invalid;
      const x:unknown=JSON.parse(row.value);
      if(!object(x)||!keys(x,
        "actorUserId,dataScopeVersion,decisionSource,enabled,epoch,ownerDecision,restoreGeneration,updatedAtMs,version")||
        x.version!==1||typeof x.actorUserId!=="string"||
        !actors.has(x.actorUserId)||row.key!==consentKey(x.actorUserId)||
        typeof x.enabled!=="boolean"||!epoch(x.epoch)||x.epoch===0||
        typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
        x.dataScopeVersion!=="c3b:v1"||
        typeof x.ownerDecision!=="string"||
        !/^[A-Za-z0-9_.:#-]{1,120}$/.test(x.ownerDecision)||
        (x.decisionSource!=="2026-11-19:#471"&&
         x.decisionSource!=="settings:explicit")||
        !epoch(x.updatedAtMs)||(x.updatedAtMs as number)<=0)return invalid;
      const h=rows.find(r=>r.key===decisionKey(x.actorUserId,x.ownerDecision));
      if(!h||typeof h.value!=="string"||!/^[1-9]\d{0,15}$/.test(h.value)||
         Number(h.value)>(x.epoch as number))return invalid;
    }
    for(const row of decisions){
      if(typeof row.key!=="string"||typeof row.value!=="string"||
         !HEX.test(row.key.slice(C3B_DECISION_PREFIX.length))||
         !/^[1-9]\d{0,15}$/.test(row.value)||
         !Number.isSafeInteger(Number(row.value)))return invalid;
    }
    return {valid:true,count:list.length,prefixes:PREFIXES};
  }catch{return invalid;}
}
