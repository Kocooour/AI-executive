/** Ephemeral staging note edit. A PATCH is sent once; uncertain results use
 * the read-only command status and never silently replay the mutation. */
import {validNotePreviewId} from "./target-staging-note-preview-client";

export type EditFailure="signed-out"|"stale"|"not-found"|"rate-limited"|
  "unavailable"|"invalid-response"|"offline"|"aborted";
export type EditProof={expectedRevision:string;restoreGeneration:string;writeAreaId:string};
export type EditCommand=EditProof&{title:string;body:string;commandId:string};
type Result<T>={ok:true;value:T}|{ok:false;reason:EditFailure};
const hex=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function failure(status:number):EditFailure{
  if(status===401||status===403)return "signed-out";
  if(status===404)return "not-found";
  if(status===409)return "stale";
  if(status===429)return "rate-limited";
  return "unavailable";
}
async function request(url:string,method:"GET"|"PATCH"|"POST",body:unknown,
  signal:AbortSignal,fetchImpl:typeof fetch):Promise<Result<unknown>>{
  if(signal.aborted)return {ok:false,reason:"aborted"};
  let response:Response;
  try{
    response=await fetchImpl(url,{method,credentials:"same-origin",cache:"no-store",
      redirect:"error",signal,headers:{accept:"application/json",
        ...(method==="GET"?{}:{"content-type":"application/json",
          "x-lumi-target-protocol":"1",origin:globalThis.location?.origin??""})},
      ...(method==="GET"?{}:{body:JSON.stringify(body)}),
    });
  }catch{return {ok:false,reason:signal.aborted?"aborted":"offline"};}
  if(signal.aborted){void response.body?.cancel().catch(()=>{});return {ok:false,reason:"aborted"};}
  if(response.status!==200){void response.body?.cancel().catch(()=>{});
    return {ok:false,reason:failure(response.status)};}
  if(response.redirected||response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
    !response.headers.get("cache-control")?.toLowerCase().split(",").some(s=>s.trim()==="no-store")){
    void response.body?.cancel().catch(()=>{});return {ok:false,reason:"invalid-response"};
  }
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>4096)){
    void response.body?.cancel().catch(()=>{});return {ok:false,reason:"invalid-response"};
  }
  try{
    if(!response.body)throw Error("missing body");
    const reader=response.body.getReader();
    const abort=()=>{void reader.cancel().catch(()=>{});};
    signal.addEventListener("abort",abort,{once:true});
    const decoder=new TextDecoder("utf-8",{fatal:true});
    let text="",bytes=0;
    try{
      for(;;){
        if(signal.aborted)throw Error("aborted");
        const chunk=await reader.read();
        if(chunk.done)break;
        bytes+=chunk.value.byteLength;
        if(bytes>4096)throw Error("oversized");
        text+=decoder.decode(chunk.value,{stream:true});
      }
      text+=decoder.decode();
    }finally{signal.removeEventListener("abort",abort);reader.releaseLock();}
    if(signal.aborted)return {ok:false,reason:"aborted"};
    return {ok:true,value:JSON.parse(text) as unknown};
  }catch{return {ok:false,reason:signal.aborted?"aborted":"invalid-response"};}
}
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).sort().join("|")===keys.sort().join("|");
function url(noteId:string){if(!validNotePreviewId(noteId))throw new TypeError("Invalid note ID");
  return "/api/target-staging/notes/"+encodeURIComponent(noteId)+"/edit";}
export async function preflightNoteEdit(noteId:string,signal:AbortSignal,fetchImpl:typeof fetch=fetch):Promise<Result<EditProof>>{
  const result=await request(url(noteId),"GET",null,signal,fetchImpl);
  if(result.ok===false)return result;
  const v=result.value;
  if(!record(v)||!exact(v,["expectedRevision","restoreGeneration","writeAreaId"])||
    typeof v.expectedRevision!=="string"||!hex.test(v.expectedRevision)||
    typeof v.restoreGeneration!=="string"||!uuid.test(v.restoreGeneration)||
    !validNotePreviewId(v.writeAreaId))return {ok:false,reason:"invalid-response"};
  return {ok:true,value:v as EditProof};
}
export async function patchNoteEdit(noteId:string,command:EditCommand,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch):Promise<Result<"committed">>{
  const result=await request(url(noteId),"PATCH",command,signal,fetchImpl);
  if(result.ok===false)return result;
  const v=result.value;
  return record(v)&&exact(v,Object.hasOwn(v,"replayed")?["ok","replayed"]:["ok"])&&
    v.ok===true&&(v.replayed===undefined||v.replayed===true)
    ?{ok:true,value:"committed"}:{ok:false,reason:"invalid-response"};
}
export async function statusNoteEdit(noteId:string,command:EditCommand,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch):Promise<Result<"committed"|"not_recorded">>{
  const result=await request(url(noteId)+"/status","POST",command,signal,fetchImpl);
  if(result.ok===false)return result;
  const v=result.value;
  return record(v)&&exact(v,["status"])&&(v.status==="committed"||v.status==="not_recorded")
    ?{ok:true,value:v.status}:{ok:false,reason:"invalid-response"};
}
/** Content-free recovery after reload; committed is the only unlock proof. */
export async function recoverNoteEdit(commandId:string,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch):Promise<Result<"committed"|"not_recorded">>{
  if(!uuid.test(commandId))return {ok:false,reason:"invalid-response"};
  const result=await request("/api/target-staging/notes/edit-recovery","POST",{commandId},signal,fetchImpl);
  if(result.ok===false)return result;
  const v=result.value;
  return record(v)&&exact(v,["status"])&&(v.status==="committed"||v.status==="not_recorded")
    ?{ok:true,value:v.status}:{ok:false,reason:"invalid-response"};
}
