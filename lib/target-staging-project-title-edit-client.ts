/** R3-FE-4b: strict, no-store project title edit transport. The server owns ACL and CAS.
 * A lost/invalid write response is UNCERTAIN: only the exact same command
 * may be retried, never a new UUID for the same unresolved attempt. */
import {readableProjectId} from "./target-staging-project-tasks-client";

export type ProjectTitleEditPreview={
  expectedRevision:string;writeAreaId:string;restoreGeneration:string;
};
export type ProjectTitleEditCommand=ProjectTitleEditPreview&{
  commandId:string;title:string;
};
export type ProjectTitleEditFailure="denied"|"conflict"|"unavailable"|"offline"|"invalid-response";
export type ProjectTitleEditPreviewResult={ok:true;preview:ProjectTitleEditPreview}|
  {ok:false;reason:ProjectTitleEditFailure};
export type ProjectTitleEditSaveResult=
  {outcome:"saved";replayed:boolean}|{outcome:"conflict"|"denied"|"uncertain"};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex=/^[0-9a-f]{64}$/;
const area=/^[A-Za-z0-9_.:@-]{1,120}$/;
const encoder=new TextEncoder();
const record=(v:unknown):v is Record<string,unknown> =>
  v!==null&&typeof v==="object"&&!Array.isArray(v);
const wellFormed=(s:string):boolean=>{
  try{return decodeURIComponent(encodeURIComponent(s))===s;}catch{return false;}
};
export function validProjectTitleEditText(title:string):boolean{
  return title.length>0&&title.trim()===title&&!title.includes("\0")&&
    wellFormed(title)&&encoder.encode(title).length<=4096;
}
export function parseProjectTitleEditPreview(value:unknown):ProjectTitleEditPreview|null{
  if(!record(value)||Object.keys(value).sort().join(",")!==
    "restoreGeneration,snapshotRevision,writeAreaId")return null;
  if(typeof value.snapshotRevision!=="string"||!hex.test(value.snapshotRevision)||
    typeof value.restoreGeneration!=="string"||!uuid.test(value.restoreGeneration)||
    !(typeof value.writeAreaId==="string"&&area.test(value.writeAreaId)))return null;
  return {expectedRevision:value.snapshotRevision,
    restoreGeneration:value.restoreGeneration,writeAreaId:value.writeAreaId};
}
export function validProjectTitleEditCommand(value:unknown):value is ProjectTitleEditCommand{
  if(!record(value)||Object.keys(value).sort().join(",")!==
    "commandId,expectedRevision,restoreGeneration,title,writeAreaId")return false;
  return typeof value.commandId==="string"&&uuid.test(value.commandId)&&
    typeof value.title==="string"&&validProjectTitleEditText(value.title)&&
    typeof value.expectedRevision==="string"&&hex.test(value.expectedRevision)&&
    typeof value.restoreGeneration==="string"&&uuid.test(value.restoreGeneration)&&
    typeof value.writeAreaId==="string"&&area.test(value.writeAreaId);
}
async function strictJson(response:Response,maxBytes=8192):Promise<unknown>{
  if(response.redirected||response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
      response.headers.get("cache-control")?.trim().toLowerCase()!=="no-store"||!response.body)
    throw Error("invalid response");
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>maxBytes))throw Error("oversized");
  const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let text="",bytes=0,done=false;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done){done=true;break;}
      bytes+=part.value.byteLength;
      if(bytes>maxBytes)throw Error("oversized");
      text+=decoder.decode(part.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    if(!done)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
const failure=(status:number):ProjectTitleEditFailure =>
  status===401||status===403||status===404?"denied":
  status===409?"conflict":"unavailable";

export async function loadProjectTitleEditPreview(projectId:string,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch):Promise<ProjectTitleEditPreviewResult>{
  if(!readableProjectId(projectId))return {ok:false,reason:"denied"};
  try{
    const response=await fetchImpl("/api/target-staging/projects/"+
      encodeURIComponent(projectId)+"/title",{
      method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{accept:"application/json"},signal,
    });
    if(signal.aborted)return {ok:false,reason:"offline"};
    if(response.status!==200)return {ok:false,reason:failure(response.status)};
    let parsed:unknown;
    try{parsed=await strictJson(response);}
    catch{return {ok:false,reason:"invalid-response"};}
    const preview=parseProjectTitleEditPreview(parsed);
    return preview?{ok:true,preview}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:signal.aborted?"offline":"unavailable"};}
}
export async function saveProjectTitleEdit(projectId:string,command:ProjectTitleEditCommand,
  signal:AbortSignal,fetchImpl:typeof fetch=fetch):Promise<ProjectTitleEditSaveResult>{
  if(!readableProjectId(projectId)||!validProjectTitleEditCommand(command))
    return {outcome:"conflict"};
  try{
    const response=await fetchImpl("/api/target-staging/projects/"+
      encodeURIComponent(projectId)+"/title",{
      method:"PATCH",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{"content-type":"application/json",accept:"application/json",
        "x-lumi-target-protocol":"1"},
      body:JSON.stringify(command),signal,
    });
    if(signal.aborted)return {outcome:"uncertain"};
    if(response.status===401||response.status===403||response.status===404)
      return {outcome:"denied"};
    if(response.status===409||response.status===400)return {outcome:"conflict"};
    if(response.status!==200)return {outcome:"uncertain"};
    const result=await strictJson(response);
    if(!record(result))return {outcome:"uncertain"};
    if(Object.keys(result).join(",")==="ok"&&result.ok===true)
      return {outcome:"saved",replayed:false};
    if(Object.keys(result).sort().join(",")==="ok,replayed"&&
      result.ok===true&&result.replayed===true)
      return {outcome:"saved",replayed:true};
    return {outcome:"uncertain"};
  }catch{return {outcome:"uncertain"};}
}
