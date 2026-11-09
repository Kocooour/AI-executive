/** R3 / BE-16: staging-only typed global Vše / Osobní / Sdílené read.
 * This is NOT the personal My Plan ("all" there means only my work).
 * The server remains the sole authority for actor, Area ACL and cursors.
 * No persistence, prefetch, writes, retries, or production UI activation. */
export type GlobalIndexScope="all"|"personal"|"shared";
type AreaKind="private"|"shared";
export type GlobalProject={id:string;title:string;areaId:string;areaKind:AreaKind};
export type GlobalTask={id:string;title:string;projectId:string|null;
  areaId:string;areaKind:AreaKind;status:"open"|"completed";dueOn:string|null;
  assignedToMe?:boolean};
export type GlobalNote={id:string;title:string;projectId:string|null;
  areaId:string;areaKind:AreaKind;revision:number};
export type GlobalIndexItem=
  |{kind:"project";item:GlobalProject}
  |{kind:"task";item:GlobalTask}
  |{kind:"note";item:GlobalNote};
export type GlobalIndexPage={scope:GlobalIndexScope;items:GlobalIndexItem[];
  hasMore:boolean;nextCursor:string|null};
export type GlobalIndexFailure="signed-out"|"stale"|"invalid-request"|
  "invalid-response"|"unavailable"|"offline"|"aborted"|"rate-limited";
export type GlobalIndexResult={ok:true;page:GlobalIndexPage}|
  {ok:false;reason:GlobalIndexFailure};

const scopes:readonly string[]=["all","personal","shared"];
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY_BYTES=8*1024*1024;
const encoder=new TextEncoder();
function obj(x:unknown):x is Record<string,unknown>{
  return x!==null&&typeof x==="object"&&!Array.isArray(x);
}
function keys(x:Record<string,unknown>,expected:string[]):boolean{
  const actual=Object.keys(x).sort();
  return actual.length===expected.length&&
    actual.every((s,i)=>s===expected.sort()[i]);
}
function id(x:unknown):x is string{
  return typeof x==="string"&&x.length>0&&x!=="."&&x!==".."&&
    encoder.encode(x).byteLength<=512&&!/[\u0000-\u001f\u007f]/.test(x);
}
function date(x:unknown):x is string{
  if(typeof x!=="string"||!datePattern.test(x))return false;
  const parsed=new Date(x+"T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===x;
}
function optionalDate(x:unknown):x is string|null{
  return x===null||date(x);
}
function validCursor(x:unknown):x is string{
  return typeof x==="string"&&x.length<=4096&&cursorPattern.test(x);
}
function parseItem(raw:unknown,scope:GlobalIndexScope):GlobalIndexItem|null{
  if(!obj(raw)||!keys(raw,["kind","item"])||!obj(raw.item))return null;
  const value=raw.item;
  if(!id(value.id)||typeof value.title!=="string"||
    !id(value.areaId)||!["private","shared"].includes(String(value.areaKind))||
    (scope==="personal"&&value.areaKind!=="private")||
    (scope==="shared"&&value.areaKind!=="shared"))return null;
  if(raw.kind==="project"){
    if(!keys(value,["id","title","areaId","areaKind"]))return null;
  }else if(raw.kind==="task"){
    const fields=["id","title","projectId","areaId","areaKind","status","dueOn"];
    if(value.areaKind==="shared")fields.push("assignedToMe");
    if(!keys(value,fields)||
      !(value.projectId===null||id(value.projectId))||
      !["open","completed"].includes(String(value.status))||
      !optionalDate(value.dueOn)||
      (value.areaKind==="shared"&&typeof value.assignedToMe!=="boolean"))
      return null;
  }else if(raw.kind==="note"){
    if(!keys(value,["id","title","projectId","areaId","areaKind","revision"])||
      !(value.projectId===null||id(value.projectId))||
      value.id!==value.id.trim()||
      typeof value.revision!=="number"||!Number.isSafeInteger(value.revision)||
      value.revision<0)return null;
  }else return null;
  return raw as GlobalIndexItem;
}
const order:Record<GlobalIndexItem["kind"],number>={project:0,task:1,note:2};
function compare(a:GlobalIndexItem,b:GlobalIndexItem):number{
  const aa=encoder.encode(a.item.id),bb=encoder.encode(b.item.id);
  for(let i=0;i<Math.min(aa.length,bb.length);i++)
    if(aa[i]!==bb[i])return aa[i]-bb[i];
  return aa.length-bb.length||order[a.kind]-order[b.kind];
}
/** Refuse unexpected actor/ACL/epoch metadata and cross-scope records. */
export function parseGlobalIndexPage(
  raw:unknown,params:{scope:GlobalIndexScope;limit:number},
):GlobalIndexPage|null{
  if(!obj(raw)||!keys(raw,["scope","items","hasMore","nextCursor"])||
    raw.scope!==params.scope||!Array.isArray(raw.items)||
    raw.items.length>params.limit||typeof raw.hasMore!=="boolean"||
    (raw.hasMore&&(raw.items.length===0||!validCursor(raw.nextCursor)))||
    (!raw.hasMore&&raw.nextCursor!==null))return null;
  const items:GlobalIndexItem[]=[],seen=new Set<string>();
  for(const value of raw.items){
    const item=parseItem(value,params.scope);
    if(!item||seen.has(item.kind+"\0"+item.item.id)||
      (items.length>0&&compare(items[items.length-1],item)>=0))return null;
    items.push(item);seen.add(item.kind+"\0"+item.item.id);
  }
  return {scope:params.scope,items,hasMore:raw.hasMore,
    nextCursor:raw.nextCursor as string|null};
}
/** Pagination refuses duplicate rows, re-used cursors and cross-kind disorder. */
export function appendGlobalIndexPage(
  previous:GlobalIndexPage,next:GlobalIndexPage,
):GlobalIndexPage|null{
  if(!previous.hasMore||!previous.nextCursor||
    previous.scope!==next.scope||
    (next.hasMore&&next.nextCursor===previous.nextCursor))return null;
  const seen=new Set(previous.items.map(item=>item.kind+"\0"+item.item.id));
  if(next.items.some(item=>seen.has(item.kind+"\0"+item.item.id))||
    (previous.items.length>0&&next.items.length>0&&
      compare(previous.items[previous.items.length-1],next.items[0])>=0))
    return null;
  return {...next,items:[...previous.items,...next.items]};
}
/** R3 / BE-17: ephemeral continuation state for EXPLICIT global-index reads.
 * The server still authorizes every page. Caller must discard the chain on
 * logout, identity/scope change or ANY failed fetch (including 401/409).
 * Never persist titles/cursors or silently prefetch the next page. */
export type GlobalIndexPageChain={
  readonly scope:GlobalIndexScope;
  readonly limit:number;
  readonly page:GlobalIndexPage;
  readonly issuedCursors:readonly string[];
};

/** Start only with a successfully decoded and individually validated page. */
export function beginGlobalIndexPageChain(
  result:GlobalIndexResult,params:{scope:GlobalIndexScope;limit:number},
):GlobalIndexPageChain|null{
  if(!result.ok||!scopes.includes(params.scope)||
    !Number.isSafeInteger(params.limit)||params.limit<1||params.limit>100)return null;
  const page=parseGlobalIndexPage(result.page,params);
  if(!page)return null;
  return {scope:params.scope,limit:params.limit,page,
    issuedCursors:page.nextCursor?[page.nextCursor]:[]};
}

/** Consume ONE explicitly requested continuation, never reusing an old cursor.
 * Returns null instead of a partial title list on any protocol/ACL failure.
 * This pure function does not fetch or retain anything outside its caller. */
export function advanceGlobalIndexPageChain(
  previous:GlobalIndexPageChain,requestedCursor:string,result:GlobalIndexResult,
):GlobalIndexPageChain|null{
  if(!previous||!result.ok||
    !scopes.includes(previous.scope)||
    !Number.isSafeInteger(previous.limit)||previous.limit<1||previous.limit>100||
    !previous.page.hasMore||
    !validCursor(requestedCursor)||
    previous.page.nextCursor!==requestedCursor||
    !Array.isArray(previous.issuedCursors)||
    !previous.issuedCursors.includes(requestedCursor))return null;
  const next=parseGlobalIndexPage(result.page,{
    scope:previous.scope,limit:previous.limit,
  });
  if(!next||(next.nextCursor!==null&&
    previous.issuedCursors.includes(next.nextCursor)))return null;
  const combined=appendGlobalIndexPage(previous.page,next);
  if(!combined)return null;
  return {scope:previous.scope,limit:previous.limit,page:combined,
    issuedCursors:next.nextCursor
      ?[...previous.issuedCursors,next.nextCursor]
      :[...previous.issuedCursors]};
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
    if(signal.aborted)return null;
    // Start synchronously; do not change ordering of explicit user reads.
    const pending=Promise.resolve(request());
    const result=await Promise.race([pending,aborted]);
    if(result===null)void pending.then(discard,()=>{});
    return result;
  }finally{signal.removeEventListener("abort",wake);}
}
/** Size-bounded (8 MiB, Content-Length and streamed), strict UTF-8 JSON read. */
export async function boundedJson(response:Response,signal?:AbortSignal):Promise<unknown>{
  const length=response.headers.get("content-length");
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||
    !Number.isSafeInteger(Number(length))||Number(length)>MAX_BODY_BYTES)){
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
      if(bytes>MAX_BODY_BYTES)throw Error("size");
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
/** GET only, no client-chosen actor or global My Plan scope equivalence. */
export async function fetchGlobalIndexPage(
  params:{scope:GlobalIndexScope;limit?:number;cursor?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=fetch,
):Promise<GlobalIndexResult>{
  const limit=params.limit??50;
  if(!scopes.includes(params.scope)||!Number.isSafeInteger(limit)||
    limit<1||limit>100||
    (params.cursor!==undefined&&!validCursor(params.cursor)))
    return {ok:false,reason:"invalid-request"};
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  const query=new URLSearchParams({scope:params.scope,limit:String(limit)});
  if(params.cursor!==undefined)query.set("cursor",params.cursor);
  let response:Response;
  try{
    const received=await fetchUntilAbort(
      ()=>fetchImpl("/api/target-staging/global-index?"+query,{
        method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:{accept:"application/json"},signal:params.signal,
      }),params.signal);
    if(received===null)return {ok:false,reason:"aborted"};
    response=received;
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"offline"};}
  if(params.signal?.aborted){discard(response);return {ok:false,reason:"aborted"};}
  if(response.status!==200){
    discard(response);
    if(response.status===401||response.status===403)
      return {ok:false,reason:"signed-out"};
    if(response.status===409)return {ok:false,reason:"stale"};
    if(response.status===400)return {ok:false,reason:"invalid-request"};
    if(response.status===429)return {ok:false,reason:"rate-limited"};
    return {ok:false,reason:"unavailable"};
  }
  if(response.redirected||!noStore(response.headers.get("cache-control"))||
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
      !=="application/json"){
    discard(response);return {ok:false,reason:"invalid-response"};
  }
  try{
    const raw=await boundedJson(response,params.signal);
    if(params.signal?.aborted)return {ok:false,reason:"aborted"};
    const page=parseGlobalIndexPage(raw,{scope:params.scope,limit});
    return page?{ok:true,page}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"invalid-response"};}
}
