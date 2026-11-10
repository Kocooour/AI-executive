/** Read-only, content-free receipt check for one tab-recovered command UUID.
 * No mutation or optimistic success. A stalled fetch OR response stream is
 * bounded; the caller must keep its reload barrier unless status=committed. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const NOTE_EDIT_RECOVERY_TIMEOUT_MS=8_000;
export type NoteEditReceiptRecovery="committed"|"not_recorded"|"denied"|"unavailable";
const MAX_RESPONSE_BYTES=1024;
function accepted(response:Response):boolean{
  return !response.redirected&&
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()==="application/json"&&
    response.headers.get("cache-control")?.toLowerCase().split(",").some(v=>v.trim()==="no-store")===true;
}
async function readStatus(response:Response,signal:AbortSignal):Promise<NoteEditReceiptRecovery>{
  if(!accepted(response)||!response.body)return "unavailable";
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||
     !Number.isSafeInteger(Number(length))||Number(length)>MAX_RESPONSE_BYTES))
    return "unavailable";
  const reader=response.body.getReader();
  let done=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  try{
    let total=0,text="";
    const decoder=new TextDecoder("utf-8",{fatal:true});
    for(;;){
      if(signal.aborted)return "unavailable";
      const chunk=await reader.read();
      if(signal.aborted)return "unavailable";
      if(chunk.done){done=true;break;}
      total+=chunk.value.byteLength;
      if(total>MAX_RESPONSE_BYTES)return "unavailable";
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    const value:unknown=JSON.parse(text);
    if(!value||typeof value!=="object"||Array.isArray(value))return "unavailable";
    const v=value as Record<string,unknown>;
    if(Object.keys(v).join(",")!=="status")return "unavailable";
    if(v.status==="committed"||v.status==="not_recorded")return v.status;
    return "unavailable";
  }catch{return "unavailable";}
  finally{
    signal.removeEventListener("abort",abort);
    if(!done)void reader.cancel().catch(()=>{});
    try{reader.releaseLock();}catch{/* already released */}
  }
}
export async function recoverNoteEditAfterReload(
  commandId:string,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
  timeoutMs=NOTE_EDIT_RECOVERY_TIMEOUT_MS,
):Promise<NoteEditReceiptRecovery>{
  if(!UUID.test(commandId)||signal.aborted)return "unavailable";
  const own=new AbortController();
  const abort=()=>own.abort();
  signal.addEventListener("abort",abort,{once:true});
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&
    timeoutMs<=NOTE_EDIT_RECOVERY_TIMEOUT_MS
    ?timeoutMs:NOTE_EDIT_RECOVERY_TIMEOUT_MS;
  let timeout:ReturnType<typeof setTimeout>|null=null;
  const deadline=new Promise<NoteEditReceiptRecovery>(resolve=>{
    timeout=setTimeout(()=>{own.abort();resolve("unavailable");},duration);
  });
  const request=(async():Promise<NoteEditReceiptRecovery>=>{
    try{
      if(own.signal.aborted)return "unavailable";
      const response=await fetchImpl("/api/target-staging/notes/edit-recovery",{
        method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:{"content-type":"application/json",accept:"application/json",
          "x-lumi-target-protocol":"1"},
        body:JSON.stringify({commandId}),signal:own.signal,
      });
      if(own.signal.aborted){void response.body?.cancel().catch(()=>{});return "unavailable";}
      if([401,403,404].includes(response.status)){
        void response.body?.cancel().catch(()=>{});
        return "denied";
      }
      if(response.status!==200){
        void response.body?.cancel().catch(()=>{});
        return "unavailable";
      }
      return await readStatus(response,own.signal);
    }catch{return "unavailable";}
  })();
  try{return await Promise.race([request,deadline]);}
  finally{
    if(timeout!==null)clearTimeout(timeout);
    signal.removeEventListener("abort",abort);
  }
}
