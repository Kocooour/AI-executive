/** R3-FE-4b: recover ONE exact in-memory idempotent note edit per note.
 * This coordinator outlives a disposable inspector but not the authenticated
 * target runtime/generation. Only the opaque UUID plus verified generation
 * persist in tab storage; never private text, CAS, or an offline queue.
 * A transport deadline can only make a write UNCERTAIN.
 */
import {
  saveNoteEdit,type NoteEditCommand,type NoteEditSaveResult,
} from "./target-staging-note-edit-client";
import type {TargetClientRuntime} from "./target-client-runtime";
import {confirmNoteEditReload,rejectFreshNoteEditReload} from "./target-note-edit-reload";

export type NoteEditRuntime=Pick<TargetClientRuntime,"generation"|"known"|"register">;
export const TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS=20_000;
export type TrackedNoteEditPhase="saving"|"uncertain"|"conflict"|"denied"|"saved";
export type TrackedNoteEdit={
  readonly command:NoteEditCommand;
  readonly phase:TrackedNoteEditPhase;
};
type Entry={
  command:NoteEditCommand;
  phase:TrackedNoteEditPhase;
  controller:AbortController|null;
  pending:Promise<NoteEditSaveResult>|null;
  cancel:()=>void;
};
type Bucket={
  generation:string;
  entries:Map<string,Entry>;
  listeners:Map<string,Set<()=>void>>;
  disposed:boolean;
};
const buckets=new WeakMap<NoteEditRuntime,Bucket>();
const denied=():NoteEditSaveResult=>({outcome:"denied"});
const changed=(bucket:Bucket,id:string):void=>{
  if(bucket.disposed)return;
  for(const listener of bucket.listeners.get(id)??[])listener();
};
/** The runtime owns cleanup, including when NO detail is mounted. Its
 * registered disposables are synchronously disposed on signout, refusal,
 * generation rotation and runtime.dispose(). */
function purge(runtime:NoteEditRuntime,bucket:Bucket):void{
  if(bucket.disposed)return;
  bucket.disposed=true;
  for(const entry of bucket.entries.values())entry.cancel();
  bucket.entries.clear();
  bucket.listeners.clear();
  if(buckets.get(runtime)===bucket)buckets.delete(runtime);
}
function current(runtime:NoteEditRuntime,generation:string):Bucket|null{
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
    generation,entries:new Map(),listeners:new Map(),disposed:false,
  };
  buckets.set(runtime,next);
  // Register BEFORE retaining any note content. Registration immediately
  // disposes on an already-disposed runtime.
  const unregister=runtime.register({dispose:()=>purge(runtime,next)});
  if(next.disposed||!runtime.known()||runtime.generation()!==generation){
    purge(runtime,next);
    unregister();
    return null;
  }
  return next;
}
export function trackedNoteEdit(runtime:NoteEditRuntime,generation:string,id:string):
  TrackedNoteEdit|null{
  const entry=current(runtime,generation)?.entries.get(id);
  return entry?{command:entry.command,phase:entry.phase}:null;
}
export function subscribeTrackedNoteEdit(runtime:NoteEditRuntime,generation:string,id:string,
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
export function forgetTrackedNoteEdit(runtime:NoteEditRuntime,generation:string,id:string):void{
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
export function runTrackedNoteEdit(
  runtime:NoteEditRuntime,generation:string,id:string,command:NoteEditCommand,
  send:typeof saveNoteEdit=saveNoteEdit,
  timeoutMs=TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS,
):Promise<NoteEditSaveResult>{
  const bucket=current(runtime,generation);
  if(!bucket)return Promise.resolve(denied());
  const existing=bucket.entries.get(id);
  // Only a brand-new command may have a definitive first-PATCH rejection.
  // A later conflict following ANY ambiguous attempt cannot prove that an
  // earlier PATCH will not commit; the tab reload barrier must survive.
  const firstDispatch=existing===undefined;
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
    timeoutMs<=TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS
    ?timeoutMs:TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS;
  let resolveDeadline:(result:NoteEditSaveResult)=>void=()=>{};
  const deadline=new Promise<NoteEditSaveResult>(resolve=>{resolveDeadline=resolve;});
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
  }).catch(():NoteEditSaveResult=>({outcome:"uncertain"}));
  const pending=Promise.race([request,deadline]).then(result=>{
    clearTimeout(timer);
    if(buckets.get(runtime)!==bucket||bucket.disposed||
      bucket.entries.get(id)!==entry)return result;
    // This happens while the runtime owns the request, even with NO editor
    // mounted. Release only the exact UUID in the matching auth generation.
    // A timed-out request has already settled as UNCERTAIN; a later 409 cannot
    // enter this branch for the original attempt.
    if(runtime.known()&&runtime.generation()===generation){
      if(result.outcome==="saved")
        confirmNoteEditReload(generation,entry.command.commandId);
      else if(result.outcome==="conflict"&&firstDispatch)
        rejectFreshNoteEditReload(generation,entry.command.commandId);
    }
    entry.phase=result.outcome==="saved"?"saved":
      result.outcome==="denied"?"denied":
      result.outcome==="conflict"?"conflict":"uncertain";
    entry.controller=null;
    entry.pending=null;
    entry.cancel=()=>{};
    changed(bucket,id);
    return result;
  });
  entry.pending=pending;
  changed(bucket,id);
  return pending;
}
