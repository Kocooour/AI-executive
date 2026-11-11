/** A missing receipt never unlocks a rename; only a durable server fence does. */
import {readableProjectId} from "./target-staging-project-tasks-client";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ProjectTitleCancelStatus="cancelled"|"committed"|"unavailable";
export async function cancelProjectTitleReload(
  projectId:string,commandId:string,restoreGeneration:string,signal:AbortSignal,
  fetchImpl:typeof fetch=fetch,
):Promise<ProjectTitleCancelStatus>{
  if(!readableProjectId(projectId)||!UUID.test(commandId)||!UUID.test(restoreGeneration)||signal.aborted)
    return "unavailable";
  try{
    const response=await fetchImpl("/api/target-staging/projects/"+encodeURIComponent(projectId)+"/title/cancel",{
      method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{"content-type":"application/json",accept:"application/json","x-lumi-target-protocol":"1"},
      body:JSON.stringify({commandId,restoreGeneration}),signal,
    });
    if(signal.aborted||response.status!==200||response.redirected||
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
        if(signal.aborted)return "unavailable";
        const chunk=await reader.read();
        if(chunk.done)break;
        bytes+=chunk.value.byteLength;if(bytes>512)return "unavailable";
        raw+=decoder.decode(chunk.value,{stream:true});
      }
      raw+=decoder.decode();
    }finally{try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=="object"||Array.isArray(value))return "unavailable";
    const record=value as Record<string,unknown>;
    if(Object.keys(record).join(",")!=="status")return "unavailable";
    return record.status==="cancelled"||record.status==="committed"?record.status:"unavailable";
  }catch{return "unavailable";}
}
