/** R3-FE-6: tab-scoped, content-free ambiguity barrier. The full CREATE
 * command is kept ONLY in the current runtime's memory for exact recovery;
 * title/Area/task ID are never persisted in browser storage. Because task
 * status currently requires the exact title digest, reload destroys recovery
 * capability but MUST NOT clear the blocking UUID. This remains a release gate.
 */
import {checkPrivateTaskCreateReceipt,sendPrivateTaskCreate,
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
    }else entry.phase="uncertain";
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
  }
  return receipt;
}
