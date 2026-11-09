/** UI-09d: explicit, no-store read of exactly one server-authorized staging task.
 * The server remains sole authority; never treat a parsed response as permission. */
export type TaskPreview={
  id:string;title:string;projectId:string|null;areaId:string;
  areaKind:"private"|"shared";status:"open"|"completed";
  completedAtMs:number|null;dueOn:string|null;assignedToMe?:boolean;
};
export type TaskPreviewFailure="invalid-request"|"signed-out"|"not-found"|
  "stale"|"disabled"|"rate-limited"|"unavailable"|"offline"|"aborted"|"invalid-response";
export type TaskPreviewResult={ok:true;task:TaskPreview}|{ok:false;reason:TaskPreviewFailure};

const encoder=new TextEncoder();
const control=/[\u0000-\u001f\u007f]/u;
const MAX_RESPONSE_BYTES=1024*1024;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function wellFormed(s:string){try{return decodeURIComponent(encodeURIComponent(s))===s;}catch{return false;}}
function validId(value:unknown):value is string{
  return typeof value==="string"&&value.length>0&&value.trim()===value&&
    value!=="."&&value!==".."&&!value.includes("/")&&!value.includes("\\")&&
    !control.test(value)&&wellFormed(value)&&
    encoder.encode(value).length<=512;
}
export const validTaskPreviewId=validId;
function parsedTask(v:unknown,id:string):TaskPreview|null{
  if(!record(v))return null;
  const shared=v.areaKind==="shared";
  const keys=["id","title","projectId","areaId","areaKind","status","completedAtMs","dueOn",...(shared?["assignedToMe"]:[])];
  if(Object.keys(v).sort().join("|")!==keys.sort().join("|")||v.id!==id||!validId(v.id)||
    typeof v.areaId!=="string"||!wellFormed(v.areaId)||encoder.encode(v.areaId).length>4096||
    (v.projectId!==null&&(typeof v.projectId!=="string"||!wellFormed(v.projectId)||encoder.encode(v.projectId).length>4096))||
    (v.areaKind!=="private"&&!shared)||typeof v.title!=="string"||!wellFormed(v.title)||
    v.title.length>4096||
    (v.status!=="open"&&v.status!=="completed")||
    (v.status==="open"?v.completedAtMs!==null:!Number.isSafeInteger(v.completedAtMs)||(v.completedAtMs as number)<0)||
    (v.dueOn!==null&&(typeof v.dueOn!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v.dueOn)))||
    (shared&&typeof v.assignedToMe!=="boolean"))return null;
  return v as TaskPreview;
}
export function parseTaskPreview(value:unknown,id:string):TaskPreview|null{
  if(!validId(id)||!record(value)||Object.keys(value).join("|")!=="task")
    return null;
  return parsedTask(value.task,id);
}
function failureForStatus(status:number):TaskPreviewFailure{
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
export async function readStagingTaskPreview(
  taskId:string,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<TaskPreviewResult>{
  if(!validId(taskId))return {ok:false,reason:"invalid-request"};
  if(signal.aborted)return {ok:false,reason:"aborted"};
  const url="/api/target-staging/task-temporal/detail?taskId="+encodeURIComponent(taskId);
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
    const task=parseTaskPreview(body,taskId);
    return task?{ok:true,task}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:signal.aborted?"aborted":"invalid-response"};}
}
