/** R3 A/3: exact-command transport for owner-private project/child task create.
 * A child never sends an Area; existing readable parents need not be UUIDs.
 * Failed or dropped POST responses are ambiguous and NEVER retried.
 * POST-shaped create-status/create-recovery are queued as target reads. */
import {targetAppFetch} from "./target-app-fetch";
import {readableProjectId} from "./target-staging-project-tasks-client";
import {validPrivateTaskAreaId,validPrivateTaskTitle} from "./target-private-task-create-client";

export type StructureKind="project"|"project-task";
export type ProjectCreateCommand={
  projectId:string;commandId:string;areaId:string;restoreGeneration:string;title:string;
};
export type ProjectTaskCreateCommand={
  taskId:string;commandId:string;projectId:string;restoreGeneration:string;title:string;
};
export type StructureCreateCommand=ProjectCreateCommand|ProjectTaskCreateCommand;
export type StructureCreateResult="saved"|"denied"|"uncertain";
export type StructureReceipt=
  |{status:"committed";id:string}
  |"not_recorded"|"denied"|"unavailable";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonical=(v:unknown):v is string=>typeof v==="string"&&uuid.test(v)&&v===v.toLowerCase();
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const keys=(v:Record<string,unknown>)=>Object.keys(v).sort().join(",");
export function validStructureCommand(kind:StructureKind,v:unknown):v is StructureCreateCommand{
  if(!record(v)||!canonical(v.commandId)||!canonical(v.restoreGeneration)||
    !validPrivateTaskTitle(v.title))return false;
  if(kind==="project")
    return keys(v)==="areaId,commandId,projectId,restoreGeneration,title"&&
      canonical(v.projectId)&&validPrivateTaskAreaId(v.areaId);
  return keys(v)==="commandId,projectId,restoreGeneration,taskId,title"&&
    canonical(v.taskId)&&readableProjectId(v.projectId);
}
const url=(kind:StructureKind)=>kind==="project"
  ?"/api/target-staging/projects":"/api/target-staging/project-tasks";
const headers={accept:"application/json","content-type":"application/json","x-lumi-target-protocol":"1"};
const opts=(body:unknown,signal:AbortSignal):RequestInit=>({
  method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
  headers,body:JSON.stringify(body),signal,
});
async function bounded(res:Response,signal:AbortSignal):Promise<unknown>{
  if(res.redirected||res.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
    !(res.headers.get("cache-control")||"").split(",").some(x=>x.trim().toLowerCase()==="no-store")||
    !res.body)throw Error("response");
  const len=res.headers.get("content-length");
  if(len!==null&&(!/^(0|[1-9][0-9]*)$/.test(len)||!Number.isSafeInteger(Number(len))||
    Number(len)>1024))throw Error("length");
  const reader=res.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let text="",size=0,done=false;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  try{
    for(;;){
      if(signal.aborted)throw Error("aborted");
      const part=await reader.read();
      if(signal.aborted)throw Error("aborted");
      if(part.done){done=true;break;}
      size+=part.value.byteLength;
      if(size>1024)throw Error("oversize");
      text+=decoder.decode(part.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    signal.removeEventListener("abort",cancel);
    if(!done)void reader.cancel().catch(()=>{});
    try{reader.releaseLock();}catch{}
  }
}
const expected=(kind:StructureKind,command:StructureCreateCommand)=>
  kind==="project"?(command as ProjectCreateCommand).projectId:(command as ProjectTaskCreateCommand).taskId;
export async function sendStructureCreate(
  kind:StructureKind,command:StructureCreateCommand,signal:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<StructureCreateResult>{
  if(!validStructureCommand(kind,command)||signal.aborted)return "denied";
  try{
    const response=await fetchImpl(url(kind),opts(command,signal));
    if(signal.aborted||![200,201].includes(response.status))return "uncertain";
    const data=await bounded(response,signal);
    if(!record(data)||keys(data)!==(response.status===201?"id,ok":"id,ok,replayed")||
      data.ok!==true||data.id!==expected(kind,command)||
      (response.status===200&&data.replayed!==true))return "uncertain";
    return "saved";
  }catch{return "uncertain";}
}
async function receipt(
  kind:StructureKind,path:string,body:unknown,signal:AbortSignal,
  fetchImpl:typeof fetch,
):Promise<StructureReceipt>{
  if(signal.aborted)return "unavailable";
  try{
    const response=await fetchImpl(path,opts(body,signal));
    if(signal.aborted)return "unavailable";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200)return "unavailable";
    const data=await bounded(response,signal);
    if(!record(data))return "unavailable";
    if(keys(data)==="status"&&data.status==="not_recorded")return "not_recorded";
    if(keys(data)==="id,status"&&data.status==="committed"&&typeof data.id==="string"&&
      canonical(data.id))
      return {status:"committed",id:data.id};
    return "unavailable";
  }catch{return "unavailable";}
}
export async function checkStructureCreateStatus(
  kind:StructureKind,command:StructureCreateCommand,signal:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<StructureReceipt>{
  if(!validStructureCommand(kind,command))return "unavailable";
  const found=await receipt(kind,url(kind)+"/create-status",command,signal,fetchImpl);
  // Unlike opaque reload recovery, exact-command status has the original ID.
  // A mismatched response cannot release the unresolved marker.
  return typeof found==="object"&&found.id!==expected(kind,command)
    ?"unavailable":found;
}
export function recoverStructureCreate(
  kind:StructureKind,commandId:string,projectId:string|null,signal:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<StructureReceipt>{
  if(!canonical(commandId))
    return Promise.resolve("unavailable");
  return receipt(kind,url(kind)+"/create-recovery",{commandId},signal,fetchImpl);
}

/** Cancellable only after a live, actor-bound, durable no-commit fence (or
 * durable receipt) has been persisted by the server. This is a WRITE. */
export type StructureCancel="cancelled"|"settled"|"denied"|"unavailable";
export async function cancelStructureCreateCommand(
  kind:StructureKind,commandId:string,ownerScope:string,signal:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<StructureCancel>{
  if(!canonical(commandId)||!(/^[A-Za-z0-9_-]{43}$/.test(ownerScope))||signal.aborted)
    return "unavailable";
  try{
    const response=await fetchImpl(url(kind)+"/create-cancel",opts({commandId,ownerScope},signal));
    if(signal.aborted)return "unavailable";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200)return "unavailable";
    const data=await bounded(response,signal);
    return record(data)&&keys(data)==="status"&&
      (data.status==="cancelled"||data.status==="settled")
      ?data.status:"unavailable";
  }catch{return "unavailable";}
}
