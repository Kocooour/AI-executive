/** UI-09c: ephemeral, read-only transport for one server-authorized project.
 * IDs are untrusted selectors, NEVER ACL proof. No caching, writes or retries. */
export type ProjectTasksFailure="invalid-request"|"signed-out"|"not-found"|
  "stale"|"unavailable"|"offline"|"aborted"|"invalid-response";
export type ProjectTasksProject={
  id:string;title:string;areaId:string;areaKind:"private"|"shared";
};
export type ProjectTasksTask={
  id:string;title:string;projectId:string;areaId:string;
  effectiveAreaId:string;areaKind:"private"|"shared";assignedToMe?:boolean;
};
export type ProjectTasksPage={
  project:ProjectTasksProject;tasks:ProjectTasksTask[];
  hasMore:boolean;nextCursor:string|null;
};
export type ProjectTasksOutcome={ok:true;page:ProjectTasksPage}|
  {ok:false;reason:ProjectTasksFailure};

const encoder=new TextEncoder();
const cursor=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const control=/[\u0000-\u001f\u007f]/u;
const maxBytes=1024*1024;
const record=(v:unknown):v is Record<string,unknown>=>
  v!==null&&typeof v==="object"&&!Array.isArray(v);
const exact=(x:Record<string,unknown>,keys:string[]):boolean=>
  Object.keys(x).sort().join("|")===keys.sort().join("|");
const wellFormed=(s:string):boolean=>{
  try{return decodeURIComponent(encodeURIComponent(s))===s;}catch{return false;}
};
export function readableProjectId(v:unknown):v is string{
  return typeof v==="string"&&v.length>0&&v!=="."&&v!==".."&&
    !control.test(v)&&wellFormed(v)&&encoder.encode(v).length<=512;
}
const validTitle=(v:unknown):v is string=>
  typeof v==="string"&&v.trim().length>0&&wellFormed(v)&&
    encoder.encode(v).length<=4096;
const validCursor=(v:unknown):v is string=>
  typeof v==="string"&&v.length<=4096&&cursor.test(v);
function byteCompare(a:string,b:string):number{
  const aa=encoder.encode(a),bb=encoder.encode(b);
  for(let i=0;i<Math.min(aa.length,bb.length);i++)
    if(aa[i]!==bb[i])return aa[i]-bb[i];
  return aa.length-bb.length;
}
export function parseProjectTasksPage(
  value:unknown,expected:{projectId:string;limit:number},
):ProjectTasksPage|null{
  if(!record(value)||!exact(value,["project","tasks","hasMore","nextCursor"])||
    !record(value.project)||!exact(value.project,["id","title","areaId","areaKind"])||
    !readableProjectId(value.project.id)||value.project.id!==expected.projectId||
    !readableProjectId(value.project.areaId)||!validTitle(value.project.title)||
    !["private","shared"].includes(String(value.project.areaKind))||
    !Array.isArray(value.tasks)||value.tasks.length>expected.limit||
    typeof value.hasMore!=="boolean"||
    (value.hasMore?(value.tasks.length!==expected.limit||
      !validCursor(value.nextCursor)):value.nextCursor!==null))return null;
  const project=value.project as ProjectTasksProject;
  const tasks:ProjectTasksTask[]=[];
  for(const raw of value.tasks){
    if(!record(raw)||!exact(raw,[
      "id","title","projectId","areaId","effectiveAreaId","areaKind",
      ...(project.areaKind==="shared"?["assignedToMe"]:[]),
    ])||!readableProjectId(raw.id)||!validTitle(raw.title)||
      raw.projectId!==project.id||raw.areaId!==project.areaId||
      raw.effectiveAreaId!==project.areaId||raw.areaKind!==project.areaKind||
      (project.areaKind==="shared"&&typeof raw.assignedToMe!=="boolean")||
      (tasks.length>0&&byteCompare(tasks[tasks.length-1].id,raw.id)>=0))
      return null;
    tasks.push(raw as ProjectTasksTask);
  }
  return {project,tasks,hasMore:value.hasMore,
    nextCursor:value.nextCursor as string|null};
}
function discard(res:Response):void{
  try{if(res.body)void res.body.cancel().catch(()=>{});}catch{}
}
function noStore(header:string|null):boolean{
  return header!==null&&header.split(",").some(v=>/^no-store$/i.test(v.trim()));
}
async function boundedJson(res:Response,signal?:AbortSignal):Promise<unknown>{
  const length=res.headers.get("content-length");
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>maxBytes)){
    discard(res);throw Error("oversized");
  }
  if(!res.body)throw Error("no body");
  const reader=res.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",abort,{once:true});
  let text="",bytes=0,complete=false;
  try{
    for(;;){
      if(signal?.aborted)throw Error("aborted");
      const chunk=await reader.read();
      if(signal?.aborted)throw Error("aborted");
      if(chunk.done){complete=true;break;}
      bytes+=chunk.value.byteLength;
      if(bytes>maxBytes)throw Error("oversized");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    signal?.removeEventListener("abort",abort);
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
async function fetchUntilAbort(
  load:()=>Promise<Response>,signal?:AbortSignal,
):Promise<Response|null>{
  if(!signal)return load();
  if(signal.aborted)return null;
  let onAbort=()=>{};
  const aborted=new Promise<null>(resolve=>{
    onAbort=()=>resolve(null);
    signal.addEventListener("abort",onAbort,{once:true});
  });
  try{
    if(signal.aborted)return null;
    const pending=Promise.resolve(load());
    const value=await Promise.race([pending,aborted]);
    if(value===null)void pending.then(discard,()=>{});
    return value;
  }finally{signal.removeEventListener("abort",onAbort);}
}
/** One explicit GET per call, always from the currently authenticated server. */
export async function loadProjectTasksPage(
  options:{projectId:string;limit?:number;cursor?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=fetch,
):Promise<ProjectTasksOutcome>{
  const limit=options.limit??25;
  if(!readableProjectId(options.projectId)||!Number.isSafeInteger(limit)||
    limit<1||limit>100||
    (options.cursor!==undefined&&!validCursor(options.cursor)))
    return {ok:false,reason:"invalid-request"};
  if(options.signal?.aborted)return {ok:false,reason:"aborted"};
  const query=new URLSearchParams({limit:String(limit)});
  if(options.cursor!==undefined)query.set("cursor",options.cursor);
  let response:Response;
  try{
    const received=await fetchUntilAbort(
      ()=>fetchImpl("/api/target-staging/projects/"+
        encodeURIComponent(options.projectId)+"/tasks?"+query.toString(),{
        method:"GET",credentials:"same-origin",cache:"no-store",
        redirect:"error",headers:{accept:"application/json"},
        signal:options.signal,
      }),options.signal);
    if(received===null)return {ok:false,reason:"aborted"};
    response=received;
  }catch{return {ok:false,reason:options.signal?.aborted?"aborted":"offline"};}
  if(options.signal?.aborted){discard(response);return {ok:false,reason:"aborted"};}
  if(response.status!==200){
    discard(response);
    if(response.status===401||response.status===403)
      return {ok:false,reason:"signed-out"};
    if(response.status===404)return {ok:false,reason:"not-found"};
    if(response.status===409)return {ok:false,reason:"stale"};
    if(response.status===400)return {ok:false,reason:"invalid-request"};
    return {ok:false,reason:"unavailable"};
  }
  if(response.redirected||!noStore(response.headers.get("cache-control"))||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
      !=="application/json"){
    discard(response);return {ok:false,reason:"invalid-response"};
  }
  try{
    const value=await boundedJson(response,options.signal);
    if(options.signal?.aborted)return {ok:false,reason:"aborted"};
    const page=parseProjectTasksPage(value,{projectId:options.projectId,limit});
    return page?{ok:true,page}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:options.signal?.aborted?"aborted":"invalid-response"};}
}
/** No cross-page replay, duplicates, hidden change of project or memory growth. */
export function appendProjectTasksPage(
  prior:ProjectTasksPage,next:ProjectTasksPage,askedCursor:string,
):ProjectTasksPage|null{
  if(!prior.hasMore||prior.nextCursor!==askedCursor||
    prior.project.id!==next.project.id||
    prior.project.title!==next.project.title||
    prior.project.areaId!==next.project.areaId||
    prior.project.areaKind!==next.project.areaKind||
    (next.hasMore&&next.nextCursor===askedCursor)||
    prior.tasks.length+next.tasks.length>500||
    (prior.tasks.length>0&&next.tasks.length>0&&
      byteCompare(prior.tasks[prior.tasks.length-1].id,next.tasks[0].id)>=0))
    return null;
  return {...next,tasks:[...prior.tasks,...next.tasks]};
}
