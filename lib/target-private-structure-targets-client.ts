/** Structure-owned private Area and restore-generation catalog. All inputs are
 * server-authorized, short-lived hints; the pinned create rechecks current ACL. */
import {targetAppFetch} from "./target-app-fetch";
import {parsePrivateNoteAreaChoices,type PrivateNoteAreaChoice}
  from "./target-private-note-area-client";
import {MAX_PRIVATE_NOTE_AREA_CATALOG_BYTES} from "./target-staging-read-limits";
export type StructureTargets=
  |{ok:true;areas:PrivateNoteAreaChoice[];restoreGeneration:string;ownerScope:string}
  |{ok:false;reason:"signed-out"|"unavailable"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownerScopePattern=/^[A-Za-z0-9_-]{43}$/;
export async function loadStructureCreateTargets(
  signal:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<StructureTargets>{
  if(signal.aborted)return {ok:false,reason:"unavailable"};
  try{
    const response=await fetchImpl("/api/target-staging/projects/create-targets",{
      method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{accept:"application/json"},signal,
    });
    if(signal.aborted)return {ok:false,reason:"unavailable"};
    if([401,403].includes(response.status))return {ok:false,reason:"signed-out"};
    if(response.status!==200||response.redirected||
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
      !(response.headers.get("cache-control")||"").split(",").some(x=>x.trim().toLowerCase()==="no-store")||
      !response.body)return {ok:false,reason:"unavailable"};
    const size=response.headers.get("content-length");
    const bound=MAX_PRIVATE_NOTE_AREA_CATALOG_BYTES+128;
    if(size!==null&&(!/^(0|[1-9][0-9]*)$/.test(size)||
      !Number.isSafeInteger(Number(size))||Number(size)>bound))
      return {ok:false,reason:"unavailable"};
    const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
    let total=0,raw="",done=false;
    try{
      for(;;){
        if(signal.aborted)throw Error("aborted");
        const chunk=await reader.read();
        if(signal.aborted)throw Error("aborted");
        if(chunk.done){done=true;break;}
        total+=chunk.value.byteLength;if(total>bound)throw Error("oversize");
        raw+=decoder.decode(chunk.value,{stream:true});
      }
      raw+=decoder.decode();
    }finally{if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
    const data:unknown=JSON.parse(raw);
    if(!data||typeof data!=="object"||Array.isArray(data))throw Error("invalid");
    const obj=data as Record<string,unknown>;
    if(Object.keys(obj).sort().join(",")!=="areas,ownerScope,restoreGeneration"||
      typeof obj.restoreGeneration!=="string"||!uuid.test(obj.restoreGeneration)||
      typeof obj.ownerScope!=="string"||!ownerScopePattern.test(obj.ownerScope))
      throw Error("invalid");
    const areas=parsePrivateNoteAreaChoices({areas:obj.areas});
    if(!areas)throw Error("invalid");
    return {ok:true,areas,restoreGeneration:obj.restoreGeneration,ownerScope:obj.ownerScope};
  }catch{return {ok:false,reason:"unavailable"};}
}
