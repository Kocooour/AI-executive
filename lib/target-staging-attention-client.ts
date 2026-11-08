/** R2d.5e: staging-only, INACTIVE typed transport for the actor-private Attention
 * read (GET /api/target-staging/attention) and lifecycle command (preview GET,
 * PATCH, receipt POST). Mirrors BE-16/17: same-origin, no-store, bounded body,
 * strict DTO allowlists (extra keys, wrong types and foreign shapes are refused).
 * The server is the only authority for actor, Area ACL, CAS and cursors. This
 * module never retries, never persists, never logs payloads, and every failure
 * result is content-free. No component imports it yet. */
export type AttentionAreaFilter="all"|"personal"|"shared";
export type AttentionView="active"|"hidden";
export type AttentionRuleId="deadline_overdue"|"deadline_soon"|"planned_date_passed";
export type AttentionLifecycle="active"|"snoozed"|"dismissed";
export type AttentionAction="snooze"|"dismiss"|"restore";
export type AttentionItem={
  attentionKey:string;subjectType:"task";taskId:string;title:string;
  projectId:string|null;areaId:string;areaKind:"private"|"shared";
  assignedToMe?:true;
  ruleId:AttentionRuleId;ruleVersion:1;severity:1|2|5;reasonCode:AttentionRuleId;
  relevantOn:string;relevantAt:number;dueOn:string|null;whenOn:string|null;
  thresholdHours:0|48;sourceRevision:number;
  lifecycle:AttentionLifecycle;snoozedUntilMs:number|null;
  lifecycleRevision:number|null;
};
export type AttentionPage={
  items:AttentionItem[];hasMore:boolean;nextCursor:string|null;
  areaFilter:AttentionAreaFilter;view:AttentionView;timeZone:string;
  evaluationDate:string;soonThroughDate:string|null;evaluatedAtMs:number;
  attentionEpoch:number;
};
export type AttentionPreview={
  expectedRevision:string;expectedAttentionEpoch:number;
  expectedStateRevision:number|null;writeAreaId:string;restoreGeneration:string;
  lifecycle:AttentionLifecycle;snoozedUntilMs:number|null;
};
export type AttentionCommand={
  commandId:string;taskId:string;ruleId:AttentionRuleId;occurrenceOn:string;
  action:AttentionAction;snoozedUntilMs:number|null;expectedRevision:string;
  expectedAttentionEpoch:number;expectedStateRevision:number|null;
  writeAreaId:string;restoreGeneration:string;
};
/** Content-free failure vocabulary. "uncertain" only exists for PATCH. */
export type AttentionFailure="unauthorized"|"stale"|"conflict"|"not_found"|
  "invalid"|"unavailable"|"uncertain"|"aborted"|"invalid_response";
type Fail<K extends AttentionFailure>={status:K};
export type AttentionPageResult={status:"ok";page:AttentionPage}|
  Fail<Exclude<AttentionFailure,"uncertain"|"conflict">>;
export type AttentionPreviewResult={status:"ok";preview:AttentionPreview}|
  Fail<Exclude<AttentionFailure,"uncertain"|"stale">>;
export type AttentionSendResult={status:"ok";replayed:boolean}|
  Fail<Exclude<AttentionFailure,"stale"|"invalid_response">>;
export type AttentionReceiptResult={status:"ok";receipt:"committed"|"not_recorded"}|
  Fail<Exclude<AttentionFailure,"uncertain"|"stale">>;

const PAGE_URL="/api/target-staging/attention";
const COMMAND_URL=PAGE_URL+"/command";
const RECEIPT_URL=COMMAND_URL+"/receipt";
const MAX_PAGE_BYTES=2*1024*1024;
const MAX_SMALL_BYTES=16*1024;
const encoder=new TextEncoder();
const FILTERS:readonly string[]=["all","personal","shared"];
const VIEWS:readonly string[]=["active","hidden"];
const RULES:readonly string[]=["deadline_overdue","deadline_soon","planned_date_passed"];
const ACTIONS:readonly string[]=["snooze","dismiss","restore"];
const SEVERITY:Record<string,number>={
  deadline_overdue:1,deadline_soon:2,planned_date_passed:5,
};
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revisionPattern=/^[a-f0-9]{64}$/;
const areaPattern=/^[A-Za-z0-9_.:@-]{1,120}$/;
const keyPattern=/^tatt1:[0-9a-f]{64}$/;
const zonePattern=/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;

function obj(x:unknown):x is Record<string,unknown>{
  return x!==null&&typeof x==="object"&&!Array.isArray(x);
}
function exact(x:Record<string,unknown>,expected:readonly string[]):boolean{
  const actual=Object.keys(x).sort(),want=[...expected].sort();
  return actual.length===want.length&&actual.every((s,i)=>s===want[i]);
}
const epoch=(x:unknown):x is number=>
  typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
const optionalEpoch=(x:unknown):x is number|null=>x===null||epoch(x);
/** Read DTO identifiers mirror server's nonempty-string checks. Unlike PATCH,
 * this is not an input size policy: the entire response is already byte-bounded. */
function serverId(x:unknown):x is string{
  return typeof x==="string"&&x.length>0;
}
/** Same domain as the server's task id check (bounded, no NUL, well-formed). */
export function validAttentionTaskId(x:unknown):x is string{
  if(typeof x!=="string"||!x||x.includes("\0"))return false;
  try{
    return encoder.encode(x).byteLength<=4096&&
      decodeURIComponent(encodeURIComponent(x))===x;
  }catch{return false;}
}
export function validAttentionDate(x:unknown):x is string{
  if(typeof x!=="string"||!datePattern.test(x)||x.startsWith("0000"))return false;
  const parsed=new Date(x+"T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===x;
}
export function validAttentionTimeZone(x:unknown):x is string{
  if(typeof x!=="string"||x.length<1||x.length>64||!zonePattern.test(x))return false;
  try{new Intl.DateTimeFormat("en-US",{timeZone:x});return true;}
  catch{return false;}
}
const validCursor=(x:unknown):x is string=>
  typeof x==="string"&&x.length<=4096&&cursorPattern.test(x);
const validLimit=(x:unknown):x is number=>
  typeof x==="number"&&Number.isSafeInteger(x)&&x>=1&&x<=100;

const ITEM_KEYS="areaId,areaKind,attentionKey,dueOn,lifecycle,lifecycleRevision,projectId,reasonCode,relevantAt,relevantOn,ruleId,ruleVersion,severity,snoozedUntilMs,sourceRevision,subjectType,taskId,thresholdHours,title,whenOn";
type Window={evaluationDate:string;soonThroughDate:string|null};
/** Same CASE as the server selector; the client never invents the window. */
function currentRule(dueOn:string|null,whenOn:string|null,w:Window):string|null{
  const D=w.evaluationDate,S=w.soonThroughDate;
  if(dueOn!==null&&dueOn<D)return "deadline_overdue";
  if(dueOn!==null&&S!==null&&dueOn>=D&&dueOn<=S)return "deadline_soon";
  if(whenOn!==null&&whenOn<D&&!(dueOn!==null&&S!==null&&dueOn<=S))
    return "planned_date_passed";
  return null;
}
function compareBytes(a:string,b:string):number{
  const aa=encoder.encode(a),bb=encoder.encode(b);
  for(let i=0;i<Math.min(aa.length,bb.length);i++)
    if(aa[i]!==bb[i])return aa[i]-bb[i];
  return aa.length-bb.length;
}
/** Selector order: severity, relevantOn, then taskId bytes; strictly increasing. */
export function attentionItemBefore(a:AttentionItem,b:AttentionItem):boolean{
  if(a.severity!==b.severity)return a.severity<b.severity;
  if(a.relevantOn!==b.relevantOn)return a.relevantOn<b.relevantOn;
  return compareBytes(a.taskId,b.taskId)<0;
}
function parseItem(
  raw:unknown,p:{areaFilter:AttentionAreaFilter;view:AttentionView;
    evaluatedAtMs:number;window:Window},
):AttentionItem|null{
  if(!obj(raw))return null;
  const shared=raw.areaKind==="shared";
  if(!exact(raw,(ITEM_KEYS+(shared?",assignedToMe":"")).split(",")))return null;
  const t=raw;
  if(t.subjectType!=="task"||!serverId(t.taskId)||typeof t.title!=="string"||
    !serverId(t.areaId)||!(t.projectId===null||serverId(t.projectId))||
    (t.areaKind!=="private"&&t.areaKind!=="shared")||
    (shared&&t.assignedToMe!==true)||
    (p.areaFilter==="personal"&&shared)||(p.areaFilter==="shared"&&!shared)||
    !(t.dueOn===null||validAttentionDate(t.dueOn))||
    !(t.whenOn===null||validAttentionDate(t.whenOn))||
    typeof t.ruleId!=="string"||!(t.ruleId in SEVERITY)||
    t.reasonCode!==t.ruleId||t.ruleVersion!==1||t.severity!==SEVERITY[t.ruleId]||
    currentRule(t.dueOn as string|null,t.whenOn as string|null,p.window)!==t.ruleId||
    !validAttentionDate(t.relevantOn)||
    t.relevantOn!==(t.ruleId==="planned_date_passed"?t.whenOn:t.dueOn)||
    !epoch(t.relevantAt)||
    t.thresholdHours!==(t.ruleId==="deadline_soon"?48:0)||
    !epoch(t.sourceRevision)||
    typeof t.attentionKey!=="string"||!keyPattern.test(t.attentionKey))return null;
  if(p.view==="active"){
    if(t.lifecycle!=="active"||t.snoozedUntilMs!==null||
      !optionalEpoch(t.lifecycleRevision))return null;
  }else if(t.lifecycle==="dismissed"){
    if(t.snoozedUntilMs!==null||!epoch(t.lifecycleRevision))return null;
  }else if(t.lifecycle==="snoozed"){
    if(!epoch(t.snoozedUntilMs)||t.snoozedUntilMs<=p.evaluatedAtMs||
      !epoch(t.lifecycleRevision))return null;
  }else return null;
  const item:AttentionItem={
    attentionKey:t.attentionKey,subjectType:"task",taskId:t.taskId as string,
    title:t.title,projectId:t.projectId as string|null,areaId:t.areaId as string,
    areaKind:t.areaKind as "private"|"shared",
    ...(shared?{assignedToMe:true as const}:{}),
    ruleId:t.ruleId as AttentionRuleId,ruleVersion:1,
    severity:t.severity as 1|2|5,reasonCode:t.reasonCode as AttentionRuleId,
    relevantOn:t.relevantOn as string,relevantAt:t.relevantAt as number,
    dueOn:t.dueOn as string|null,whenOn:t.whenOn as string|null,
    thresholdHours:t.thresholdHours as 0|48,sourceRevision:t.sourceRevision as number,
    lifecycle:t.lifecycle as AttentionLifecycle,
    snoozedUntilMs:t.snoozedUntilMs as number|null,
    lifecycleRevision:t.lifecycleRevision as number|null,
  };
  return item;
}
/** Refuses actor/ACL/epoch metadata other than the one issued `attentionEpoch`
 * and everything that disagrees with the request the page was fetched for. */
export function parseAttentionPage(
  raw:unknown,params:{areaFilter:AttentionAreaFilter;view:AttentionView;
    limit:number},
):AttentionPage|null{
  if(!FILTERS.includes(params.areaFilter)||!VIEWS.includes(params.view)||
    !validLimit(params.limit))return null;
  if(!obj(raw)||!exact(raw,["items","hasMore","nextCursor","areaFilter","view",
    "timeZone","evaluationDate","soonThroughDate","evaluatedAtMs","attentionEpoch"])||
    raw.areaFilter!==params.areaFilter||raw.view!==params.view||
    // R2d.4k: the zone is the server-side PROFILE zone, display-only here.
    !validAttentionTimeZone(raw.timeZone)||!Array.isArray(raw.items)||
    raw.items.length>params.limit||typeof raw.hasMore!=="boolean"||
    (raw.hasMore&&(raw.items.length!==params.limit||!validCursor(raw.nextCursor)))||
    (!raw.hasMore&&raw.nextCursor!==null)||
    !epoch(raw.evaluatedAtMs)||!epoch(raw.attentionEpoch)||
    !validAttentionDate(raw.evaluationDate)||
    !(raw.soonThroughDate===null||(validAttentionDate(raw.soonThroughDate)&&
      raw.soonThroughDate>=raw.evaluationDate)))return null;
  const evaluationDate=raw.evaluationDate as string;
  const soonThroughDate=raw.soonThroughDate as string|null;
  const window:Window={evaluationDate,soonThroughDate};
  const items:AttentionItem[]=[],seen=new Set<string>(),areas=new Map<string,string>();
  for(const value of raw.items){
    const item=parseItem(value,{areaFilter:params.areaFilter,view:params.view,
      evaluatedAtMs:raw.evaluatedAtMs,window});
    if(!item||seen.has(item.taskId+"\0"+item.ruleId)||
      (areas.has(item.areaId)&&areas.get(item.areaId)!==item.areaKind)||
      (items.length>0&&!attentionItemBefore(items[items.length-1],item)))return null;
    seen.add(item.taskId+"\0"+item.ruleId);areas.set(item.areaId,item.areaKind);
    items.push(item);
  }
  return {items,hasMore:raw.hasMore,nextCursor:raw.nextCursor as string|null,
    areaFilter:params.areaFilter,view:params.view,timeZone:raw.timeZone as string,
    evaluationDate,soonThroughDate,
    evaluatedAtMs:raw.evaluatedAtMs,attentionEpoch:raw.attentionEpoch};
}
/** Continuation must keep the pinned instant, window and epoch, never re-use a
 * cursor and never repeat or reorder a row. Pure; returns null on any breach. */
export function appendAttentionPage(
  previous:AttentionPage,next:AttentionPage,
):AttentionPage|null{
  if(!previous.hasMore||!previous.nextCursor||
    previous.areaFilter!==next.areaFilter||previous.view!==next.view||
    previous.timeZone!==next.timeZone||
    previous.evaluatedAtMs!==next.evaluatedAtMs||
    previous.evaluationDate!==next.evaluationDate||
    previous.soonThroughDate!==next.soonThroughDate||
    previous.attentionEpoch!==next.attentionEpoch||
    (next.hasMore&&next.nextCursor===previous.nextCursor))return null;
  const seen=new Set(previous.items.map(i=>i.taskId+"\0"+i.ruleId));
  if(next.items.some(i=>seen.has(i.taskId+"\0"+i.ruleId))||
    (previous.items.length>0&&next.items.length>0&&
      !attentionItemBefore(previous.items[previous.items.length-1],next.items[0])))
    return null;
  return {...next,items:[...previous.items,...next.items]};
}
export function parseAttentionPreview(raw:unknown):AttentionPreview|null{
  if(!obj(raw)||!exact(raw,["expectedRevision","expectedAttentionEpoch",
    "expectedStateRevision","writeAreaId","restoreGeneration","lifecycle",
    "snoozedUntilMs"])||
    typeof raw.expectedRevision!=="string"||!revisionPattern.test(raw.expectedRevision)||
    !epoch(raw.expectedAttentionEpoch)||!optionalEpoch(raw.expectedStateRevision)||
    typeof raw.writeAreaId!=="string"||!areaPattern.test(raw.writeAreaId)||
    typeof raw.restoreGeneration!=="string"||!uuid.test(raw.restoreGeneration)||
    !["active","snoozed","dismissed"].includes(String(raw.lifecycle)))return null;
  const lifecycle=raw.lifecycle as AttentionLifecycle;
  if(lifecycle==="snoozed"){
    if(!epoch(raw.snoozedUntilMs)||raw.snoozedUntilMs<=0)return null;
  }else if(raw.snoozedUntilMs!==null)return null;
  // A stored lifecycle always has a state row; only "active" may lack one.
  if(lifecycle!=="active"&&raw.expectedStateRevision===null)return null;
  return {expectedRevision:raw.expectedRevision,
    expectedAttentionEpoch:raw.expectedAttentionEpoch,
    expectedStateRevision:raw.expectedStateRevision as number|null,
    writeAreaId:raw.writeAreaId,restoreGeneration:raw.restoreGeneration,
    lifecycle,snoozedUntilMs:raw.snoozedUntilMs as number|null};
}
const COMMAND_FIELDS=["commandId","taskId","ruleId","occurrenceOn","action",
  "snoozedUntilMs","expectedRevision","expectedAttentionEpoch",
  "expectedStateRevision","writeAreaId","restoreGeneration"];
/** Exactly the server writer's eleven-field command (no client time zone). */
export function validAttentionCommand(x:unknown):x is AttentionCommand{
  if(!obj(x)||!exact(x,COMMAND_FIELDS))return false;
  return typeof x.commandId==="string"&&uuid.test(x.commandId)&&
    validAttentionTaskId(x.taskId)&&
    typeof x.ruleId==="string"&&RULES.includes(x.ruleId)&&
    validAttentionDate(x.occurrenceOn)&&
    typeof x.action==="string"&&ACTIONS.includes(x.action)&&
    (x.action==="snooze"
      ?typeof x.snoozedUntilMs==="number"&&Number.isSafeInteger(x.snoozedUntilMs)&&
        x.snoozedUntilMs>0
      :x.snoozedUntilMs===null)&&
    typeof x.expectedRevision==="string"&&revisionPattern.test(x.expectedRevision)&&
    epoch(x.expectedAttentionEpoch)&&optionalEpoch(x.expectedStateRevision)&&
    typeof x.writeAreaId==="string"&&areaPattern.test(x.writeAreaId)&&
    typeof x.restoreGeneration==="string"&&uuid.test(x.restoreGeneration);
}

function discard(response:Response):void{
  try{if(response.body)void response.body.cancel().catch(()=>{});}
  catch{/* Synthetic or already-locked body; no task content retained. */}
}
function noStore(header:string|null):boolean{
  if(header===null)return false;
  let quoted=false,escaped=false,start=0;const parts:string[]=[];
  for(let i=0;i<header.length;i++){
    const c=header[i];
    if(escaped){escaped=false;continue;}
    if(quoted&&c==="\\"){escaped=true;continue;}
    if(c==='"'){quoted=!quoted;continue;}
    if(c===","&&!quoted){parts.push(header.slice(start,i).trim());start=i+1;}
  }
  if(quoted||escaped)return false;
  parts.push(header.slice(start).trim());
  return parts.some(part=>/^no-store$/i.test(part));
}
/** Starts synchronously. Returns null when the signal aborts first; a late
 * response is then released unread. */
async function fetchUntilAbort(
  request:()=>Promise<Response>,signal?:AbortSignal,
):Promise<Response|null>{
  if(!signal)return request();
  if(signal.aborted)return null;
  let wake=()=>{};
  const aborted=new Promise<null>(resolve=>{
    wake=()=>resolve(null);signal.addEventListener("abort",wake,{once:true});
  });
  try{
    const pending=Promise.resolve(request());
    const result=await Promise.race([pending,aborted]);
    if(result===null)void pending.then(discard,()=>{});
    return result;
  }finally{signal.removeEventListener("abort",wake);}
}
async function boundedJson(
  response:Response,maxBytes:number,signal?:AbortSignal,
):Promise<unknown>{
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>maxBytes)){
    discard(response);throw Error("size");
  }
  if(!response.body)throw Error("missing body");
  const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let bytes=0,text="",finished=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",abort,{once:true});
  try{
    for(;;){
      if(signal?.aborted)throw Error("aborted");
      const chunk=await reader.read();
      if(signal?.aborted)throw Error("aborted");
      if(chunk.done){finished=true;break;}
      if(!(chunk.value instanceof Uint8Array))throw Error("nonbinary");
      bytes+=chunk.value.byteLength;
      if(bytes>maxBytes)throw Error("size");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    signal?.removeEventListener("abort",abort);
    if(!finished)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
const jsonResponse=(r:Response):boolean=>
  !r.redirected&&noStore(r.headers.get("cache-control"))&&
  r.headers.get("content-type")?.split(";")[0].trim().toLowerCase()==="application/json";
/** Definitive pre-commit refusals shared by the read-like calls. */
function refusal(status:number,conflict:"stale"|"conflict"):
  "unauthorized"|"stale"|"conflict"|"not_found"|"invalid"|"unavailable"{
  if(status===401||status===403)return "unauthorized";
  if(status===409)return conflict;
  if(status===404)return "not_found";
  if(status===400)return "invalid";
  return "unavailable";
}
const readInit=(signal?:AbortSignal):RequestInit=>({
  method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{accept:"application/json"},signal,
});
const writeInit=(command:AttentionCommand,method:"PATCH"|"POST",
  signal?:AbortSignal):RequestInit=>({
  method,credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{accept:"application/json","content-type":"application/json",
    "x-lumi-target-protocol":"1"},
  // Rebuilt field by field: nothing but the eleven allowlisted keys is sent.
  body:JSON.stringify(Object.fromEntries(COMMAND_FIELDS.map(
    k=>[k,(command as unknown as Record<string,unknown>)[k]]))),
  signal,
});

/** GET only. The evaluation instant, time zone (server profile), actor and ACL
 * are never client inputs. */
export async function fetchAttentionPage(
  params:{areaFilter:AttentionAreaFilter;view:AttentionView;
    limit:number;cursor?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=fetch,
):Promise<AttentionPageResult>{
  const {areaFilter,view,limit,cursor,signal}=params;
  if(!FILTERS.includes(areaFilter)||!VIEWS.includes(view)||
    !validLimit(limit)||
    (cursor!==undefined&&!validCursor(cursor)))return {status:"invalid"};
  if(signal?.aborted)return {status:"aborted"};
  const query=new URLSearchParams({areaFilter,view,limit:String(limit)});
  if(cursor!==undefined)query.set("cursor",cursor);
  let response:Response;
  try{
    const received=await fetchUntilAbort(
      ()=>fetchImpl(PAGE_URL+"?"+query,readInit(signal)),signal);
    if(received===null)return {status:"aborted"};
    response=received;
  }catch{return {status:signal?.aborted?"aborted":"unavailable"};}
  if(signal?.aborted){discard(response);return {status:"aborted"};}
  if(response.status!==200){
    discard(response);
    const reason=refusal(response.status,"stale");
    return {status:reason as Exclude<typeof reason,"conflict">};
  }
  if(!jsonResponse(response)){discard(response);return {status:"invalid_response"};}
  try{
    const raw=await boundedJson(response,MAX_PAGE_BYTES,signal);
    if(signal?.aborted)return {status:"aborted"};
    const page=parseAttentionPage(raw,{areaFilter,view,limit});
    return page?{status:"ok",page}:{status:"invalid_response"};
  }catch{return {status:signal?.aborted?"aborted":"invalid_response"};}
}

/** Fresh CAS inputs for one occurrence, from one server snapshot. */
export async function fetchAttentionCommandPreview(
  params:{taskId:string;ruleId:AttentionRuleId;occurrenceOn:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=fetch,
):Promise<AttentionPreviewResult>{
  const {taskId,ruleId,occurrenceOn,signal}=params;
  if(!validAttentionTaskId(taskId)||!RULES.includes(ruleId)||
    !validAttentionDate(occurrenceOn))return {status:"invalid"};
  if(signal?.aborted)return {status:"aborted"};
  let response:Response;
  try{
    const received=await fetchUntilAbort(()=>fetchImpl(COMMAND_URL+"?"+
      new URLSearchParams({taskId,ruleId,occurrenceOn}),readInit(signal)),signal);
    if(received===null)return {status:"aborted"};
    response=received;
  }catch{return {status:signal?.aborted?"aborted":"unavailable"};}
  if(signal?.aborted){discard(response);return {status:"aborted"};}
  if(response.status!==200){
    discard(response);
    const reason=refusal(response.status,"conflict");
    return {status:reason as Exclude<typeof reason,"stale">};
  }
  if(!jsonResponse(response)){discard(response);return {status:"invalid_response"};}
  try{
    const raw=await boundedJson(response,MAX_SMALL_BYTES,signal);
    if(signal?.aborted)return {status:"aborted"};
    const preview=parseAttentionPreview(raw);
    return preview?{status:"ok",preview}:{status:"invalid_response"};
  }catch{return {status:signal?.aborted?"aborted":"invalid_response"};}
}

/** Exactly ONE PATCH, never retried. After the request left the client, every
 * ambiguous outcome (network loss, abort, 5xx, malformed 2xx) is "uncertain":
 * only the receipt of the SAME command can tell. Definitive refusals are not. */
export async function sendAttentionCommand(
  command:AttentionCommand,signal?:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<AttentionSendResult>{
  if(!validAttentionCommand(command))return {status:"invalid"};
  if(signal?.aborted)return {status:"aborted"};
  let response:Response|null;
  try{
    response=await fetchUntilAbort(
      ()=>fetchImpl(COMMAND_URL,writeInit(command,"PATCH",signal)),signal);
  }catch{return {status:"uncertain"};}
  if(response===null)return {status:"uncertain"};
  if(signal?.aborted){discard(response);return {status:"uncertain"};}
  const code=response.status;
  if(code!==200){
    discard(response);
    if(code===401||code===403)return {status:"unauthorized"};
    if(code===400)return {status:"invalid"};
    if(code===404)return {status:"not_found"};
    if(code===409)return {status:"conflict"};
    // The rate limiter answers before any work; it is not an ambiguous commit.
    if(code===429)return {status:"unavailable"};
    return {status:"uncertain"};
  }
  if(!jsonResponse(response)){discard(response);return {status:"uncertain"};}
  try{
    const body=await boundedJson(response,MAX_SMALL_BYTES,signal);
    if(signal?.aborted)return {status:"uncertain"};
    if(obj(body)&&body.ok===true&&(exact(body,["ok"])||
      (exact(body,["ok","replayed"])&&body.replayed===true)))
      return {status:"ok",replayed:body.replayed===true};
  }catch{/* A malformed success may still follow a real commit. */}
  return {status:"uncertain"};
}

/** Read-only POST with the SAME original command. "not_recorded" is never a
 * rollback proof for a later retry; the caller must reload and decide anew. */
export async function fetchAttentionCommandReceipt(
  command:AttentionCommand,signal?:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<AttentionReceiptResult>{
  if(!validAttentionCommand(command))return {status:"invalid"};
  if(signal?.aborted)return {status:"aborted"};
  let response:Response;
  try{
    const received=await fetchUntilAbort(
      ()=>fetchImpl(RECEIPT_URL,writeInit(command,"POST",signal)),signal);
    if(received===null)return {status:"aborted"};
    response=received;
  }catch{return {status:signal?.aborted?"aborted":"unavailable"};}
  if(signal?.aborted){discard(response);return {status:"aborted"};}
  if(response.status!==200){
    discard(response);
    const reason=refusal(response.status,"conflict");
    return {status:reason as Exclude<typeof reason,"stale">};
  }
  if(!jsonResponse(response)){discard(response);return {status:"invalid_response"};}
  try{
    const body=await boundedJson(response,MAX_SMALL_BYTES,signal);
    if(signal?.aborted)return {status:"aborted"};
    if(obj(body)&&exact(body,["status"])){
      if(body.status==="committed")return {status:"ok",receipt:"committed"};
      if(body.status==="not_recorded")return {status:"ok",receipt:"not_recorded"};
    }
    return {status:"invalid_response"};
  }catch{return {status:signal?.aborted?"aborted":"invalid_response"};}
}
