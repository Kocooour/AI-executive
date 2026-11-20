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

/** C-3a command handoff belongs to the tab's authenticated runtime, not a
 * transient Inbox component. Route changes must never discard an in-flight
 * UUID or make a second Process/Undo available before receipt reconciliation.
 * Memory only: no task content, commands or IDs enter browser storage. */

export type InboxDecision={
  command:InboxClientCommand;title:string;processId:string;
  stage:"sending"|"verifying"|"uncertain"|"undo-ready"|"conflict"|"denied"|"undone";
  next:{expectedRevision:string;triageRevision:number;writeAreaId:string}|null;
};
type ScopedDecision={runtime:TargetClientRuntime;generation:string;
  decision:InboxDecision;unbind:()=>void};
const decisionListeners=new Set<()=>void>();
let scopedDecision:ScopedDecision|null=null;
const pending=(stage:InboxDecision["stage"])=>
  stage==="sending"||stage==="verifying"||stage==="uncertain";
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
