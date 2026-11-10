/** R3-FE-4b: recover ONE exact in-memory idempotent project title edit per project.
 * This coordinator outlives a disposable inspector but not the authenticated
 * target runtime/generation. A content-free tab barrier covers reload; only
 * a sealed memory-only command may survive an explicitly coded session_expired
 * and it cannot be disclosed until the new SERVER-verified actor matches.
 */
import {
  saveProjectTitleEdit,type ProjectTitleEditCommand,type ProjectTitleEditSaveResult,type ProjectTitleEditPreview,
} from "./target-staging-project-title-edit-client";
import {TARGET_PROJECT_TITLE_UPDATED} from "./target-project-title-edit-ui-gate";
import {projectTitleReloadMarker,confirmProjectTitleReload,rejectFirstProjectTitleReload}
  from "./target-project-title-reload";
import type {TargetClientRuntime} from "./target-client-runtime";

export type ProjectTitleEditRuntime=Pick<TargetClientRuntime,"generation"|"known"|"register">&
  Partial<Pick<TargetClientRuntime,"subscribeSecurityClear"|"reportRefusal">>;
export const TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS=20_000;
export type TrackedProjectTitleEditPhase="saving"|"uncertain"|"conflict"|"denied"|"saved";
export type TrackedProjectTitleEdit={
  readonly command:ProjectTitleEditCommand;
  readonly phase:TrackedProjectTitleEditPhase;
};
type Entry={
  command:ProjectTitleEditCommand;
  phase:TrackedProjectTitleEditPhase;
  principalBinding:string|null;
  wasUncertain:boolean;
  controller:AbortController|null;
  pending:Promise<ProjectTitleEditSaveResult>|null;
  cancel:()=>void;
};
export type ProjectTitleDraft={original:string;title:string;writeAreaId:string;expectedRevision:string;restoreGeneration:string};
export function projectTitleDraftConflicts(draft:ProjectTitleDraft,preview:ProjectTitleEditPreview,currentTitle:string):boolean{
  return draft.original!==currentTitle||draft.writeAreaId!==preview.writeAreaId||
    draft.expectedRevision!==preview.expectedRevision||
    draft.restoreGeneration.toLowerCase()!==preview.restoreGeneration.toLowerCase();
}
type Bucket={
  generation:string;
  drafts:Map<string,ProjectTitleDraft>;
  entries:Map<string,Entry>;
  listeners:Map<string,Set<()=>void>>;
  disposed:boolean;
};
const buckets=new WeakMap<ProjectTitleEditRuntime,Bucket>();
const BINDING=/^[A-Za-z0-9_-]{43}$/;
type SealedEntry={command:ProjectTitleEditCommand;principalBinding:string};
type SealedBucket={entries:Map<string,SealedEntry>;unsubscribe:()=>void};
const sealed=new WeakMap<ProjectTitleEditRuntime,SealedBucket>();
function clearSealed(runtime:ProjectTitleEditRuntime):void{
  const state=sealed.get(runtime);if(!state)return;
  sealed.delete(runtime);state.entries.clear();state.unsubscribe();
}
function retainExpired(runtime:ProjectTitleEditRuntime,id:string,entry:Entry):void{
  const binding=entry.principalBinding;
  // Do not retain private content when the server-issued actor proof or
  // runtime security-clear subscription is unavailable.
  if(!binding||!BINDING.test(binding)||!runtime.subscribeSecurityClear)return;
  let state=sealed.get(runtime);
  if(!state){
    state={entries:new Map(),unsubscribe:()=>{}};
    sealed.set(runtime,state);
    state.unsubscribe=runtime.subscribeSecurityClear(()=>clearSealed(runtime));
    if(sealed.get(runtime)!==state)return;
  }
  state.entries.set(id,{command:entry.command,principalBinding:binding});
}
/** Only the existence of a sealed write can be observed pre-reauth. No title. */
export const hasSealedProjectTitleEdit=(runtime:ProjectTitleEditRuntime,id:string):boolean=>
  sealed.get(runtime)?.entries.has(id)===true;
/** The only way to unseal a command after expiry: separately authenticated
 * GET preview must give the SAME HMAC actor/project/restore binding, and the
 * tab barrier must still match the original UUID. No client actor claim.
 * A mismatch erases private sealed data but never unlocks the global barrier. */
export function resumeSealedProjectTitleEdit(
  runtime:ProjectTitleEditRuntime,generation:string,id:string,preview:ProjectTitleEditPreview,
):"resumed"|"blocked"|"missing"{
  const state=sealed.get(runtime),held=state?.entries.get(id);
  if(!held)return "missing";
  if(!runtime.known()||runtime.generation()!==generation)return "blocked";
  const marker=projectTitleReloadMarker(generation);
  if(marker.kind!=="blocked"||marker.commandId!==held.command.commandId||
     marker.principalBinding!==held.principalBinding||
     held.principalBinding!==preview.principalBinding||
     held.command.writeAreaId!==preview.writeAreaId||
     held.command.restoreGeneration.toLowerCase()!==preview.restoreGeneration.toLowerCase()){
    state?.entries.delete(id);
    if(state?.entries.size===0)clearSealed(runtime);
    return "blocked";
  }
  const bucket=current(runtime,generation);
  if(!bucket||bucket.entries.has(id))return "blocked";
  bucket.entries.set(id,{command:held.command,phase:"uncertain",
    principalBinding:held.principalBinding,wasUncertain:true,
    controller:null,pending:null,cancel:()=>{}});
  state?.entries.delete(id);
  if(state?.entries.size===0)clearSealed(runtime);
  changed(bucket,id);
  return "resumed";
}
const denied=():ProjectTitleEditSaveResult=>({outcome:"denied"});
const changed=(bucket:Bucket,id:string):void=>{
  if(bucket.disposed)return;
  for(const listener of bucket.listeners.get(id)??[])listener();
};
/** The runtime owns cleanup, including when NO detail is mounted. Its
 * registered disposables are synchronously disposed on signout, refusal,
 * generation rotation and runtime.dispose(). */
function purge(runtime:ProjectTitleEditRuntime,bucket:Bucket,reason:"expired"|"rotation"|"reset"="reset"):void{
  if(bucket.disposed)return;
  bucket.disposed=true;
  if(reason==="expired")for(const [id,entry] of bucket.entries)
    if(entry.phase==="saving"||entry.phase==="uncertain"||entry.wasUncertain)
      retainExpired(runtime,id,entry);
  for(const entry of bucket.entries.values())entry.cancel();
  bucket.entries.clear();
  bucket.drafts.clear();
  bucket.listeners.clear();
  if(buckets.get(runtime)===bucket)buckets.delete(runtime);
}
function current(runtime:ProjectTitleEditRuntime,generation:string):Bucket|null{
  const old=buckets.get(runtime);
  // Fail closed: stale callers must not be able to recreate a disposed bucket
  // under their old generation after the runtime changed or signed out.
  if(!runtime.known()||generation===""||runtime.generation()!==generation){
    // An old component may issue a stale-generation lookup after a new
    // authorized bucket exists. Reject it without destroying NEW commands.
    // Only a bucket that is itself revoked/stale may be purged here.
    if(old&&(!runtime.known()||old.generation!==runtime.generation()))
      purge(runtime,old);
    return null;
  }
  if(old&&!old.disposed&&old.generation===generation)return old;
  if(old)purge(runtime,old);
  const next:Bucket={
    generation,entries:new Map(),drafts:new Map(),listeners:new Map(),disposed:false,
  };
  buckets.set(runtime,next);
  // Register BEFORE retaining any project title. Registration immediately
  // disposes on an already-disposed runtime.
  const unregister=runtime.register({dispose:(reason)=>purge(runtime,next,reason)});
  if(next.disposed||!runtime.known()||runtime.generation()!==generation){
    purge(runtime,next);
    unregister();
    return null;
  }
  return next;
}
export function trackedProjectTitleEdit(runtime:ProjectTitleEditRuntime,generation:string,id:string):
  TrackedProjectTitleEdit|null{
  const entry=current(runtime,generation)?.entries.get(id);
  return entry?{command:entry.command,phase:entry.phase}:null;
}
/** Drafts stay memory-only and are never rendered again without a fresh
 * server-authorized project read and write preview. */
export function projectTitleDraft(runtime:ProjectTitleEditRuntime,generation:string,id:string):ProjectTitleDraft|null{
  return current(runtime,generation)?.drafts.get(id)??null;
}
export function setProjectTitleDraft(runtime:ProjectTitleEditRuntime,generation:string,id:string,draft:ProjectTitleDraft):void{
  current(runtime,generation)?.drafts.set(id,{...draft});
}
export function forgetProjectTitleDraft(runtime:ProjectTitleEditRuntime,generation:string,id:string):void{
  current(runtime,generation)?.drafts.delete(id);
}
export function subscribeTrackedProjectTitleEdit(runtime:ProjectTitleEditRuntime,generation:string,id:string,
  listener:()=>void):()=>void{
  const bucket=current(runtime,generation);
  if(!bucket)return ()=>{};
  let group=bucket.listeners.get(id);
  if(!group){group=new Set();bucket.listeners.set(id,group);}
  group.add(listener);
  return ()=>{
    group?.delete(listener);
    if(group?.size===0)bucket.listeners.delete(id);
  };
}
/** Explicitly forget only after authorized success or a refusal; never
 * because the inspector unmounted or a page became hidden. */
export function forgetTrackedProjectTitleEdit(runtime:ProjectTitleEditRuntime,generation:string,id:string):void{
  const bucket=current(runtime,generation);
  const entry=bucket?.entries.get(id);
  if(!bucket||!entry)return;
  entry.cancel();
  bucket.entries.delete(id);
  changed(bucket,id);
}
/** A stuck network transport must not pin the note in "saving" forever.
 * Abort the request at the deadline AND race an uncertain result because a
 * mocked/stalled fetch may ignore abort. The exact command remains recoverable.
 * Never present a timeout as confirmation of commit or as an authorization
 * error. A subsequent attempt uses the ORIGINAL commandId and CAS payload. */
export function runTrackedProjectTitleEdit(
  runtime:ProjectTitleEditRuntime,generation:string,id:string,command:ProjectTitleEditCommand,
  send:typeof saveProjectTitleEdit=saveProjectTitleEdit,
  timeoutMs=TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS,
  principalBinding?:string,
):Promise<ProjectTitleEditSaveResult>{
  const bucket=current(runtime,generation);
  if(!bucket)return Promise.resolve(denied());
  const existing=bucket.entries.get(id);
  if(existing&&JSON.stringify(existing.command)!==JSON.stringify(command))
    return Promise.resolve({outcome:"conflict"});
  if(existing?.pending)return existing.pending;
  if(existing?.phase==="saved")return Promise.resolve({outcome:"saved",replayed:true});
  if(existing?.phase==="denied")return Promise.resolve(denied());
  if(existing?.phase==="conflict")return Promise.resolve({outcome:"conflict"});
  const entry:Entry=existing??{
    command,phase:"uncertain",principalBinding:BINDING.test(principalBinding??"")?principalBinding!:null,
    wasUncertain:false,controller:null,pending:null,cancel:()=>{},
  };
  bucket.entries.set(id,entry);
  const controller=new AbortController();
  entry.controller=controller;
  entry.phase="saving";
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&
    timeoutMs<=TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS
    ?timeoutMs:TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS;
  let resolveDeadline:(result:ProjectTitleEditSaveResult)=>void=()=>{};
  const deadline=new Promise<ProjectTitleEditSaveResult>(resolve=>{resolveDeadline=resolve;});
  const timer=setTimeout(()=>{
    controller.abort();
    resolveDeadline({outcome:"uncertain"});
  },duration);
  entry.cancel=()=>{
    clearTimeout(timer);
    controller.abort();
    resolveDeadline(denied());
  };
  // Do not dispatch a queued microtask if the runtime was revoked meanwhile.
  const request=Promise.resolve().then(()=>{
    if(bucket.disposed||!runtime.known()||
      runtime.generation()!==generation||controller.signal.aborted)return denied();
    return send(id,entry.command,controller.signal);
  }).catch(():ProjectTitleEditSaveResult=>({outcome:"uncertain"}));
  const pending=Promise.race([request,deadline]).then(result=>{
    clearTimeout(timer);
    if(buckets.get(runtime)!==bucket||bucket.disposed||
      bucket.entries.get(id)!==entry)return result;
    if(result.outcome==="expired"){
      entry.wasUncertain=true;
      retainExpired(runtime,id,entry);
      // A coded expired session must discard every ordinary runtime-bound
      // read/draft before an independently verified new login can unseal.
      void runtime.reportRefusal?.("session_expired");
      return {outcome:"uncertain"} as ProjectTitleEditSaveResult;
    }
    const firstDispatch=!existing;
    if(result.outcome==="uncertain")entry.wasUncertain=true;
    if(result.outcome==="saved"&&entry.principalBinding)
      confirmProjectTitleReload(entry.command.commandId,entry.principalBinding);
    else if(result.outcome==="conflict"&&firstDispatch&&entry.principalBinding)
      rejectFirstProjectTitleReload(entry.command.commandId,entry.principalBinding);
    entry.phase=result.outcome==="saved"?"saved":
      result.outcome==="denied"?"denied":
      result.outcome==="conflict"&&!entry.wasUncertain?"conflict":"uncertain";
    entry.controller=null;
    entry.pending=null;
    entry.cancel=()=>{};
    // The inspector may already be closed: invalidate all live project lists
    // from the generation-scoped owner of the submitted command.
    if(result.outcome==="saved"&&typeof window!=="undefined")
      window.dispatchEvent(new Event(TARGET_PROJECT_TITLE_UPDATED));
    changed(bucket,id);
    return result;
  });
  entry.pending=pending;
  changed(bucket,id);
  return pending;
}
