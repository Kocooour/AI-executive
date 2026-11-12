/** Strict same-origin/no-store private note CREATE preview/POST/receipt.
 * No automatic retry and no mutable body in persistent browser storage. */
import {targetAppFetch} from "./target-app-fetch";
import {validNoteEditText} from "./target-staging-note-edit-client";
import {validNotePreviewId} from "./target-staging-note-preview-client";
export type PrivateNoteCreateCommand={
  noteId:string;commandId:string;areaId:string;restoreGeneration:string;
  title:string;body:string;
};
export type CreateOutcome="saved"|"conflict"|"denied"|"uncertain";
export type CreateReceipt="committed"|"not_recorded"|"denied"|"unavailable";
export type CreatePreflight={ok:true;restoreGeneration:string}|
  {ok:false;reason:"denied"|"unavailable"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isRecord(v:unknown):v is Record<string,unknown>{
  return v!==null&&typeof v==="object"&&!Array.isArray(v);
}
export function validPrivateNoteCreateCommand(v:unknown):v is PrivateNoteCreateCommand{
  if(!isRecord(v)||Object.keys(v).sort().join(",")!==
    "areaId,body,commandId,noteId,restoreGeneration,title")return false;
  return typeof v.noteId==="string"&&uuid.test(v.noteId)&&
    typeof v.commandId==="string"&&uuid.test(v.commandId)&&
    typeof v.restoreGeneration==="string"&&uuid.test(v.restoreGeneration)&&
    validNotePreviewId(v.areaId)&&typeof v.title==="string"&&
    typeof v.body==="string"&&validNoteEditText(v.title,v.body);
}
function accepted(response:Response):boolean{
  return !response.redirected&&
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()==="application/json"&&
    (response.headers.get("cache-control")??"").split(",")
      .some(x=>x.trim().toLowerCase()==="no-store");
}
async function bounded(response:Response,signal:AbortSignal):Promise<unknown>{
  if(!accepted(response)||!response.body)throw Error("invalid response");
  const rawLength=response.headers.get("content-length");
  if(rawLength!==null&&(!/^(0|[1-9][0-9]*)$/.test(rawLength)||
    !Number.isSafeInteger(Number(rawLength))||Number(rawLength)>1024))
    throw Error("invalid length");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  let size=0,text="",done=false;
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
    try{reader.releaseLock();}catch{/* already released */}
  }
}
const headers={accept:"application/json","content-type":"application/json",
  "x-lumi-target-protocol":"1"};
function opts(body:unknown,signal:AbortSignal):RequestInit{
  return {method:"POST",credentials:"same-origin",cache:"no-store",
    redirect:"error",headers,body:JSON.stringify(body),signal};
}
export async function privateNoteCreatePreflight(
  areaId:string,signal:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<CreatePreflight>{
  if(!validNotePreviewId(areaId)||signal.aborted)return {ok:false,reason:"unavailable"};
  try{
    const response=await fetchImpl("/api/target-staging/notes/create-preview",
      opts({areaId},signal));
    if(signal.aborted)return {ok:false,reason:"unavailable"};
    if([401,403,404,409].includes(response.status))return {ok:false,reason:"denied"};
    if(response.status!==200)return {ok:false,reason:"unavailable"};
    const value=await bounded(response,signal);
    if(!isRecord(value)||Object.keys(value).join(",")!=="restoreGeneration"||
      typeof value.restoreGeneration!=="string"||!uuid.test(value.restoreGeneration))
      return {ok:false,reason:"unavailable"};
    return {ok:true,restoreGeneration:value.restoreGeneration};
  }catch{return {ok:false,reason:"unavailable"};}
}
export async function sendPrivateNoteCreate(
  command:PrivateNoteCreateCommand,signal:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<CreateOutcome>{
  if(!validPrivateNoteCreateCommand(command)||signal.aborted)return "conflict";
  try{
    const response=await fetchImpl("/api/target-staging/notes",opts(command,signal));
    if(signal.aborted)return "uncertain";
    // A denied reply can occur AFTER a successful DB commit during a session
    // revocation race. Never use these statuses to release a dispatched UUID.
    if([400,409].includes(response.status))return "conflict";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==201&&response.status!==200)return "uncertain";
    const value=await bounded(response,signal);
    if(!isRecord(value)||value.ok!==true||
      Object.keys(value).sort().join(",")!==
        (response.status===201?"noteId,ok":"noteId,ok,replayed")||
      value.noteId!==command.noteId||
      (response.status===200&&value.replayed!==true))return "uncertain";
    return "saved";
  }catch{return "uncertain";}
}
export async function recoverPrivateNoteCreate(
  commandId:string,signal:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<CreateReceipt>{
  if(!uuid.test(commandId)||signal.aborted)return "unavailable";
  try{
    const response=await fetchImpl("/api/target-staging/notes/create-recovery",
      opts({commandId},signal));
    if(signal.aborted)return "unavailable";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200)return "unavailable";
    const value=await bounded(response,signal);
    if(!isRecord(value)||Object.keys(value).join(",")!=="status")
      return "unavailable";
    return value.status==="committed"||value.status==="not_recorded"
      ?value.status:"unavailable";
  }catch{return "unavailable";}
}
