/** R3-slice/UI-01 and BE-14/15: read-only, browser-side staging My Plan transport.
 * The server remains the authority for identity, Area ACL, cursor and epochs.
 * No task data is cached, persisted, or projected into the legacy task store. */
import {targetAppFetch} from "./target-app-fetch";
export type MyPlanSliceFilter="all"|"personal"|"shared";
export type MyPlanSliceTask={
  taskId:string;title:string;projectId:string|null;
  areaId:string;areaKind:"private"|"shared";assignedToMe?:true;
  dueOn:string|null;whenOn:string|null;attentionOn:string;
};
export type MyPlanSliceDay={tasks:MyPlanSliceTask[];hasMore:boolean};
export type MyPlanSlicePage={
  evaluationDate:string;areaFilter:MyPlanSliceFilter;
  today:MyPlanSliceDay;tomorrow:MyPlanSliceDay;
  hasMore:boolean;nextCursor:string|null;
};
export type MyPlanReadFailure="signed-out"|"stale"|"unavailable"|
  "offline"|"invalid-response"|"invalid-request"|"aborted";
export type MyPlanReadResult=
  |{ok:true;page:MyPlanSlicePage}
  |{ok:false;reason:MyPlanReadFailure};

const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const filterValues:readonly string[]=["all","personal","shared"];
function exactKeys(value:Record<string,unknown>,keys:string[]):boolean {
  return Object.keys(value).sort().join("|")===keys.sort().join("|");
}
function record(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
/** Calendar date in the user's device locale, without server timezone drift. */
export function localMyPlanDate(now=new Date()):string {
  const year=now.getFullYear(),month=now.getMonth()+1,day=now.getDate();
  return [String(year).padStart(4,"0"),String(month).padStart(2,"0"),
    String(day).padStart(2,"0")].join("-");
}
export function validMyPlanDate(value:unknown):value is string {
  if(typeof value!=="string"||!datePattern.test(value))return false;
  const parsed=new Date(value+"T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
function nextMyPlanDate(value:string):string|null{
  if(!validMyPlanDate(value))return null;
  const next=new Date(value+"T00:00:00.000Z");
  next.setUTCDate(next.getUTCDate()+1);
  const nextDate=next.toISOString().slice(0,10);
  return validMyPlanDate(nextDate)?nextDate:null;
}
function maybeDate(value:unknown):value is string|null {
  return value===null||validMyPlanDate(value);
}
function parseTask(value:unknown,filter:MyPlanSliceFilter):MyPlanSliceTask|null {
  if(!record(value))return null;
  const keys=["taskId","title","projectId","areaId","areaKind",
    "dueOn","whenOn","attentionOn"];
  if(value.areaKind==="shared")keys.push("assignedToMe");
  if(!exactKeys(value,keys)||
    typeof value.taskId!=="string"||!value.taskId||value.taskId.includes("\0")||
    typeof value.title!=="string"||
    (value.projectId!==null&&(typeof value.projectId!=="string"||!value.projectId))||
    typeof value.areaId!=="string"||!value.areaId||
    !["private","shared"].includes(String(value.areaKind))||
    (value.areaKind==="shared"&&value.assignedToMe!==true)||
    (filter==="personal"&&value.areaKind!=="private")||
    (filter==="shared"&&value.areaKind!=="shared")||
    !maybeDate(value.dueOn)||!maybeDate(value.whenOn)||
    !validMyPlanDate(value.attentionOn)||
    value.attentionOn!==[value.dueOn,value.whenOn].filter(
      (date):date is string=>typeof date==="string").sort()[0])return null;
  return value as MyPlanSliceTask;
}
function parseDay(
  value:unknown,filter:MyPlanSliceFilter,limit:number,
  match:(date:string)=>boolean,seen:Set<string>,
):MyPlanSliceDay|null {
  if(!record(value)||!exactKeys(value,["tasks","hasMore"])||
    !Array.isArray(value.tasks)||value.tasks.length>limit||
    typeof value.hasMore!=="boolean"||
    (value.hasMore&&value.tasks.length===0))return null;
  const tasks:MyPlanSliceTask[]=[];
  let previousDate:string|null=null;
  for(const item of value.tasks){
    const task=parseTask(item,filter);
    if(!task||!match(task.attentionOn)||seen.has(task.taskId)||
      (previousDate!==null&&task.attentionOn<previousDate))return null;
    seen.add(task.taskId);
    previousDate=task.attentionOn;
    tasks.push(task);
  }
  return {tasks,hasMore:value.hasMore};
}
export function parseMyPlanSlice(
  value:unknown,params:{evaluationDate:string;areaFilter:MyPlanSliceFilter;limit:number},
):MyPlanSlicePage|null {
  if(!record(value)||!exactKeys(value,[
    "evaluationDate","areaFilter","today","tomorrow","hasMore","nextCursor",
  ])||value.evaluationDate!==params.evaluationDate||
    value.areaFilter!==params.areaFilter||
    typeof value.hasMore!=="boolean")return null;
  const following=nextMyPlanDate(params.evaluationDate);
  if(!following)return null;
  const seen=new Set<string>();
  const today=parseDay(value.today,params.areaFilter,params.limit,
    date=>date<=params.evaluationDate,seen);
  const tomorrow=parseDay(value.tomorrow,params.areaFilter,params.limit,
    date=>date===following,seen);
  if(!today||!tomorrow||value.hasMore!==(today.hasMore||tomorrow.hasMore)||
    (value.hasMore
      ?typeof value.nextCursor!=="string"||value.nextCursor.length>4096||
       !cursorPattern.test(value.nextCursor)
      :value.nextCursor!==null))return null;
  return {
    evaluationDate:params.evaluationDate,areaFilter:params.areaFilter,
    today,tomorrow,hasMore:value.hasMore,
    nextCursor:value.nextCursor as string|null,
  };
}
/** Fail closed if a cursor returns duplicates or changes its actor-bound scope. */
export function appendMyPlanSlice(
  previous:MyPlanSlicePage,next:MyPlanSlicePage,
):MyPlanSlicePage|null {
  if(!previous.hasMore||!previous.nextCursor||
    previous.areaFilter!==next.areaFilter||
    previous.evaluationDate!==next.evaluationDate)return null;
  const seen=new Set([...previous.today.tasks,...previous.tomorrow.tasks]
    .map(task=>task.taskId));
  if([...next.today.tasks,...next.tomorrow.tasks].some(task=>seen.has(task.taskId)))
    return null;
  const mergedToday=[...previous.today.tasks,...next.today.tasks];
  const mergedTomorrow=[...previous.tomorrow.tasks,...next.tomorrow.tasks];
  if(mergedToday.some((task,i)=>i>0&&task.attentionOn<mergedToday[i-1].attentionOn)||
    mergedTomorrow.some((task,i)=>i>0&&task.attentionOn<mergedTomorrow[i-1].attentionOn))
    return null;
  return {...next,today:{tasks:mergedToday,hasMore:next.today.hasMore},
    tomorrow:{tasks:mergedTomorrow,hasMore:next.tomorrow.hasMore}};
}

/** BE-15: settle My Plan reads on abort before HTTP headers arrive.
 * A custom fetch adapter can ignore AbortSignal indefinitely; keep the real
 * GET and its signal unchanged, and cancel a response if it arrives too late.
 * Dispatch synchronously to preserve request ordering with rapid reloads. */
async function fetchMyPlanUntilAbort(
  request:()=>Promise<Response>,signal?:AbortSignal,
):Promise<Response|null>{
  if(!signal)return request();
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
    if(response===null){
      // The caller has already discarded this generation; no late body is
      // parsed or exposed, and the adapter cannot trigger a retry.
      void pending.then(late=>{discardMyPlanBody(late);},()=>{});
    }
    return response;
  }finally{
    signal.removeEventListener("abort",onAbort);
  }
}

// R3-slice/BE-14. Two day buckets may each hold 100 title-rich tasks.
// Eight MiB accommodates even JSON-escaped 4096-byte titles, yet bounds
// hostile/corrupted responses before JSON.parse and the strict DTO allowlist.
const MAX_MY_PLAN_RESPONSE_BYTES=8*1024*1024;
class InvalidMyPlanBody extends Error {}

function discardMyPlanBody(response:Response):void{
  try{if(response.body)void response.body.cancel().catch(()=>{});}
  catch{/* A synthetic or already-locked body is not safely cancellable. */}
}

function hasMyPlanNoStore(header:string|null):boolean{
  if(header===null)return false;
  let quoted=false,escaped=false,start=0;
  const parts:string[]=[];
  for(let i=0;i<header.length;i++){
    const char=header[i];
    if(escaped){escaped=false;continue;}
    if(quoted&&char==="\\"){escaped=true;continue;}
    if(char==='"'){quoted=!quoted;continue;}
    if(char===","&&!quoted){
      parts.push(header.slice(start,i).trim());start=i+1;
    }
  }
  if(quoted||escaped)return false;
  parts.push(header.slice(start).trim());
  return parts.some(part=>/^no-store$/i.test(part));
}

function hasMyPlanJsonType(header:string|null):boolean{
  return header!==null&&
    header.split(";")[0].trim().toLowerCase()==="application/json";
}

async function readBoundedMyPlanJson(
  response:Response,signal?:AbortSignal,
):Promise<unknown>{
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||
    Number(length)>MAX_MY_PLAN_RESPONSE_BYTES)){
    discardMyPlanBody(response);
    throw new InvalidMyPlanBody();
  }
  if(!response.body)throw new InvalidMyPlanBody();
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let received=0,text="",complete=false;
  const onAbort=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",onAbort,{once:true});
  try{
    for(;;){
      if(signal?.aborted)throw new InvalidMyPlanBody();
      const chunk=await reader.read();
      if(signal?.aborted)throw new InvalidMyPlanBody();
      if(chunk.done){complete=true;break;}
      if(!(chunk.value instanceof Uint8Array))throw new InvalidMyPlanBody();
      received+=chunk.value.byteLength;
      if(received>MAX_MY_PLAN_RESPONSE_BYTES)throw new InvalidMyPlanBody();
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    signal?.removeEventListener("abort",onAbort);
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export async function fetchMyPlanSlice(
  params:{evaluationDate:string;areaFilter?:MyPlanSliceFilter;
    limit?:number;cursor?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<MyPlanReadResult> {
  const areaFilter=params.areaFilter??"all";
  const limit=params.limit??50;
  if(!nextMyPlanDate(params.evaluationDate)||
    !filterValues.includes(areaFilter)||
    !Number.isSafeInteger(limit)||limit<1||limit>100||
    (params.cursor!==undefined&&(params.cursor.length>4096||
      !cursorPattern.test(params.cursor))))
    return {ok:false,reason:"invalid-request"};
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  const query=new URLSearchParams({
    evaluationDate:params.evaluationDate,areaFilter,limit:String(limit),
  });
  if(params.cursor!==undefined)query.set("cursor",params.cursor);
  let response:Response;
  try {
    const url="/api/target-staging/my-plan/slice?"+query;
    const init:RequestInit={
      method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
      headers:{accept:"application/json"},signal:params.signal,
    };
    const received=await fetchMyPlanUntilAbort(
      ()=>fetchImpl(url,init),params.signal);
    if(received===null)return {ok:false,reason:"aborted"};
    response=received;
  }catch{
    return {ok:false,reason:params.signal?.aborted?"aborted":"offline"};
  }
  if(params.signal?.aborted){
    discardMyPlanBody(response);
    return {ok:false,reason:"aborted"};
  }
  if(response.status!==200){
    discardMyPlanBody(response);
    if(response.status===401||response.status===403)
      return {ok:false,reason:"signed-out"};
    if(response.status===409)return {ok:false,reason:"stale"};
    if(response.status===400)return {ok:false,reason:"invalid-request"};
    return {ok:false,reason:"unavailable"};
  }
  if(response.redirected||
    !hasMyPlanNoStore(response.headers.get("cache-control"))||
    !hasMyPlanJsonType(response.headers.get("content-type"))){
    discardMyPlanBody(response);
    return {ok:false,reason:"invalid-response"};
  }
  try {
    const payload=await readBoundedMyPlanJson(response,params.signal);
    if(params.signal?.aborted)return {ok:false,reason:"aborted"};
    const parsed=parseMyPlanSlice(payload,
      {evaluationDate:params.evaluationDate,areaFilter,limit});
    return parsed?{ok:true,page:parsed}:{ok:false,reason:"invalid-response"};
  }catch{
    return {ok:false,reason:params.signal?.aborted?"aborted":"invalid-response"};
  }
}
