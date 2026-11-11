/** R3-FE-4b: strict, no-store project title edit transport. The server owns ACL and CAS.
 * A lost/invalid write response is UNCERTAIN: only the exact same command
 * may be retried, never a new UUID for the same unresolved attempt. */
import {readableProjectId} from "./target-staging-project-tasks-client";

export type ProjectTitleEditPreview={
  expectedRevision:string;writeAreaId:string;restoreGeneration:string;principalBinding:string;currentTitle:string;
};
export type ProjectTitleEditCommand=Omit<ProjectTitleEditPreview,"principalBinding"|"currentTitle">&{
  commandId:string;title:string;
};
export type ProjectTitleEditFailure="denied"|"expired"|"conflict"|"unavailable"|"offline"|"invalid-response";
export type ProjectTitleEditPreviewResult={ok:true;preview:ProjectTitleEditPreview}|
  {ok:false;reason:ProjectTitleEditFailure};
export type ProjectTitleEditSaveResult=
  {outcome:"saved";replayed:boolean}|
  {outcome:"denied";definitiveNoWrite?:true}|
  {outcome:"conflict"|"uncertain"|"expired"};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex=/^[0-9a-f]{64}$/;
const binding=/^[A-Za-z0-9_-]{43}$/;
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
    "currentTitle,principalBinding,restoreGeneration,snapshotRevision,writeAreaId")return null;
  if(typeof value.snapshotRevision!=="string"||!hex.test(value.snapshotRevision)||
    typeof value.restoreGeneration!=="string"||!uuid.test(value.restoreGeneration)||
    !(typeof value.writeAreaId==="string"&&area.test(value.writeAreaId))||
    typeof value.principalBinding!=="string"||!binding.test(value.principalBinding)||
     typeof value.currentTitle!=="string"||!value.currentTitle.trim()||
     !wellFormed(value.currentTitle)||encoder.encode(value.currentTitle).length>4096)return null;
  return {expectedRevision:value.snapshotRevision,
    restoreGeneration:value.restoreGeneration,writeAreaId:value.writeAreaId,
    principalBinding:value.principalBinding,currentTitle:value.currentTitle};
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
async function codedExpiry(response:Response):Promise<boolean>{
 try{const v=await strictJson(response,512);
 return record(v)&&Object.keys(v).sort().join(",")==="code,error"&&
 v.code==="session_expired"&&v.error==="Authentication required";
 }catch{return false;}
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
    if(response.status===401&&await codedExpiry(response))return {ok:false,reason:"expired"};
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
    if(response.status===401){
      // Only the specifically coded durable-session expiry may be re-bound
      // after a separate server-verified SAME-actor preflight.
      if(await codedExpiry(response))return {outcome:"expired"};
      return {outcome:"denied"};
    }
    if(response.status===403||response.status===404){
      // A route-issued, exact no-store refusal for these two statuses happens
      // before mutation in the project PATCH route. Unlike a coded/generic
      // 401, this can release a FIRST-dispatch tab lock without asserting a
      // commit. An invalid, redirected or unrecognised response stays denied
      // but never carries the no-write proof.
      let definitiveNoWrite=false;
      try{
        const body=await strictJson(response,512);
        definitiveNoWrite=record(body)&&Object.keys(body).join(",")==="error"&&
          ((response.status===404&&body.error==="Not found")||
           (response.status===403&&body.error==="Cross-origin request rejected"));
      }catch{/* missing or untrusted reply cannot clear an uncertain command */}
      return definitiveNoWrite?{outcome:"denied",definitiveNoWrite:true}:{outcome:"denied"};
    }
    if(response.status===409){
      // Only this exact pre-COMMIT CAS refusal is a definitive conflict.
      // Malformed/proxy 409s must not unlock an ambiguous attempt.
      try{
        const body=await strictJson(response,512);
        if(record(body)&&Object.keys(body).join(",")==="error"&&
          body.error==="Revision conflict")return {outcome:"conflict"};
      }catch{/* keep the command uncertain */}
      return {outcome:"uncertain"};
    }
    if(response.status===400){
      try{
        const body=await strictJson(response,512);
        if(record(body)&&Object.keys(body).join(",")==="error"&&
          body.error==="Invalid request")return {outcome:"conflict"};
      }catch{/* A proxy response cannot prove an uncommitted write. */}
      return {outcome:"uncertain"};
    }
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
