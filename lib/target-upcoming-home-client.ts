/** C-2: bounded, no-store clients for actor-authorized target Upcoming and Home.
 * The API supplies authorization/ACL; browser dates select buckets, never grant access. */
import {targetAppFetch} from "./target-app-fetch";
import {validMyPlanDate,type MyPlanSliceFilter} from "./target-staging-my-plan-client";

export type C2Failure="signed-out"|"stale"|"unavailable"|"offline"|"invalid-response"|"aborted";
export type C2Result<T>={ok:true;value:T}|{ok:false;reason:C2Failure};
export type C2Task={
  taskId:string;title:string;projectId:string|null;areaId:string;
  areaKind:"private"|"shared";dueOn:string|null;whenOn:string|null;attentionOn:string;
};
export type C2DayPage={
  tasks:C2Task[];hasMore:boolean;nextCursor:string|null;
  window:"today"|"upcoming";evaluationDate:string;throughDate:string|null;
  areaFilter:MyPlanSliceFilter;
};
export type C2Summary={
  scope:"personal"|"shared"|"my-plan";
  counts:{projects:number;tasks:number};
  truncated:{projects:boolean;tasks:boolean};
};
const isRecord=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const filters:readonly string[]=["all","personal","shared"];

/** Calendar-date addition in UTC calendar arithmetic (not elapsed timezone hours). */
export function c2AddDays(day:string,days:number):string|null{
  if(!validMyPlanDate(day)||!Number.isSafeInteger(days)||days<0||days>90)return null;
  const date=new Date(day+"T12:00:00.000Z");
  date.setUTCDate(date.getUTCDate()+days);
  const result=date.toISOString().slice(0,10);
  return validMyPlanDate(result)?result:null;
}
export function c2SevenDayGroups(tasks:readonly C2Task[],today:string):{
  day:string;tasks:C2Task[];
}[]{
  const days=Array.from({length:7},(_,i)=>c2AddDays(today,i+1)).filter((day):day is string=>day!==null);
  return days.map(day=>({day,tasks:tasks.filter(task=>task.attentionOn===day)}));
}
export function parseC2Day(value:unknown,expect:{
  window:"today"|"upcoming";evaluationDate:string;throughDate:string|null;
  areaFilter:MyPlanSliceFilter;limit:number;
}):C2DayPage|null{
  if(!isRecord(value)||value.window!==expect.window||
    value.evaluationDate!==expect.evaluationDate||value.throughDate!==expect.throughDate||
    value.areaFilter!==expect.areaFilter||!Array.isArray(value.tasks)||
    value.tasks.length>expect.limit||typeof value.hasMore!=="boolean"||
    (value.hasMore&&value.tasks.length===0)||
    (value.hasMore
      ?typeof value.nextCursor!=="string"||value.nextCursor.length>4096||
        !cursorPattern.test(value.nextCursor)
      :value.nextCursor!==null))return null;
  const seen=new Set<string>(),tasks:C2Task[]=[];
  for(const raw of value.tasks){
    if(!isRecord(raw)||typeof raw.taskId!=="string"||raw.taskId.length===0||
      raw.taskId.includes("\0")||seen.has(raw.taskId)||
      typeof raw.title!=="string"||
      (raw.projectId!==null&&typeof raw.projectId!=="string")||
      typeof raw.areaId!=="string"||!raw.areaId||
      (raw.areaKind!=="private"&&raw.areaKind!=="shared")||
      (raw.areaKind==="shared"&&raw.assignedToMe!==true)||
      (expect.areaFilter==="personal"&&raw.areaKind!=="private")||
      (expect.areaFilter==="shared"&&raw.areaKind!=="shared")||
      (raw.dueOn!==null&&!validMyPlanDate(raw.dueOn))||
      (raw.whenOn!==null&&!validMyPlanDate(raw.whenOn))||
      !validMyPlanDate(raw.attentionOn)||
      raw.attentionOn!==[raw.dueOn,raw.whenOn].filter((d):d is string=>typeof d==="string").sort()[0]||
      (expect.window==="today"
        ?raw.attentionOn>expect.evaluationDate
        :raw.attentionOn<=expect.evaluationDate||
          expect.throughDate===null||raw.attentionOn>expect.throughDate)||
      (tasks.length>0&&raw.attentionOn<tasks[tasks.length-1].attentionOn))return null;
    seen.add(raw.taskId);
    tasks.push({taskId:raw.taskId,title:raw.title,projectId:raw.projectId as string|null,
      areaId:raw.areaId,areaKind:raw.areaKind,dueOn:raw.dueOn as string|null,
      whenOn:raw.whenOn as string|null,attentionOn:raw.attentionOn});
  }
  return {tasks,window:expect.window,evaluationDate:expect.evaluationDate,
    throughDate:expect.throughDate,areaFilter:expect.areaFilter,
    hasMore:value.hasMore,nextCursor:value.nextCursor as string|null};
}
export function parseC2Summary(value:unknown,scope:C2Summary["scope"]):C2Summary|null{
  if(!isRecord(value)||value.scope!==scope||!isRecord(value.counts)||
    !isRecord(value.truncated))return null;
  for(const key of ["tasks","projects"]){
    const count=value.counts[key];
    if(typeof count!=="number"||!Number.isSafeInteger(count)||count<0||count>1000||
      typeof value.truncated[key]!=="boolean")return null;
  }
  return {scope,counts:{tasks:value.counts.tasks as number,
    projects:value.counts.projects as number},truncated:{
      tasks:value.truncated.tasks as boolean,projects:value.truncated.projects as boolean}};
}
/** A failed/refused/changed-scope read cannot keep previous records on screen. */
async function getJson(url:string,signal?:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch):Promise<C2Result<unknown>>{
  if(signal?.aborted)return {ok:false,reason:"aborted"};
  try{
    const response=await fetchImpl(url,{credentials:"same-origin",cache:"no-store",
      redirect:"error",headers:{accept:"application/json"},signal});
    if(signal?.aborted){void response.body?.cancel().catch(()=>{});return {ok:false,reason:"aborted"};}
    if(response.status===401||response.status===403)return {ok:false,reason:"signed-out"};
    if(response.status===409)return {ok:false,reason:"stale"};
    if(!response.ok)return {ok:false,reason:"unavailable"};
    if(response.redirected||!response.headers.get("cache-control")?.toLowerCase().includes("no-store")||
      !response.headers.get("content-type")?.toLowerCase().includes("application/json"))
      return {ok:false,reason:"invalid-response"};
    // This endpoint's 100-row page and two counters fit within this budget.
    const raw=await response.text();
    if(signal?.aborted)return {ok:false,reason:"aborted"};
    if(raw.length>350_000)return {ok:false,reason:"invalid-response"};
    return {ok:true,value:JSON.parse(raw) as unknown};
  }catch{return {ok:false,reason:signal?.aborted?"aborted":"offline"};}
}
export async function fetchC2Day(input:{
  window:"today"|"upcoming";evaluationDate:string;throughDate:string|null;
  areaFilter:MyPlanSliceFilter;limit?:number;cursor?:string;signal?:AbortSignal;
},fetchImpl:typeof fetch=targetAppFetch):Promise<C2Result<C2DayPage>>{
  const limit=input.limit??50;
  if(!validMyPlanDate(input.evaluationDate)||!filters.includes(input.areaFilter)||
    !Number.isSafeInteger(limit)||limit<1||limit>100||
    (input.window==="today"?input.throughDate!==null:
      !input.throughDate||!validMyPlanDate(input.throughDate)||
      input.throughDate<=input.evaluationDate)||
    (input.cursor!==undefined&&(input.cursor.length>4096||!cursorPattern.test(input.cursor))))
    return {ok:false,reason:"invalid-response"};
  const q=new URLSearchParams({areaFilter:input.areaFilter,window:input.window,
    evaluationDate:input.evaluationDate,limit:String(limit)});
  if(input.throughDate)q.set("throughDate",input.throughDate);
  if(input.cursor)q.set("cursor",input.cursor);
  const data=await getJson("/api/target-staging/task-temporal/my-plan-day?"+q,input.signal,fetchImpl);
  if(!data.ok)return data;
  const page=parseC2Day(data.value,{window:input.window,evaluationDate:input.evaluationDate,
    throughDate:input.throughDate,areaFilter:input.areaFilter,limit});
  return page?{ok:true,value:page}:{ok:false,reason:"invalid-response"};
}
export async function fetchC2HomeSummary(scope:C2Summary["scope"],signal?:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch):Promise<C2Result<C2Summary>>{
  const data=await getJson("/api/target-staging/home/summary?scope="+scope,signal,fetchImpl);
  if(!data.ok)return data;
  const summary=parseC2Summary(data.value,scope);
  return summary?{ok:true,value:summary}:{ok:false,reason:"invalid-response"};
}
