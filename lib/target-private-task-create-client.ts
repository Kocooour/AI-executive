/** Exact-command, non-retrying private task CREATE transport.
 * The server's receipt is bound to ALL original fields, including the title.
 * A failed/aborted HTTP request after dispatch never proves non-commit. */
export type PrivateTaskCreateCommand={
  taskId:string;commandId:string;areaId:string;restoreGeneration:string;title:string;
};
export type TaskCreateOutcome="saved"|"denied"|"uncertain";
export type TaskCreateReceipt="committed"|"not_recorded"|"denied"|"unavailable";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const area=/^[A-Za-z0-9_.:@-]{1,120}$/;
const encoder=new TextEncoder();
const record=(v:unknown):v is Record<string,unknown>=>
  v!==null&&typeof v==="object"&&!Array.isArray(v);
export function validPrivateTaskTitle(value:unknown):value is string{
  return typeof value==="string"&&value.length>0&&value===value.trim()&&
    value.isWellFormed()&&encoder.encode(value).length<=4096&&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
export function validPrivateTaskCreateCommand(v:unknown):v is PrivateTaskCreateCommand{
  if(!record(v)||Object.keys(v).sort().join(",")!==
    "areaId,commandId,restoreGeneration,taskId,title")return false;
  return typeof v.taskId==="string"&&uuid.test(v.taskId)&&
    v.taskId===v.taskId.toLowerCase()&&
    typeof v.commandId==="string"&&uuid.test(v.commandId)&&
    typeof v.areaId==="string"&&area.test(v.areaId)&&
    typeof v.restoreGeneration==="string"&&uuid.test(v.restoreGeneration)&&
    validPrivateTaskTitle(v.title);
}
const HEADERS={accept:"application/json","content-type":"application/json",
  "x-lumi-target-protocol":"1"};
function accepted(response:Response){
  return !response.redirected&&
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()==="application/json"&&
    (response.headers.get("cache-control")??"").split(",")
      .some(x=>x.trim().toLowerCase()==="no-store");
}
async function bounded(response:Response,signal:AbortSignal):Promise<unknown>{
  if(!accepted(response)||!response.body)throw Error("invalid response");
  const len=response.headers.get("content-length");
  if(len!==null&&(!/^(0|[1-9][0-9]*)$/.test(len)||
    !Number.isSafeInteger(Number(len))||Number(len)>1024))throw Error("length");
  const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
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
function opts(command:PrivateTaskCreateCommand,signal:AbortSignal):RequestInit{
  return {method:"POST",credentials:"same-origin",cache:"no-store",
    redirect:"error",headers:HEADERS,body:JSON.stringify(command),signal};
}
export async function sendPrivateTaskCreate(
  command:PrivateTaskCreateCommand,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<TaskCreateOutcome>{
  if(!validPrivateTaskCreateCommand(command)||signal.aborted)return "denied";
  try{
    const response=await fetchImpl("/api/target-staging/tasks",opts(command,signal));
    if(signal.aborted)return "uncertain";
    // Even 4xx might arrive after COMMIT or a session revocation race.
    if(response.status!==201&&response.status!==200)return "uncertain";
    const result=await bounded(response,signal);
    if(!record(result)||result.ok!==true||result.taskId!==command.taskId||
      Object.keys(result).sort().join(",")!==
      (response.status===201?"ok,taskId":"ok,replayed,taskId")||
      (response.status===200&&result.replayed!==true))return "uncertain";
    return "saved";
  }catch{return "uncertain";}
}
export async function checkPrivateTaskCreateReceipt(
  command:PrivateTaskCreateCommand,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<TaskCreateReceipt>{
  if(!validPrivateTaskCreateCommand(command)||signal.aborted)return "unavailable";
  try{
    const response=await fetchImpl("/api/target-staging/tasks/create-status",opts(command,signal));
    if(signal.aborted)return "unavailable";
    if([401,403,404].includes(response.status))return "denied";
    if(response.status!==200)return "unavailable";
    const result=await bounded(response,signal);
    return record(result)&&Object.keys(result).join(",")==="status"&&
      (result.status==="committed"||result.status==="not_recorded")
      ?result.status:"unavailable";
  }catch{return "unavailable";}
}
