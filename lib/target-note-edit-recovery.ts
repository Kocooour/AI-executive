/** R3-FE-4b: in-memory, runtime/generation-scoped recovery of ONE exact
 * idempotent note edit per note. Not storage, not an offline queue.
 *
 * The network operation must NOT be owned by a disposable detail component:
 * closing, hiding, or navigating away must not discard an already-sent
 * commandId after a server commit with a lost response.
 *
 * Restoring the command to UI is a separate, server-authorized operation.
 */
import {
  saveNoteEdit,type NoteEditCommand,type NoteEditSaveResult,
} from "./target-staging-note-edit-client";

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
};
type Bucket={
  generation:string;
  entries:Map<string,Entry>;
  listeners:Map<string,Set<()=>void>>;
};
const buckets=new WeakMap<object,Bucket>();
const changed=(bucket:Bucket,id:string):void=>{
  for(const listener of bucket.listeners.get(id)??[])listener();
};
function current(runtime:object,generation:string):Bucket{
  const found=buckets.get(runtime);
  if(found?.generation===generation)return found;
  if(found) {
    // Identity/restore rotation ends this recovery context. The server still
    // independently authorizes any already received request.
    for(const entry of found.entries.values())entry.controller?.abort();
    found.entries.clear();
    found.listeners.clear();
  }
  const next:Bucket={generation,entries:new Map(),listeners:new Map()};
  buckets.set(runtime,next);
  return next;
}
export function trackedNoteEdit(runtime:object,generation:string,id:string):
  TrackedNoteEdit|null{
  const entry=current(runtime,generation).entries.get(id);
  return entry?{command:entry.command,phase:entry.phase}:null;
}
export function subscribeTrackedNoteEdit(runtime:object,generation:string,id:string,
  listener:()=>void):()=>void{
  const bucket=current(runtime,generation);
  let group=bucket.listeners.get(id);
  if(!group){group=new Set();bucket.listeners.set(id,group);}
  group.add(listener);
  return ()=>{
    group?.delete(listener);
    if(group?.size===0)bucket.listeners.delete(id);
  };
}
/** Explicitly forget after successful authorized refetch or loss of access.
 * Never call merely because the inspector unmounted or the page became hidden. */
export function forgetTrackedNoteEdit(runtime:object,generation:string,id:string):void{
  const bucket=current(runtime,generation);
  const entry=bucket.entries.get(id);
  if(!entry)return;
  entry.controller?.abort();
  bucket.entries.delete(id);
  changed(bucket,id);
}
/** Retry never changes the command. While a request is still pending, callers
 * receive the exact same promise and no duplicate network write is issued. */
export function runTrackedNoteEdit(
  runtime:object,generation:string,id:string,command:NoteEditCommand,
  send:typeof saveNoteEdit=saveNoteEdit,
):Promise<NoteEditSaveResult>{
  const bucket=current(runtime,generation);
  const existing=bucket.entries.get(id);
  if(existing&&JSON.stringify(existing.command)!==JSON.stringify(command))
    throw new Error("Unresolved edit: a different command cannot replace it");
  if(existing?.pending)return existing.pending;
  if(existing?.phase==="saved")return Promise.resolve({outcome:"saved",replayed:true});
  if(existing?.phase==="denied")return Promise.resolve({outcome:"denied"});
  if(existing?.phase==="conflict")return Promise.resolve({outcome:"conflict"});
  const entry:Entry=existing??{
    command,phase:"uncertain" as const,controller:null,pending:null,
  };
  bucket.entries.set(id,entry);
  const controller=new AbortController();
  entry.controller=controller;
  entry.phase="saving";
  const pending=Promise.resolve().then(()=>send(id,entry.command,controller.signal))
    .catch(():NoteEditSaveResult=>({outcome:"uncertain"}))
    .then(result=>{
      // Do not resurrect entries after a rotation or explicit revocation.
      if(buckets.get(runtime)!==bucket||bucket.entries.get(id)!==entry)return result;
      entry.phase=result.outcome==="saved"?"saved":
        result.outcome==="denied"?"denied":
        result.outcome==="conflict"?"conflict":"uncertain";
      entry.controller=null;
      entry.pending=null;
      changed(bucket,id);
      return result;
    });
  entry.pending=pending;
  changed(bucket,id);
  return pending;
}
