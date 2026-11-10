/** R3-FE-4b: recover ONE exact in-memory idempotent project title edit per project.
 * This coordinator outlives a disposable inspector but not the authenticated
 * target runtime/generation. No browser storage, offline queue, or new UUID
 * after ambiguous writes. A transport deadline can only make a write UNCERTAIN.
 */
import {
  saveProjectTitleEdit,type ProjectTitleEditCommand,type ProjectTitleEditSaveResult,type ProjectTitleEditPreview,
} from "./target-staging-project-title-edit-client";
import {TARGET_PROJECT_TITLE_UPDATED} from "./target-project-title-edit-ui-gate";
import type {TargetClientRuntime} from "./target-client-runtime";

export type ProjectTitleEditRuntime=Pick<TargetClientRuntime,"generation"|"known"|"register">;
export const TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS=20_000;
export type TrackedProjectTitleEditPhase="saving"|"uncertain"|"conflict"|"denied"|"saved";
export type TrackedProjectTitleEdit={
  readonly command:ProjectTitleEditCommand;
  readonly phase:TrackedProjectTitleEditPhase;
};
type Entry={
  command:ProjectTitleEditCommand;
  phase:TrackedProjectTitleEditPhase;
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
const denied=():ProjectTitleEditSaveResult=>({outcome:"denied"});
const changed=(bucket:Bucket,id:string):void=>{
  if(bucket.disposed)return;
  for(const listener of bucket.listeners.get(id)??[])listener();
};
/** The runtime owns cleanup, including when NO detail is mounted. Its
 * registered disposables are synchronously disposed on signout, refusal,
 * generation rotation and runtime.dispose(). */
function purge(runtime:ProjectTitleEditRuntime,bucket:Bucket):void{
  if(bucket.disposed)return;
  bucket.disposed=true;
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
  const unregister=runtime.register({dispose:()=>purge(runtime,next)});
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
    command,phase:"uncertain",controller:null,pending:null,cancel:()=>{},
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
    entry.phase=result.outcome==="saved"?"saved":
      result.outcome==="denied"?"denied":
      result.outcome==="conflict"?"conflict":"uncertain";
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
