/** Strict, bounded, read-only project command confirmation. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING=/^[A-Za-z0-9_-]{43}$/;
export const PROJECT_TITLE_RECEIPT_TIMEOUT_MS=8_000;
export type ProjectTitleReceiptResult=
 |{status:"committed";principalBinding:string}
 |{status:"not_recorded"|"denied"|"unavailable"};
const LIMIT=1024;
async function parse(response:Response,signal:AbortSignal):Promise<ProjectTitleReceiptResult>{
 if(response.redirected||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
    response.headers.get("cache-control")?.toLowerCase().split(",").some(x=>x.trim()==="no-store")!==true||
    !response.body)return {status:"unavailable"};
 const length=response.headers.get("content-length");
 if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>LIMIT))return {status:"unavailable"};
 const reader=response.body.getReader(),abort=()=>{void reader.cancel().catch(()=>{});};
 let done=false;signal.addEventListener("abort",abort,{once:true});
 try{
   const decoder=new TextDecoder("utf-8",{fatal:true});let raw="",size=0;
   for(;;){
     if(signal.aborted)return {status:"unavailable"};
     const chunk=await reader.read();
     if(signal.aborted)return {status:"unavailable"};
     if(chunk.done){done=true;break;}
     size+=chunk.value.byteLength;if(size>LIMIT)return {status:"unavailable"};
     raw+=decoder.decode(chunk.value,{stream:true});
   }
   raw+=decoder.decode();
   const val:unknown=JSON.parse(raw);
   if(!val||typeof val!=="object"||Array.isArray(val))return {status:"unavailable"};
   const x=val as Record<string,unknown>,keys=Object.keys(x).sort().join(",");
   if(keys==="status"&&x.status==="not_recorded")return {status:"not_recorded"};
   if(keys==="principalBinding,status"&&x.status==="committed"&&
     typeof x.principalBinding==="string"&&BINDING.test(x.principalBinding))
     return {status:"committed",principalBinding:x.principalBinding};
   return {status:"unavailable"};
 }catch{return {status:"unavailable"};}
 finally{
   signal.removeEventListener("abort",abort);
   if(!done)void reader.cancel().catch(()=>{});
   try{reader.releaseLock();}catch{/* already released */}
 }
}
export async function recoverProjectTitleReceipt(
  commandId:string,signal:AbortSignal,fetchImpl:typeof fetch=fetch,
  timeoutMs=PROJECT_TITLE_RECEIPT_TIMEOUT_MS,
):Promise<ProjectTitleReceiptResult>{
 if(!UUID.test(commandId)||signal.aborted)return {status:"unavailable"};
 const own=new AbortController(),abort=()=>own.abort();
 signal.addEventListener("abort",abort,{once:true});
 const duration=Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=PROJECT_TITLE_RECEIPT_TIMEOUT_MS?
   timeoutMs:PROJECT_TITLE_RECEIPT_TIMEOUT_MS;
 let timer:ReturnType<typeof setTimeout>|null=null;
 const deadline=new Promise<ProjectTitleReceiptResult>(resolve=>{
   timer=setTimeout(()=>{own.abort();resolve({status:"unavailable"});},duration);
 });
 const request=(async():Promise<ProjectTitleReceiptResult>=>{
   try{
     if(own.signal.aborted)return {status:"unavailable"};
     const response=await fetchImpl("/api/target-staging/project-title/recovery",{
       method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
       headers:{"content-type":"application/json",accept:"application/json","x-lumi-target-protocol":"1"},
       body:JSON.stringify({commandId}),signal:own.signal,
     });
     if(own.signal.aborted){void response.body?.cancel().catch(()=>{});return {status:"unavailable"};}
     if([401,403,404].includes(response.status)){
       void response.body?.cancel().catch(()=>{});return {status:"denied"};
     }
     if(response.status!==200){void response.body?.cancel().catch(()=>{});return {status:"unavailable"};}
     return parse(response,own.signal);
   }catch{return {status:"unavailable"};}
 })();
 try{return await Promise.race([request,deadline]);}
 finally{if(timer!==null)clearTimeout(timer);signal.removeEventListener("abort",abort);}
}
