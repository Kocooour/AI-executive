/**
 * R2d.4d / BE-16 — inactive staging-only title search client transport.
 * The server exclusively authorizes the actor and every Area. A parsed client
 * response is display data, never proof of ACL. No UI imports this yet.
 */
export type TitleSearchScope="all"|"personal"|"shared";
export type TitleSearchKind="project"|"task"|"note";
export type TitleSearchItem={
  kind:TitleSearchKind;id:string;title:string;
  areaId:string;areaKind:"private"|"shared";projectId?:string|null;
};
export type TitleSearchPage={
  query:string;scope:TitleSearchScope;items:TitleSearchItem[];
  hasMore:boolean;nextCursor:string|null;
};
export type TitleSearchFailure="invalid-request"|"signed-out"|"stale"|
  "disabled"|"rate-limited"|"unavailable"|"offline"|"aborted"|"invalid-response";
export type TitleSearchResult=
  |{ok:true;page:TitleSearchPage}
  |{ok:false;reason:TitleSearchFailure};

const endpoint="/api/target-staging/title-search";
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const control=/[\u0000-\u001f\u007f]/u;
const scopes=["all","personal","shared"];
const itemKinds=["project","task","note"];
const typeRank:Record<TitleSearchKind,number>={project:0,task:1,note:2};
const encoder=new TextEncoder();
const record=(v:unknown):v is Record<string,unknown>=>
  v!==null&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,fields:readonly string[]):boolean=>
  Object.keys(v).sort().join("|")===fields.slice().sort().join("|");
const wellFormed=(s:string):boolean=>{
  // Reject unpaired surrogate code units rather than replacing them silently.
  try{return decodeURIComponent(encodeURIComponent(s))===s;}catch{return false;}
};
function validId(v:unknown):v is string{
  return typeof v==="string"&&v.length>0&&v!=="."&&v!==".."&&
    !control.test(v)&&wellFormed(v)&&encoder.encode(v).length<=512;
}
function validTitle(v:unknown):v is string{
  return typeof v==="string"&&v.trim().length>0&&
    wellFormed(v)&&encoder.encode(v).length<=4096;
}
export function validTitleSearchQuery(v:unknown):v is string{
  return typeof v==="string"&&v.length>=2&&v.length<=80&&
    v.trim()===v&&!control.test(v)&&wellFormed(v)&&
    encoder.encode(v).length<=256&&v.split(/\s+/u).length<=8;
}
const validCursor=(v:unknown):v is string=>
  typeof v==="string"&&v.length<=4096&&cursorPattern.test(v);
const validScope=(v:unknown):v is TitleSearchScope=>
  typeof v==="string"&&scopes.includes(v);
function byteCompare(a:string,b:string):number{
  const x=encoder.encode(a),y=encoder.encode(b);
  for(let i=0;i<Math.min(x.length,y.length);i++){
    if(x[i]!==y[i])return x[i]<y[i]?-1:1;
  }
  return Math.sign(x.length-y.length);
}
function validItem(v:unknown,scope:TitleSearchScope):v is TitleSearchItem{
  if(!record(v)||!itemKinds.includes(v.kind as string)||!validId(v.id)||
    !validId(v.areaId)||!validTitle(v.title)||
    (v.areaKind!=="private"&&v.areaKind!=="shared")||
    (scope==="personal"&&v.areaKind!=="private")||
    (scope==="shared"&&v.areaKind!=="shared"))return false;
  if(v.kind==="project")
    return exact(v,["kind","id","title","areaId","areaKind"]);
  return exact(v,["kind","id","title","areaId","areaKind","projectId"])&&
    (v.projectId===null||validId(v.projectId));
}
export function parseTitleSearchPage(
  value:unknown,expected:{query:string;scope:TitleSearchScope;limit:number},
):TitleSearchPage|null{
  if(!record(value)||!exact(value,
    ["query","scope","items","hasMore","nextCursor"])||
    value.query!==expected.query||value.scope!==expected.scope||
    !Array.isArray(value.items)||value.items.length>expected.limit||
    typeof value.hasMore!=="boolean"||
    (value.hasMore?(value.items.length!==expected.limit||
      !validCursor(value.nextCursor)):value.nextCursor!==null))return null;
  const items:TitleSearchItem[]=[];
  for(const item of value.items){
    if(!validItem(item,expected.scope))return null;
    const last=items[items.length-1];
    if(last){
      const order=byteCompare(last.id,item.id);
      if(order>0||(order===0&&
        typeRank[last.kind]>=typeRank[item.kind]))return null;
    }
    items.push(item);
  }
  return {query:expected.query,scope:expected.scope,items,
    hasMore:value.hasMore,nextCursor:value.nextCursor as string|null};
}
function reasonForStatus(status:number):TitleSearchFailure{
  if(status===401||status===403)return "signed-out";
  if(status===409)return "stale";
  if(status===404)return "disabled";
  if(status===400)return "invalid-request";
  if(status===429)return "rate-limited";
  return "unavailable";
}
/**
 * One explicit page, no automatic retry. A stale (409) continuation requires
 * restarting from the first page and replacing, not appending, prior results.
 * 401/403 invalidates the visible search state in the consuming UI.
 */
export async function loadStagingTitleSearchPage(
  options:{query:string;scope?:TitleSearchScope;limit?:number;
    cursor?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=fetch,
):Promise<TitleSearchResult>{
  const scope=options.scope??"all",limit=options.limit??50;
  if(!validTitleSearchQuery(options.query)||!validScope(scope)||
    !Number.isSafeInteger(limit)||limit<1||limit>50||
    (options.cursor!==undefined&&!validCursor(options.cursor)))
    return {ok:false,reason:"invalid-request"};
  if(options.signal?.aborted)return {ok:false,reason:"aborted"};
  const params=new URLSearchParams({q:options.query,scope,limit:String(limit)});
  if(options.cursor!==undefined)params.set("cursor",options.cursor);
  let response:Response;
  try{
    response=await fetchImpl(endpoint+"?"+params.toString(),{
      method:"GET",credentials:"same-origin",cache:"no-store",
      redirect:"error",headers:{accept:"application/json"},
      signal:options.signal,
    });
  }catch{return {ok:false,reason:options.signal?.aborted?"aborted":"offline"};}
  if(options.signal?.aborted)return {ok:false,reason:"aborted"};
  if(response.status!==200)return {ok:false,reason:reasonForStatus(response.status)};
  if(response.redirected||
    response.headers.get("cache-control")?.toLowerCase().includes("no-store")!==true||
    response.headers.get("content-type")?.toLowerCase().includes("application/json")!==true)
    return {ok:false,reason:"invalid-response"};
  try{
    const payload:unknown=await response.json();
    if(options.signal?.aborted)return {ok:false,reason:"aborted"};
    const page=parseTitleSearchPage(payload,{query:options.query,scope,limit});
    return page?{ok:true,page}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:options.signal?.aborted?"aborted":"invalid-response"};}
}
