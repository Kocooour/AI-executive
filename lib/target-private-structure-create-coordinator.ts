/** Tab-scoped content-free ambiguity barrier shared by both structure creates.
 * Only an opaque command ID/kind is persisted (not titles, Area or parent IDs).
 * A dropped response never authorizes a second create POST. Recovery is the
 * server's live-ACL-verified read, not an idempotent replay write. */
import type {TargetClientRuntime} from "./target-client-runtime";
import {sendStructureCreate,checkStructureCreateStatus,recoverStructureCreate,
  cancelStructureCreateCommand,
  validStructureCommand,type StructureKind,type StructureCreateCommand,
  type StructureReceipt,type StructureCommittedReceipt,type StructureCreateResult} from "./target-private-structure-create-client";
const KEY="lumi-private-structure-create-unresolved-v1";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generationPattern=/^[A-Za-z0-9_-]{43}$/;
type Runtime=Pick<TargetClientRuntime,"known"|"generation"|"register">;
type Marker={kind:StructureKind;commandId:string;generation:string;
  /** Reauth-stable HMAC witness. Undefined is accepted only for pre-upgrade markers
   * whose original runtime generation STILL matches the current session. */
  ownerScope?:string};
const scopePattern=/^[A-Za-z0-9_-]{43}$/;
const sameActor=(marker:Marker,generation:string,ownerScope:string)=>
  scopePattern.test(ownerScope)&&
  (marker.ownerScope===ownerScope||
    (marker.ownerScope===undefined&&marker.generation===generation));
type Active={marker:Marker;command:StructureCreateCommand;phase:"saving"|"uncertain";
  abort:()=>void;unregister:()=>void};
const active=new WeakMap<Runtime,Active>();
const store=():Storage|null=>{try{return globalThis.sessionStorage??null;}catch{return null;}};
function decode(text:string):Marker|null{
  try{
    const raw:unknown=JSON.parse(text);
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const r=raw as Record<string,unknown>;
    if(!["commandId,generation,kind","commandId,generation,kind,ownerScope"]
      .includes(Object.keys(r).sort().join(","))||
      !["project","project-task"].includes(String(r.kind))||
      typeof r.commandId!=="string"||!uuid.test(r.commandId)||
      typeof r.generation!=="string"||!generationPattern.test(r.generation)||
      (r.ownerScope!==undefined&&(typeof r.ownerScope!=="string"||
        !scopePattern.test(r.ownerScope))))return null;
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
  if(!generationPattern.test(marker.generation)||!scopePattern.test(marker.ownerScope||"")||
    !uuid.test(marker.commandId)||
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
  ownerScope:string,send:typeof sendStructureCreate=sendStructureCreate,timeoutMs=20_000,
):Promise<StructureCreateResult|"blocked">{
  if(!runtime.known()||runtime.generation()!==generation||active.has(runtime)||
    !validStructureCommand(kind,command))return "blocked";
  const marker={kind,commandId:command.commandId,generation,ownerScope};
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
  runtime:Runtime,generation:string,ownerScope:string,signal:AbortSignal,
  check:typeof checkStructureCreateStatus=checkStructureCreateStatus,
  recover:typeof recoverStructureCreate=recoverStructureCreate,
):Promise<StructureReceipt>{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)return "unavailable";
  const current=structureCreateMarker();
  if(current.status!=="blocked")return "unavailable";
  const marker=current.marker;
  if(!sameActor(marker,generation,ownerScope))return "unavailable";
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

/** Release only after a terminal actor-bound server fence. An existing receipt
 * is SETTLED, not cancelled: reconcile it through the live-ACL read BEFORE
 * releasing the marker, then return a navigable ID only when authorized. */
export type StructureCancelOutcome=
  |"cancelled"|"denied"|"unavailable"
  |{status:"settled";receipt:StructureCommittedReceipt|null};
export async function cancelStructureCreate(
  runtime:Runtime,generation:string,ownerScope:string,signal:AbortSignal,
  cancel:typeof cancelStructureCreateCommand=cancelStructureCreateCommand,
  recover:typeof recoverStructureCreate=recoverStructureCreate,
):Promise<StructureCancelOutcome>{
  if(!runtime.known()||runtime.generation()!==generation||signal.aborted)
    return "unavailable";
  const current=structureCreateMarker();
  if(current.status!=="blocked"||!sameActor(current.marker,generation,ownerScope))
    return "unavailable";
  const entry=active.get(runtime);
  if(entry?.phase==="saving")return "unavailable";
  const result=await cancel(current.marker.kind,current.marker.commandId,ownerScope,signal);
  if(result!=="cancelled"&&result!=="settled")return result;
  // Even after a full reload, the server's actor-scoped receipt witness
  // provides the original created ID without storing any title or Area locally.
  const found=result==="settled"
    ?await recover(current.marker.kind,current.marker.commandId,null,signal)
    :null;
  if(signal.aborted||!runtime.known()||runtime.generation()!==generation||
    !release(current.marker))return "unavailable";
  if(entry?.marker.commandId===current.marker.commandId){
    active.delete(runtime);entry.unregister();
  }
  if(result==="cancelled")return result;
  return {status:"settled",receipt:typeof found==="object"&&found.status==="committed"
    ?found:null};
}
