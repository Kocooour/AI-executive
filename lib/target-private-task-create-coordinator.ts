/** Auth-runtime-scoped task CREATE. POST may finish after the modal unmounts.
 * The exact command remains only in RAM until the runtime is disposed.
 * A later status probe reuses the original payload; no retry/new UUID. */
import {sendPrivateTaskCreate,recoverPrivateTaskCreate,validPrivateTaskCreateCommand,
  type PrivateTaskCreateCommand,type TaskCreateOutcome,type TaskCreateReceipt}
  from "./target-private-task-create-client";
import {privateTaskCreateMarker,reservePrivateTaskCreate,confirmPrivateTaskCreate}
  from "./target-private-task-create-reload";
import type {TargetClientRuntime} from "./target-client-runtime";
export type TaskCreateRuntime=Pick<TargetClientRuntime,"known"|"generation"|"register">;
type Entry={generation:string;command:PrivateTaskCreateCommand;phase:"saving"|"uncertain";
  controller:AbortController;listeners:Set<()=>void>;unregister:()=>void};
const entries=new WeakMap<TaskCreateRuntime,Entry>();
// The modal may unmount before a real HTTP acknowledgement arrives. Keep only
// non-content command identity until the always-mounted target bridge has
// verified the current session and delivered a one-shot completion.
type Completion={generation:string;commandId:string};
const completions=new WeakMap<TaskCreateRuntime,Completion>();
const completionListeners=new WeakMap<TaskCreateRuntime,Set<()=>void>>();
export function hasPrivateTaskCreateCompletion(
  runtime:TaskCreateRuntime,generation:string,
):boolean{
  return runtime.known()&&runtime.generation()===generation&&
    completions.get(runtime)?.generation===generation;
}
export function consumePrivateTaskCreateCompletion(
  runtime:TaskCreateRuntime,generation:string,
):boolean{
  if(!hasPrivateTaskCreateCompletion(runtime,generation))return false;
  completions.delete(runtime);
  return true;
}
export function subscribePrivateTaskCreateCompletion(
  runtime:TaskCreateRuntime,listener:()=>void,
):()=>void{
  let listeners=completionListeners.get(runtime);
  if(!listeners){listeners=new Set();completionListeners.set(runtime,listeners);}
  listeners.add(listener);
  return ()=>{listeners?.delete(listener);};
}
function announceCompletion(runtime:TaskCreateRuntime,generation:string,commandId:string){
  if(!runtime.known()||runtime.generation()!==generation)return;
  completions.set(runtime,{generation,commandId});
  for(const listener of [...(completionListeners.get(runtime)??[])]){
    try{listener();}catch{/* no UI listener can break the committed receipt */}
  }
}
export const TASK_CREATE_DEADLINE_MS=20_000;
export function trackedPrivateTaskCreate(runtime:TaskCreateRuntime,generation:string):
  {phase:"saving"|"uncertain";commandId:string}|null{
  if(!runtime.known()||runtime.generation()!==generation)return null;
  const e=entries.get(runtime);
  return e&&e.generation===generation?
    {phase:e.phase,commandId:e.command.commandId}:null;
}
export function subscribePrivateTaskCreate(runtime:TaskCreateRuntime,
  generation:string,listener:()=>void):()=>void{
  const e=entries.get(runtime);
  if(!e||e.generation!==generation)return ()=>{};
  e.listeners.add(listener);
  return ()=>{e.listeners.delete(listener);};
}
function notify(e:Entry){for(const listener of e.listeners)listener();}
function finish(runtime:TaskCreateRuntime,e:Entry){
  if(entries.get(runtime)===e)entries.delete(runtime);
  e.listeners.clear();
  e.unregister();
}
export function runPrivateTaskCreate(runtime:TaskCreateRuntime,generation:string,
  command:PrivateTaskCreateCommand,send:typeof sendPrivateTaskCreate=sendPrivateTaskCreate,
  timeoutMs=TASK_CREATE_DEADLINE_MS):Promise<TaskCreateOutcome>{
  if(!runtime.known()||runtime.generation()!==generation)return Promise.resolve("denied");
  // Reject malformed commands BEFORE reserving a persistent ambiguity marker:
  // no HTTP request can have been dispatched for such an input.
  if(!validPrivateTaskCreateCommand(command))return Promise.resolve("conflict");
  // A successful HTTP acknowledgement may still be waiting for the
  // always-mounted bridge to reverify the visible session and notify the user.
  // The tab marker has already been cleared at that point, so it alone cannot
  // prevent a duplicate retry with a fresh commandId. Preserve the one-slot
  // completion until delivered before allowing another INSERT.
  if(entries.has(runtime)||hasPrivateTaskCreateCompletion(runtime,generation)||
    privateTaskCreateMarker(generation).kind!=="clear"||
    !reservePrivateTaskCreate(generation,command.commandId))
    return Promise.resolve("conflict");
  const controller=new AbortController();
  const e:Entry={generation,command,controller,phase:"saving",listeners:new Set(),
    unregister:()=>{}};
  entries.set(runtime,e);
  e.unregister=runtime.register({dispose:()=>{
    controller.abort();e.listeners.clear();
    if(entries.get(runtime)===e)entries.delete(runtime);
  }});
  const limit=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&
    timeoutMs<=TASK_CREATE_DEADLINE_MS?timeoutMs:TASK_CREATE_DEADLINE_MS;
  let timeoutResolve:(value:TaskCreateOutcome)=>void=()=>{};
  const deadline=new Promise<TaskCreateOutcome>(resolve=>{timeoutResolve=resolve;});
  const timer=setTimeout(()=>{controller.abort();timeoutResolve("uncertain");},limit);
  const dispatched=Promise.resolve().then(()=>{
    if(controller.signal.aborted||!runtime.known()||
      runtime.generation()!==generation)return "uncertain" as TaskCreateOutcome;
    return send(command,controller.signal);
  }).catch(():TaskCreateOutcome=>"uncertain");
  return Promise.race([dispatched,deadline]).then(outcome=>{
    clearTimeout(timer);
    if(entries.get(runtime)!==e)return outcome;
    if(outcome==="saved"&&runtime.known()&&runtime.generation()===generation&&
      confirmPrivateTaskCreate(generation,command.commandId)){
      finish(runtime,e);
      announceCompletion(runtime,generation,command.commandId);
      return "saved";
    }
    // Even conflict/denial might follow a commit; keep exact UUID blocked.
    e.phase="uncertain";notify(e);return "uncertain";
  });
}
export async function checkPrivateTaskCreate(runtime:TaskCreateRuntime,
  generation:string,signal:AbortSignal,
  recover:typeof recoverPrivateTaskCreate=recoverPrivateTaskCreate
):Promise<TaskCreateReceipt>{
  const e=entries.get(runtime),marker=privateTaskCreateMarker(generation);
  if(!e||e.generation!==generation||e.phase!=="uncertain"||
    !runtime.known()||runtime.generation()!==generation||
    marker.kind!=="blocked"||marker.commandId!==e.command.commandId)
    return "unavailable";
  const result=await recover(e.command,signal);
  if(result==="committed"&&!signal.aborted&&runtime.known()&&
    runtime.generation()===generation&&
    confirmPrivateTaskCreate(generation,e.command.commandId)){
    finish(runtime,e);
    announceCompletion(runtime,generation,e.command.commandId);
    return "committed";
  }
  // The server may have committed, but an unreadable/uncleared local marker
  // must never be reported as safely complete. Keep the write blocked.
  return result==="committed"?"unavailable":result;
}
