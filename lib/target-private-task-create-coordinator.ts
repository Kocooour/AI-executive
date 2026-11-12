/** R3-FE-6: tab-scoped, content-free ambiguity barrier. The full CREATE
 * command is retained only in runtime memory; browser storage contains
 * {generation,commandId}, never title/Area/task ID. After reload the owner
 * can recover by a live-ACL-verified UUID-only server receipt. not_recorded
 * never clears the marker. An explicit terminal cancellation is a separate
 * pinned, durable no-commit fence, which even a late CREATE cannot bypass.
 */
import {checkPrivateTaskCreateReceipt,checkPrivateTaskCreateRecovery,
  cancelPrivateTaskCreateCommand,
  sendPrivateTaskCreate,
  validPrivateTaskCreateCommand,type PrivateTaskCreateCommand,type TaskCreateOutcome,type TaskCreateReceipt,
} from "./target-private-task-create-client";
import type {TargetClientRuntime} from "./target-client-runtime";

const KEY="lumi-private-task-create-unresolved-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION=/^[A-Za-z0-9_-]{43}$/;
type Runtime=Pick<TargetClientRuntime,"known"|"generation"|"register">;
type Entry={generation:string;command:PrivateTaskCreateCommand;
  phase:"saving"|"uncertain";abort:()=>void;unregister:()=>void};
const entries=new WeakMap<Runtime,Entry>();
// Subscribers belong to the authenticated runtime, not the transient modal.
// Only a positive, exact server confirmation carries an opaque task ID.
export type TaskCreateChange={generation:string;confirmedTaskId:string|null};
const observers=new WeakMap<Runtime,Set<(change:TaskCreateChange)=>void>>();
// A dynamically loaded observer may subscribe after a very fast server
// confirmation. Retain only the latest opaque ID in this runtime's memory;
// never persist an ID, title or Area or cross an auth-generation boundary.
const lastConfirmed=new WeakMap<Runtime,{generation:string;taskId:string}>();
export function lastConfirmedPrivateTask(
  runtime:Runtime,generation:string,
):string|null{
  if(!runtime.known()||runtime.generation()!==generation)return null;
  const last=lastConfirmed.get(runtime);
  return last?.generation===generation?last.taskId:null;
}
export function subscribePrivateTaskCreate(
  runtime:Runtime,generation:string,listener:(change:TaskCreateChange)=>void,
):()=>void{
  if(!runtime.known()||runtime.generation()!==generation)return ()=>{};
  let set=observers.get(runtime);
  if(!set){set=new Set();observers.set(runtime,set);}
  set.add(listener);
  return ()=>{set?.delete(listener);if(set?.size===0)observers.delete(runtime);};
}
function notify(runtime:Runtime,change:TaskCreateChange):void{
  if(!runtime.known()||runtime.generation()!==change.generation)return;
  if(change.confirmedTaskId)
    lastConfirmed.set(runtime,{generation:change.generation,taskId:change.confirmedTaskId});
  for(const listener of [...(observers.get(runtime)??[])])
    try{listener(change);}catch{/* A UI listener must not affect the write. */}
}
function store():Storage|null{
  try{return globalThis.sessionStorage??null;}catch{return null;}
}
function decode(raw:string):{generation:string;commandId:string}|null{
  try{
    const v:unknown=JSON.parse(raw);
    if(!v||typeof v!=="object"||Array.isArray(v))return null;
    const r=v as Record<string,unknown>;
    return Object.keys(r).sort().join(",")==="commandId,generation"&&
      typeof r.commandId==="string"&&UUID.test(r.commandId)&&
      typeof r.generation==="string"&&GENERATION.test(r.generation)
      ?{generation:r.generation,commandId:r.commandId}:null;
  }catch{return null;}
}
export type TaskCreateMarker={kind:"clear"}|
  {kind:"blocked";commandId:string}|{kind:"unavailable"};
export function privateTaskCreateMarker(generation:string):TaskCreateMarker{
  if(!GENERATION.test(generation))return {kind:"unavailable"};
  try{
    const storage=store();if(!storage)return {kind:"unavailable"};
    const raw=storage.getItem(KEY);
    if(raw===null)return {kind:"clear"};
    const marker=decode(raw);
    // Never discard a blocked previous generation: it could still commit.
    return marker?{kind:"blocked",commandId:marker.commandId}:{kind:"unavailable"};
  }catch{return {kind:"unavailable"};}
}
export function reservePrivateTaskCreate(generation:string,commandId:string):boolean{
  if(!GENERATION.test(generation)||!UUID.test(commandId)||
    privateTaskCreateMarker(generation).kind!=="clear")return false;
  try{
    const storage=store();if(!storage)return false;
    storage.setItem(KEY,JSON.stringify({generation,commandId}));
    const current=privateTaskCreateMarker(generation);
    return current.kind==="blocked"&&current.commandId===commandId;
  }catch{return false;}
}
function confirm(generation:string,commandId:string,recovered=false):boolean{
  try{
    const storage=store();const raw=storage?.getItem(KEY);
    const marker=raw===undefined||raw===null?null:decode(raw);
    if(!storage||!marker||marker.commandId!==commandId||
      (!recovered&&marker.generation!==generation))return false;
    storage.removeItem(KEY);
    return storage.getItem(KEY)===null;
  }catch{return false;}
}
export function trackedPrivateTaskCreate(runtime:Runtime,generation:string){
  if(!runtime.known()||runtime.generation()!==generation)return null;
  const e=entries.get(runtime);
  if(!e||e.generation!==generation)return null;
  return {phase:e.phase,commandId:e.command.commandId};
}
const DEADLINE_MS=20000;
export async function runPrivateTaskCreate(
  runtime:Runtime,generation:string,command:PrivateTaskCreateCommand,
  send:typeof sendPrivateTaskCreate=sendPrivateTaskCreate,
  timeoutMs=DEADLINE_MS,
):Promise<TaskCreateOutcome|"blocked">{
  if(!runtime.known()||runtime.generation()!==generation||
    entries.has(runtime)||!validPrivateTaskCreateCommand(command)||
    !reservePrivateTaskCreate(generation,command.commandId))
    return "blocked";
  const controller=new AbortController();
  let timeoutResolve:(v:TaskCreateOutcome)=>void=()=>{};
  const deadline=new Promise<TaskCreateOutcome>(resolve=>{timeoutResolve=resolve;});
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=DEADLINE_MS
    ?timeoutMs:DEADLINE_MS;
  const timer=setTimeout(()=>{controller.abort();timeoutResolve("uncertain");},duration);
  let unregister=()=>{};
  const entry:Entry={generation,command,phase:"saving",
    abort:()=>{clearTimeout(timer);controller.abort();timeoutResolve("uncertain");},
    unregister:()=>unregister()};
  entries.set(runtime,entry);
  unregister=runtime.register({dispose:()=>{
    entry.abort();
    if(entries.get(runtime)===entry)entries.delete(runtime);
  }});
  const request=Promise.resolve().then(()=>
    runtime.known()&&runtime.generation()===generation&&!controller.signal.aborted
      ?send(command,controller.signal):"uncertain" as TaskCreateOutcome
  ).catch(():TaskCreateOutcome=>"uncertain");
  const outcome=await Promise.race([request,deadline]);
  clearTimeout(timer);
  if(entries.get(runtime)===entry){
    if(outcome==="saved"&&runtime.known()&&runtime.generation()===generation&&
      confirm(generation,command.commandId)){
      entries.delete(runtime);unregister();
      notify(runtime,{generation,confirmedTaskId:command.taskId});
    }else{
      entry.phase="uncertain";
      notify(runtime,{generation,confirmedTaskId:null});
    }
  }
  return outcome;
}
export async function checkTrackedPrivateTaskCreate(
  runtime:Runtime,generation:string,signal:AbortSignal,
  check:typeof checkPrivateTaskCreateReceipt=checkPrivateTaskCreateReceipt,
):Promise<TaskCreateReceipt|"missing-command">{
  if(!runtime.known()||runtime.generation()!==generation)return "unavailable";
  const entry=entries.get(runtime),marker=privateTaskCreateMarker(generation);
  if(!entry||entry.generation!==generation||entry.phase==="saving"||
    marker.kind!=="blocked"||marker.commandId!==entry.command.commandId)
    return "missing-command";
  const receipt=await check(entry.command,signal);
  if(receipt==="committed"&&!signal.aborted&&runtime.known()&&
    runtime.generation()===generation&&confirm(generation,entry.command.commandId,true)){
    entries.delete(runtime);entry.unregister();
    notify(runtime,{generation,confirmedTaskId:entry.command.taskId});
  }
  return receipt;
}

/** After a full reload the original title and task ID have been deliberately
 * discarded. The actor-bound server verifies the original opaque command. */
export async function recoverPrivateTaskCreate(
  runtime:Runtime,generation:string,signal:AbortSignal,
  check:typeof checkPrivateTaskCreateRecovery=checkPrivateTaskCreateRecovery,
):Promise<TaskCreateReceipt>{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)
    return "unavailable";
  const marker=privateTaskCreateMarker(generation);
  if(marker.kind!=="blocked")return "unavailable";
  const receipt=await check(marker.commandId,signal);
  if(typeof receipt==="object"&&receipt.status==="committed"&&
    !signal.aborted&&runtime.known()&&runtime.generation()===generation&&
    confirm(generation,marker.commandId,true)){
    notify(runtime,{generation,confirmedTaskId:receipt.taskId});
    return "committed";
  }
  // A response whose marker could not be positively cleared is NOT success.
  return typeof receipt==="object"?"unavailable":receipt;
}

/** Release an unresolved UUID only after a durable, actor-bound TERMINAL
 * proof: either the pinned cancellation fence or the immutable receipt.
 * A receipt proves no future insert, NOT that the task is readable now.
 * Never disclose or notify a navigable task ID from terminal settlement.
 * A changed auth generation cannot clear the previous owner's marker. */
export async function cancelTrackedPrivateTaskCreate(
  runtime:Runtime,generation:string,signal:AbortSignal,
  cancel:typeof cancelPrivateTaskCreateCommand=cancelPrivateTaskCreateCommand,
):Promise<"cancelled"|"settled"|"denied"|"unavailable">{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)
    return "unavailable";
  const marker=privateTaskCreateMarker(generation),tracked=entries.get(runtime);
  if(marker.kind!=="blocked"||tracked?.phase==="saving")
    return "unavailable";
  const raw=store()?.getItem(KEY),persisted=raw?decode(raw):null;
  if(!persisted||persisted.generation!==generation||
    persisted.commandId!==marker.commandId)return "unavailable";
  const result=await cancel(marker.commandId,signal);
  if((result==="cancelled"||result==="settled")&&!signal.aborted&&runtime.known()&&
    runtime.generation()===generation&&confirm(generation,marker.commandId)){
    if(tracked?.command.commandId===marker.commandId){
      entries.delete(runtime);tracked.unregister();
    }
    notify(runtime,{generation,confirmedTaskId:null});
    return result;
  }
  // A server proof is not successful release when client storage cannot be
  // positively cleared (or the signal/session became invalid).
  return result==="cancelled"||result==="settled"?"unavailable":result;
}
