/** Tab-scoped content-free ambiguity barrier shared by both structure creates.
 * Only an opaque command ID/kind is persisted (not titles, Area or parent IDs).
 * A dropped response never authorizes a second create POST. Recovery is the
 * server's live-ACL-verified read, not an idempotent replay write. */
import type {TargetClientRuntime} from "./target-client-runtime";
import {sendStructureCreate,checkStructureCreateStatus,recoverStructureCreate,
  cancelStructureCreateCommand,
  validStructureCommand,type StructureKind,type StructureCreateCommand,
  type StructureReceipt,type StructureCreateResult} from "./target-private-structure-create-client";
const KEY="lumi-private-structure-create-unresolved-v1";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generationPattern=/^[A-Za-z0-9_-]{43}$/;
type Runtime=Pick<TargetClientRuntime,"known"|"generation"|"register">;
type Marker={kind:StructureKind;commandId:string;generation:string};
type Active={marker:Marker;command:StructureCreateCommand;phase:"saving"|"uncertain";
  abort:()=>void;unregister:()=>void};
const active=new WeakMap<Runtime,Active>();
const store=():Storage|null=>{try{return globalThis.sessionStorage??null;}catch{return null;}};
function decode(text:string):Marker|null{
  try{
    const raw:unknown=JSON.parse(text);
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const r=raw as Record<string,unknown>;
    if(Object.keys(r).sort().join(",")!=="commandId,generation,kind"||
      !["project","project-task"].includes(String(r.kind))||
      typeof r.commandId!=="string"||!uuid.test(r.commandId)||
      typeof r.generation!=="string"||!generationPattern.test(r.generation))return null;
    return r as Marker;
  }catch{return null;}
}
export type StructureMarker={status:"clear"|"unavailable"}|
  {status:"blocked";marker:Marker};
export function structureCreateMarker():StructureMarker{
  try{
    const s=store();if(!s)return {status:"unavailable"};
    const value=s.getItem(KEY);
    if(value===null)return {status:"clear"};
    const marker=decode(value);
    return marker?{status:"blocked",marker}:{status:"unavailable"};
  }catch{return {status:"unavailable"};}
}
function reserve(marker:Marker):boolean{
  if(!generationPattern.test(marker.generation)||!uuid.test(marker.commandId)||
    structureCreateMarker().status!=="clear")return false;
  try{
    const s=store();if(!s)return false;
    s.setItem(KEY,JSON.stringify(marker));
    const current=structureCreateMarker();
    return current.status==="blocked"&&current.marker.commandId===marker.commandId;
  }catch{return false;}
}
function release(marker:Marker):boolean{
  try{
    const s=store();const raw=s?.getItem(KEY);
    const current=raw?decode(raw):null;
    if(!s||!current||current.commandId!==marker.commandId||
      current.kind!==marker.kind)return false;
    s.removeItem(KEY);
    return s.getItem(KEY)===null;
  }catch{return false;}
}
export function trackedStructureCreate(runtime:Runtime):"saving"|"uncertain"|null{
  return active.get(runtime)?.phase??null;
}
export async function runStructureCreate(
  runtime:Runtime,generation:string,kind:StructureKind,command:StructureCreateCommand,
  send:typeof sendStructureCreate=sendStructureCreate,timeoutMs=20_000,
):Promise<StructureCreateResult|"blocked">{
  if(!runtime.known()||runtime.generation()!==generation||active.has(runtime)||
    !validStructureCommand(kind,command))return "blocked";
  const marker={kind,commandId:command.commandId,generation};
  if(!reserve(marker))return "blocked";
  const controller=new AbortController();
  let timeoutResolve:(outcome:StructureCreateResult)=>void=()=>{};
  const deadline=new Promise<StructureCreateResult>(resolve=>{timeoutResolve=resolve;});
  const timer=setTimeout(()=>{controller.abort();timeoutResolve("uncertain");},
    Math.min(20_000,Math.max(1,timeoutMs)));
  let unregister=()=>{};
  const entry:Active={marker,command,phase:"saving",
    abort:()=>{clearTimeout(timer);controller.abort();timeoutResolve("uncertain");},
    unregister:()=>unregister()};
  active.set(runtime,entry);
  unregister=runtime.register({dispose:()=>{
    entry.abort();if(active.get(runtime)===entry)active.delete(runtime);
  }});
  const request=Promise.resolve().then(()=>
    runtime.known()&&runtime.generation()===generation&&!controller.signal.aborted
      ?send(kind,command,controller.signal):"uncertain" as StructureCreateResult
  ).catch(():StructureCreateResult=>"uncertain");
  const result=await Promise.race([request,deadline]);
  clearTimeout(timer);
  if(active.get(runtime)===entry){
    if(result==="saved"&&runtime.known()&&runtime.generation()===generation&&release(marker)){
      active.delete(runtime);unregister();
    }else entry.phase="uncertain";
  }
  return result;
}
export async function verifyStructureCreate(
  runtime:Runtime,generation:string,signal:AbortSignal,
  check:typeof checkStructureCreateStatus=checkStructureCreateStatus,
  recover:typeof recoverStructureCreate=recoverStructureCreate,
):Promise<StructureReceipt>{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)return "unavailable";
  const current=structureCreateMarker();
  if(current.status!=="blocked")return "unavailable";
  const marker=current.marker;
  const entry=active.get(runtime);
  if(entry?.phase==="saving")return "unavailable";
  const result=entry?.marker.commandId===marker.commandId
    ?await check(marker.kind,entry.command,signal)
    :await recover(marker.kind,marker.commandId,null,signal);
  if(typeof result==="object"&&result.status==="committed"&&!signal.aborted&&
    runtime.known()&&runtime.generation()===generation&&release(marker)){
    if(entry?.marker.commandId===marker.commandId){active.delete(runtime);entry.unregister();}
    return result;
  }
  return result;
}

/** Release only after the server has atomically fenced the command against
 * a future insert, or proven its receipt settled under the same lock. */
export async function cancelStructureCreate(
  runtime:Runtime,generation:string,signal:AbortSignal,
  cancel:typeof cancelStructureCreateCommand=cancelStructureCreateCommand,
):Promise<"cancelled"|"settled"|"denied"|"unavailable">{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)
    return "unavailable";
  const current=structureCreateMarker();
  if(current.status!=="blocked"||current.marker.generation!==generation)
    return "unavailable";
  const entry=active.get(runtime);
  if(entry?.phase==="saving")return "unavailable";
  const result=await cancel(current.marker.kind,current.marker.commandId,signal);
  if((result==="cancelled"||result==="settled")&&!signal.aborted&&
    runtime.known()&&runtime.generation()===generation&&release(current.marker)){
    if(entry?.marker.commandId===current.marker.commandId){
      active.delete(runtime);entry.unregister();
    }
    return result;
  }
  return result==="cancelled"||result==="settled"?"unavailable":result;
}
