/** Private CREATE pending state lives in the authenticated runtime, not in
 * a modal. Only an opaque command UUID survives full reload; draft never does.
 * No new command is permitted while the previous dispatch is ambiguous. */
import {sendPrivateNoteCreate,type PrivateNoteCreateCommand,
  type CreateOutcome} from "./target-private-note-create-client";
import {privateNoteCreateMarker,reservePrivateNoteCreate,
  confirmPrivateNoteCreate} from "./target-note-create-reload";
import type {TargetClientRuntime} from "./target-client-runtime";
export type CreateRuntime=Pick<TargetClientRuntime,"generation"|"known"|"register">;
export type TrackedCreatePhase="saving"|"uncertain"|"saved";
type Entry={
  generation:string;commandId:string;phase:TrackedCreatePhase;
  controller:AbortController;cancel:()=>void;
  listeners:Set<()=>void>;pending:Promise<CreateOutcome>;
};
const state=new WeakMap<CreateRuntime,Entry>();
export const CREATE_DEADLINE_MS=20_000;
export function trackedPrivateNoteCreate(
  runtime:CreateRuntime,generation:string,
):{phase:TrackedCreatePhase;commandId:string}|null{
  if(!runtime.known()||runtime.generation()!==generation)return null;
  const e=state.get(runtime);
  return e?.generation===generation?{phase:e.phase,commandId:e.commandId}:null;
}
export function subscribePrivateNoteCreate(
  runtime:CreateRuntime,generation:string,listener:()=>void,
):()=>void{
  const e=state.get(runtime);
  if(!e||e.generation!==generation)return ()=>{};
  e.listeners.add(listener);
  return ()=>{e.listeners.delete(listener);};
}
export function runPrivateNoteCreate(
  runtime:CreateRuntime,generation:string,command:PrivateNoteCreateCommand,
  send:typeof sendPrivateNoteCreate=sendPrivateNoteCreate,
  timeoutMs=CREATE_DEADLINE_MS,
):Promise<CreateOutcome>{
  if(!runtime.known()||runtime.generation()!==generation)
    return Promise.resolve("denied");
  // The marker MUST be reserved before any network operation can dispatch.
  // An existing unresolved command is never replaced by a new UUID.
  if(state.has(runtime)||privateNoteCreateMarker(generation).kind!=="clear"||
    !reservePrivateNoteCreate(generation,command.commandId))
    return Promise.resolve("conflict");
  const controller=new AbortController();
  let stop:(v:CreateOutcome)=>void=()=>{};
  const deadline=new Promise<CreateOutcome>(resolve=>{stop=resolve;});
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&
    timeoutMs<=CREATE_DEADLINE_MS?timeoutMs:CREATE_DEADLINE_MS;
  const timer=setTimeout(()=>{controller.abort();stop("uncertain");},duration);
  const e:Entry={
    generation,commandId:command.commandId,phase:"saving",controller,
    cancel:()=>{clearTimeout(timer);controller.abort();stop("denied");},
    listeners:new Set(),pending:Promise.resolve("uncertain"),
  };
  state.set(runtime,e);
  const unregister=runtime.register({dispose:()=>{
    e.cancel();e.listeners.clear();
    if(state.get(runtime)===e)state.delete(runtime);
  }});
  if(!runtime.known()||runtime.generation()!==generation||
    state.get(runtime)!==e){e.cancel();unregister();return Promise.resolve("denied");}
  const request=Promise.resolve().then(()=>{
    if(!runtime.known()||runtime.generation()!==generation||controller.signal.aborted)
      return "denied" as CreateOutcome;
    return send(command,controller.signal);
  }).catch(():CreateOutcome=>"uncertain");
  const pending=Promise.race([request,deadline]).then(result=>{
    clearTimeout(timer);
    if(state.get(runtime)!==e)return result;
    // Only actual positive HTTP confirmation unlocks a dispatched write;
    // denial/conflict may race a successful underlying commit.
    if(result==="saved"&&runtime.known()&&runtime.generation()===generation)
      confirmPrivateNoteCreate(generation,command.commandId);
    e.phase=result==="saved"?"saved":"uncertain";
    for(const listener of e.listeners)listener();
    // The command body is not retained in coordinator state; its closure
    // becomes collectable once this pending promise settles.
    return result;
  });
  e.pending=pending;
  return pending;
}
export function releaseTrackedPrivateNoteCreate(
  runtime:CreateRuntime,generation:string,commandId:string,
):void{
  const e=state.get(runtime);
  if(!e||e.generation!==generation||e.commandId!==commandId)return;
  if(e.phase==="saving")return; // never cancel a sent POST just to unlock it
  e.listeners.clear();state.delete(runtime);
}
