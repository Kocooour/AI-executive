/** A missing receipt never unlocks a rename; only a durable server fence does. */
import {readableProjectId} from "./target-staging-project-tasks-client";
const BINDING=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ProjectTitleCancelStatus="cancelled"|"committed"|"unavailable";
export const PROJECT_TITLE_CANCEL_TIMEOUT_MS=8_000;
export async function cancelProjectTitleReload(
  projectId:string,commandId:string,restoreGeneration:string,
  principalBinding:string,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch,timeoutMs=PROJECT_TITLE_CANCEL_TIMEOUT_MS,
):Promise<ProjectTitleCancelStatus>{
  if(!readableProjectId(projectId)||!UUID.test(commandId)||!UUID.test(restoreGeneration)||!BINDING.test(principalBinding)||signal.aborted)
    return "unavailable";
  const own=new AbortController(),abort=()=>{own.abort();giveUp("unavailable");};
  let giveUp:(result:ProjectTitleCancelStatus)=>void=()=>{};
  const stopped=new Promise<ProjectTitleCancelStatus>(resolve=>{giveUp=resolve;});
  signal.addEventListener("abort",abort,{once:true});
  const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=PROJECT_TITLE_CANCEL_TIMEOUT_MS
    ?timeoutMs:PROJECT_TITLE_CANCEL_TIMEOUT_MS;
  const timer=setTimeout(abort,duration);
  const request=(async():Promise<ProjectTitleCancelStatus>=>{
    try{
      const response=await fetchImpl("/api/target-staging/projects/"+encodeURIComponent(projectId)+"/title/cancel",{
        method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:{"content-type":"application/json",accept:"application/json","x-lumi-target-protocol":"1"},
        body:JSON.stringify({commandId,restoreGeneration,principalBinding}),signal:own.signal,
      });
      if(own.signal.aborted||response.status!==200||response.redirected||
         response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
         response.headers.get("cache-control")?.trim().toLowerCase()!=="no-store"||!response.body)
        return "unavailable";
      const length=response.headers.get("content-length");
      if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||
          !Number.isSafeInteger(Number(length))||Number(length)>512))return "unavailable";
      const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
      let raw="",bytes=0;
      try{
        for(;;){
          if(own.signal.aborted)return "unavailable";
          const chunk=await reader.read();
          if(own.signal.aborted)return "unavailable";
          if(chunk.done)break;
          bytes+=chunk.value.byteLength;if(bytes>512)return "unavailable";
          raw+=decoder.decode(chunk.value,{stream:true});
        }
        raw+=decoder.decode();
      }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
      const value:unknown=JSON.parse(raw);
      if(!value||typeof value!=="object"||Array.isArray(value))return "unavailable";
      const record=value as Record<string,unknown>;
      if(Object.keys(record).sort().join(",")!=="principalBinding,status"||
         record.principalBinding!==principalBinding)return "unavailable";
      return record.status==="cancelled"||record.status==="committed"?record.status:"unavailable";
    }catch{return "unavailable";}
  })();
  try{return await Promise.race([request,stopped]);}
  finally{clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
