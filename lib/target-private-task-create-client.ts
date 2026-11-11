/** R3-FE: private standalone task CREATE over the exact default-off HTTP command.
 * No retries after an ambiguous POST. All server responses are strict/short/no-store. */
export type PrivateTaskCreateCommand={
  taskId:string;commandId:string;areaId:string;restoreGeneration:string;title:string;
};
export type TaskCreateOutcome="saved"|"conflict"|"denied"|"uncertain";
export type TaskCreateReceipt="committed"|"not_recorded"|"denied"|"unavailable";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const validPrivateTaskCreateArea=(id:unknown):id is string=>
  typeof id==="string"&&AREA.test(id);
function record(v:unknown):v is Record<string,unknown>{
  return v!==null&&typeof v==="object"&&!Array.isArray(v);
}
export function validPrivateTaskCreateCommand(v:unknown):v is PrivateTaskCreateCommand{
  if(!record(v)||Object.keys(v).sort().join(",")!==
    "areaId,commandId,restoreGeneration,taskId,title")return false;
  return typeof v.taskId==="string"&&UUID.test(v.taskId)&&v.taskId===v.taskId.toLowerCase()&&
    typeof v.commandId==="string"&&UUID.test(v.commandId)&&
    typeof v.areaId==="string"&&AREA.test(v.areaId)&&
    typeof v.restoreGeneration==="string"&&UUID.test(v.restoreGeneration)&&
    typeof v.title==="string"&&v.title.length>0&&v.title===v.title.trim()&&
    v.title.isWellFormed()&&new TextEncoder().encode(v.title).length<=4096&&
    !/[\u0000-\u001f\u007f]/u.test(v.title);
}
const headers={accept:"application/json","content-type":"application/json",
  "x-lumi-target-protocol":"1"};
const opts=(data:PrivateTaskCreateCommand,signal:AbortSignal):RequestInit=>({
  method:"POST",cache:"no-store",credentials:"same-origin",redirect:"error",
  headers,body:JSON.stringify(data),signal,
});
async function bounded(response:Response,signal:AbortSignal):Promise<unknown>{
  if(response.redirected||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
    !(response.headers.get("cache-control")??"").split(",").some(s=>s.trim().toLowerCase()==="no-store")||
    !response.body)throw Error("invalid response");
  const contentLength=response.headers.get("content-length");
  if(contentLength!==null&&(!/^(0|[1-9][0-9]*)$/.test(contentLength)||
    Number(contentLength)>1024))throw Error("oversized");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let bytes=0,text="",done=false;
  try{
    for(;;){
      if(signal.aborted)throw Error("aborted");
      const chunk=await reader.read();
      if(signal.aborted)throw Error("aborted");
      if(chunk.done){done=true;break;}
      bytes+=chunk.value.byteLength;
      if(bytes>1024)throw Error("oversized");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    if(!done)void reader.cancel().catch(()=>{});
    try{reader.releaseLock();}catch{/* reader already closed */}
  }
}
export async function sendPrivateTaskCreate(command:PrivateTaskCreateCommand,
  signal:AbortSignal,fetchImpl:typeof fetch=fetch):Promise<TaskCreateOutcome>{
  if(!validPrivateTaskCreateCommand(command)||signal.aborted)return "conflict";
  try{
    const response=await fetchImpl("/api/target-staging/tasks",opts(command,signal));
    if(signal.aborted)return "uncertain";
    if([400,409].includes(response.status))return "conflict";
    // A write can commit before a subsequent 401/403/404 under revocation.
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200&&response.status!==201)return "uncertain";
    const body=await bounded(response,signal);
    if(!record(body)||body.ok!==true||body.taskId!==command.taskId||
      Object.keys(body).sort().join(",")!==
        (response.status===201?"ok,taskId":"ok,replayed,taskId")||
      (response.status===200&&body.replayed!==true))return "uncertain";
    return "saved";
  }catch{return "uncertain";}
}
export async function recoverPrivateTaskCreate(command:PrivateTaskCreateCommand,
  signal:AbortSignal,fetchImpl:typeof fetch=fetch):Promise<TaskCreateReceipt>{
  if(!validPrivateTaskCreateCommand(command)||signal.aborted)return "unavailable";
  try{
    const response=await fetchImpl("/api/target-staging/tasks/create-status",opts(command,signal));
    if(signal.aborted)return "unavailable";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200)return "unavailable";
    const body=await bounded(response,signal);
    if(!record(body)||Object.keys(body).join(",")!=="status")return "unavailable";
    if(body.status==="committed"||body.status==="not_recorded")return body.status;
    return "unavailable";
  }catch{return "unavailable";}
}
