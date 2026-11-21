import type {InboxClientCommand} from "./target-inbox-client";
import type {TargetClientRuntime} from "./target-client-runtime";

/** R3-FE-4b: in-memory change notice. After a committed edit/delete in the detail panel the
 * screens that show this item (scope lists, sidebar projects, My Plan rows) re-read through
 * the shared read queue. The notice carries only the kind and opaque ID; it is never
 * persisted, never leaves the page, and a subscriber decides if and when to re-read. */
export type TargetChange={kind:"task"|"note";id:string;change:"updated"|"deleted"};
const listeners=new Set<(change:TargetChange)=>void>();

export function subscribeTargetChange(listener:(change:TargetChange)=>void):()=>void{
  listeners.add(listener);
  return ()=>{listeners.delete(listener);};
}
export function emitTargetChange(change:TargetChange):void{
  for(const listener of [...listeners]){
    try{listener(change);}catch{/* one broken subscriber must not stop the others */}
  }
}
/** Test only. */
export const targetChangeListenerCount=():number=>listeners.size;

/** In-memory only: a write with unknown outcome suppresses all actor-scoped
 * Inbox badges until its ORIGINAL command receipt has been reconciled.
 * Generation scopes the suppression; a new signed-in actor cannot inherit it. */
const inboxUncertainListeners=new Set<()=>void>();
let inboxUncertainGeneration="";
export function subscribeInboxUncertain(listener:()=>void):()=>void{
  inboxUncertainListeners.add(listener);
  return ()=>inboxUncertainListeners.delete(listener);
}
export const inboxUncertainSnapshot=():string=>inboxUncertainGeneration;
export function setInboxUncertain(generation:string|null):void{
  const next=generation??"";
  if(inboxUncertainGeneration===next)return;
  inboxUncertainGeneration=next;
  for(const fn of [...inboxUncertainListeners]){try{fn();}catch{/*no blocked peers*/}}
}

/** A paginated ACL refusal is distinct from an unresolved write. It must
 * suppress every Inbox surface until a NEW verified session and a NEW GET.
 * A late GET from before the refusal is never allowed to clear this fence.
 * securityEpoch invalidates every old useInbox page key when the fence changes. */
const inboxSecurityListeners=new Set<()=>void>();
let inboxSecurityEpoch=0;
let inboxRefusal:{runtime:TargetClientRuntime;generation:string}|null=null;
export function subscribeInboxSecurity(fn:()=>void):()=>void{
  inboxSecurityListeners.add(fn);
  return ()=>{inboxSecurityListeners.delete(fn);};
}
export const inboxSecurityVersion=():number=>inboxSecurityEpoch;
function notifyInboxSecurity():void{
  inboxSecurityEpoch++;
  for(const fn of [...inboxSecurityListeners]){try{fn();}catch{/* independent views */}}
}
export function inboxRefused(runtime:TargetClientRuntime|null,generation:string):boolean{
  return runtime!==null&&inboxRefusal?.runtime===runtime&&
    inboxRefusal.generation===generation;
}
export function markInboxRefused(runtime:TargetClientRuntime,generation:string):void{
  if(inboxRefused(runtime,generation))return;
  inboxRefusal={runtime,generation};
  notifyInboxSecurity();
}
/** Only call after runtime.refresh()==="ok" (or a confirmed passive tick).
 * Changing the epoch before requesting a fresh page makes a prior in-flight
 * GET's old key unusable, even if it resolves after this session check. */
export function clearInboxRefusedAfterSession(
  runtime:TargetClientRuntime,generation:string,
):void{
  if(!runtime.known()||runtime.generation()!==generation||
      !inboxRefused(runtime,generation))return;
  inboxRefusal=null;
  notifyInboxSecurity();
}

/** C-3a command handoff belongs to the tab's authenticated runtime, not a
 * transient Inbox component. Route changes must never discard an in-flight
 * UUID or make a second Process/Undo available before receipt reconciliation.
 * A minimal original-command recovery witness is stored in tab-scoped
 * sessionStorage before dispatch so a reload cannot silently create a new UUID.
 * No task titles, sessions, tokens or authorization data are persisted. */

export type InboxDecision={
  command:InboxClientCommand;title:string;processId:string;
  stage:"sending"|"verifying"|"uncertain"|"not-recorded"|"undo-ready"|"conflict"|"denied"|"undone";
  next:{expectedRevision:string;triageRevision:number;writeAreaId:string}|null;
};
type ScopedDecision={runtime:TargetClientRuntime;generation:string;
  decision:InboxDecision;unbind:()=>void};
const decisionListeners=new Set<()=>void>();
let scopedDecision:ScopedDecision|null=null;
const pending=(stage:InboxDecision["stage"])=>
  stage==="sending"||stage==="verifying"||stage==="uncertain"||stage==="not-recorded";
/** A tab-only, content-free recovery witness is written BEFORE dispatch.
 * The original UUID/CAS must survive a reload while a write is ambiguous.
 * Never persist task titles, session tokens, or an authorization decision. */
const INBOX_RECOVERY_KEY="lumi:target-inbox-command:v1";
type InboxRecovery={version:1;generation:string;command:InboxClientCommand;processId:string};
const recoveryUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoverySha=/^[a-f0-9]{64}$/;
function validRecovery(x:unknown):x is InboxRecovery{
  if(!x||typeof x!=="object"||Array.isArray(x))return false;
  const r=x as Record<string,unknown>;
  if(r.version!==1||typeof r.generation!=="string"||
      !r.generation||typeof r.processId!=="string"||
      !recoveryUuid.test(r.processId)||!r.command||
      typeof r.command!=="object"||Array.isArray(r.command))return false;
  const c=r.command as Record<string,unknown>;
  return typeof c.commandId==="string"&&recoveryUuid.test(c.commandId)&&
    typeof c.taskId==="string"&&c.taskId.length>0&&c.taskId.length<=512&&
    typeof c.expectedRevision==="string"&&recoverySha.test(c.expectedRevision)&&
    typeof c.expectedTriageRevision==="number"&&
    Number.isSafeInteger(c.expectedTriageRevision)&&c.expectedTriageRevision>=0&&
    typeof c.writeAreaId==="string"&&c.writeAreaId.length>0&&c.writeAreaId.length<=120&&
    typeof c.restoreGeneration==="string"&&recoveryUuid.test(c.restoreGeneration)&&
    (c.mode==="process"&&c.undoOfCommandId===null&&r.processId===c.commandId||
      c.mode==="undo"&&typeof c.undoOfCommandId==="string"&&
      recoveryUuid.test(c.undoOfCommandId)&&r.processId===c.undoOfCommandId);
}
function persistInboxRecovery(generation:string,decision:InboxDecision):boolean{
  if(typeof window==="undefined")return true;
  try{
    if(pending(decision.stage)){
      const record:InboxRecovery={version:1,generation,
        command:decision.command,processId:decision.processId};
      window.sessionStorage.setItem(INBOX_RECOVERY_KEY,JSON.stringify(record));
    }else window.sessionStorage.removeItem(INBOX_RECOVERY_KEY);
    return true;
  }catch{return false;} // Do NOT dispatch a write without a recovery witness.
}
function forgetInboxRecovery():void{
  if(typeof window==="undefined")return;
  try{window.sessionStorage.removeItem(INBOX_RECOVERY_KEY);}catch{/* fail closed on next restore */}
}
/** Called after a fresh authenticated generation is known, before displaying
 * any Inbox rows or badges. A persisted command is NEVER resubmitted: the user
 * can only reconcile its original read-only receipt. */
export function restoreInboxDecision(
  runtime:TargetClientRuntime,generation:string,
):boolean{
  if(!runtime.known()||runtime.generation()!==generation)return false;
  if(inboxDecisionSnapshot(runtime,generation))return true;
  if(typeof window==="undefined")return true;
  try{
    const raw=window.sessionStorage.getItem(INBOX_RECOVERY_KEY);
    if(raw===null)return true;
    if(raw.length>4096)return false;
    const value:unknown=JSON.parse(raw);
    if(!validRecovery(value))return false;
    if(value.generation!==generation){forgetInboxRecovery();return true;}
    return setInboxDecision(runtime,generation,{
      command:value.command,processId:value.processId,
      title:"",stage:"uncertain",next:null,
    });
  }catch{return false;}
}
const notifyDecision=()=>{
  for(const fn of [...decisionListeners]){try{fn();}catch{/* independent views */}}
};
export function subscribeInboxDecision(fn:()=>void):()=>void{
  decisionListeners.add(fn);return ()=>{decisionListeners.delete(fn);};
}
export function inboxDecisionSnapshot(
  runtime:TargetClientRuntime|null,generation:string,
):InboxDecision|null{
  return runtime&&runtime.known()&&runtime.generation()===generation&&
    scopedDecision?.runtime===runtime&&scopedDecision.generation===generation
    ?scopedDecision.decision:null;
}
function retireDecision(runtime:TargetClientRuntime,generation:string):void{
  const old=scopedDecision;
  if(!old||old.runtime!==runtime||old.generation!==generation)return;
  scopedDecision=null;
  old.unbind();
  forgetInboxRecovery();
  if(inboxUncertainSnapshot()===generation)setInboxUncertain(null);
  notifyDecision();
}
export function clearInboxDecision(runtime:TargetClientRuntime,generation:string):void{
  retireDecision(runtime,generation);
}
export function setInboxDecision(
  runtime:TargetClientRuntime,generation:string,decision:InboxDecision,
):boolean{
  if(!runtime.known()||runtime.generation()!==generation)return false;
  const old=scopedDecision;
  if(old&&(old.runtime!==runtime||old.generation!==generation))
    retireDecision(old.runtime,old.generation);
  const current=scopedDecision;
  // A late completion or a newly mounted Inbox cannot overwrite a still
  // unresolved DIFFERENT UUID (including the original Undo command).
  if(current&&current.decision.command.commandId!==decision.command.commandId&&
    pending(current.decision.stage))return false;
  if(!persistInboxRecovery(generation,decision))return false;
  if(!current){
    const stopGeneration=runtime.subscribe(()=>{
      if(!runtime.known()||runtime.generation()!==generation)
        retireDecision(runtime,generation);
    });
    const stopSecurity=runtime.subscribeSecurityClear(()=>
      retireDecision(runtime,generation));
    scopedDecision={runtime,generation,decision,
      unbind:()=>{stopGeneration();stopSecurity();}};
  }else scopedDecision={...current,decision};
  setInboxUncertain(pending(decision.stage)?generation:null);
  notifyDecision();
  return true;
}
