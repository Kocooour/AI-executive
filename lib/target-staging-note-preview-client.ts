/** UI-09d: explicit, no-store read of exactly one server-authorized staging note.
 * The server remains sole authority; never treat a parsed response as permission. */
export type NotePreview={
  id:string;title:string;body:string;projectId:string|null;
  areaId:string;areaKind:"private"|"shared";revision:number;
};
export type NotePreviewFailure="invalid-request"|"signed-out"|"not-found"|
  "stale"|"disabled"|"rate-limited"|"unavailable"|"offline"|"aborted"|"invalid-response";
export type NotePreviewResult={ok:true;note:NotePreview}|{ok:false;reason:NotePreviewFailure};

const encoder=new TextEncoder();
const control=/[\u0000-\u001f\u007f]/u;
const MAX_RESPONSE_BYTES=1024*1024;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function wellFormed(s:string){try{return decodeURIComponent(encodeURIComponent(s))===s;}catch{return false;}}
function validId(value:unknown):value is string{
  return typeof value==="string"&&value.length>0&&value.trim()===value&&
    value!=="."&&value!==".."&&!control.test(value)&&wellFormed(value)&&
    encoder.encode(value).length<=512;
}
export const validNotePreviewId=validId;
function parsedNote(v:unknown,id:string):NotePreview|null{
  if(!record(v)||Object.keys(v).sort().join("|")!==
    ["id","title","body","projectId","areaId","areaKind","revision"].sort().join("|"))
    return null;
  if(v.id!==id||!validId(v.id)||!validId(v.areaId)||
    (v.projectId!==null&&!validId(v.projectId))||
    (v.areaKind!=="private"&&v.areaKind!=="shared")||
    typeof v.title!=="string"||v.title.trim().length===0||
    !wellFormed(v.title)||encoder.encode(v.title).length>4096||
    typeof v.body!=="string"||!wellFormed(v.body)||
    encoder.encode(v.body).length>128*1024||
    !Number.isSafeInteger(v.revision)||(v.revision as number)<0)return null;
  return {
    id:v.id,title:v.title,body:v.body,projectId:v.projectId,
    areaId:v.areaId,areaKind:v.areaKind,revision:v.revision,
  } as NotePreview;
}
export function parseNotePreview(value:unknown,id:string):NotePreview|null{
  if(!validId(id)||!record(value)||Object.keys(value).join("|")!=="note")
    return null;
  return parsedNote(value.note,id);
}
function failureForStatus(status:number):NotePreviewFailure{
  if(status===401||status===403)return "signed-out";
  if(status===404)return "not-found"; // missing vs unauthorized is intentionally indistinguishable
  if(status===409)return "stale";
  if(status===429)return "rate-limited";
  if(status===400)return "invalid-request";
  return "unavailable";
}
function discard(response:Response){
  try{if(response.body)void response.body.cancel().catch(()=>{});}catch{}
}
async function fetchUntilAbort(
  request:()=>Promise<Response>,signal:AbortSignal,
):Promise<Response|null>{
  if(signal.aborted)return null;
  let onAbort=()=>{};
  const aborted=new Promise<null>(resolve=>{
    onAbort=()=>resolve(null);
    signal.addEventListener("abort",onAbort,{once:true});
  });
  try{
    if(signal.aborted)return null;
    const pending=Promise.resolve(request());
    const response=await Promise.race([pending,aborted]);
    if(response===null)void pending.then(discard,()=>{});
    return response;
  }finally{signal.removeEventListener("abort",onAbort);}
}
async function boundedJson(response:Response,signal:AbortSignal):Promise<unknown>{
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>MAX_RESPONSE_BYTES))
    throw Error("invalid length");
  if(!response.body)throw Error("missing body");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  let text="",bytes=0,completed=false;
  try{
    for(;;){
      if(signal.aborted)throw Error("aborted");
      const chunk=await reader.read();
      if(signal.aborted)throw Error("aborted");
      if(chunk.done){completed=true;break;}
      if(!(chunk.value instanceof Uint8Array))throw Error("invalid chunk");
      bytes+=chunk.value.byteLength;
      if(bytes>MAX_RESPONSE_BYTES)throw Error("oversized");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    signal.removeEventListener("abort",abort);
    if(!completed)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export async function readStagingNotePreview(
  noteId:string,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<NotePreviewResult>{
  if(!validId(noteId))return {ok:false,reason:"invalid-request"};
  if(signal.aborted)return {ok:false,reason:"aborted"};
  const url="/api/target-staging/notes/"+encodeURIComponent(noteId);
  let response:Response|null;
  try{
    response=await fetchUntilAbort(()=>fetchImpl(url,{
      method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{accept:"application/json"},signal,
    }),signal);
  }catch{return {ok:false,reason:signal.aborted?"aborted":"offline"};}
  if(response===null)return {ok:false,reason:"aborted"};
  if(signal.aborted){discard(response);return {ok:false,reason:"aborted"};}
  if(response.status!==200){
    discard(response);
    return {ok:false,reason:failureForStatus(response.status)};
  }
  const type=response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if(response.redirected||type!=="application/json"||
    response.headers.get("cache-control")?.trim().toLowerCase()!=="no-store"){
    discard(response);
    return {ok:false,reason:"invalid-response"};
  }
  try{
    const body=await boundedJson(response,signal);
    if(signal.aborted)return {ok:false,reason:"aborted"};
    const note=parseNotePreview(body,noteId);
    return note?{ok:true,note}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:signal.aborted?"aborted":"invalid-response"};}
}
