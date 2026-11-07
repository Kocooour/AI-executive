/**
 * R2d.4e / BE-17 — inactive, in-memory staging title-search pagination.
 * The server, not this session, authorizes identities and Areas. No UI uses it.
 * Consumers MUST reset() on logout, actor/session switch and view teardown.
 */
import {
  loadStagingTitleSearchPage,
  type TitleSearchFailure,
  type TitleSearchItem,
  type TitleSearchScope,
} from "./target-staging-title-search-client";

export type TitleSearchSessionSnapshot = {
  status:"idle"|"loading"|"ready"|"error";
  query:string|null;
  scope:TitleSearchScope;
  limit:number;
  items:TitleSearchItem[];
  hasMore:boolean;
  nextCursor:string|null;
  failure:TitleSearchFailure|null;
};
export type TitleSearchSessionOutcome =
  | {ok:true}
  | {ok:false;reason:TitleSearchFailure};

const encoder=new TextEncoder();
const rank:Record<TitleSearchItem["kind"],number>={project:0,task:1,note:2};
const maxRetainedItems=1000;

function itemOrder(a:TitleSearchItem,b:TitleSearchItem):number{
  const left=encoder.encode(a.id),right=encoder.encode(b.id);
  for(let i=0;i<Math.min(left.length,right.length);i++){
    if(left[i]!==right[i])return left[i]<right[i]?-1:1;
  }
  if(left.length!==right.length)return left.length<right.length?-1:1;
  return rank[a.kind]-rank[b.kind];
}

const empty=():TitleSearchSessionSnapshot=>({
  status:"idle",query:null,scope:"all",limit:50,items:[],
  hasMore:false,nextCursor:null,failure:null,
});

/**
 * Explicit first/next calls only. Never retries, prefetches, caches or
 * silently restarts a stale HMAC cursor. Failed pages invalidate ALL results.
 */
export function createStagingTitleSearchSession(fetchImpl:typeof fetch=fetch){
  let state=empty();
  let generation=0;
  let running:AbortController|null=null;
  const seenCursors=new Set<string>();

  function snapshot():TitleSearchSessionSnapshot{
    // Do not hand out the mutable internal result buffer to consumers.
    return {...state,items:state.items.map(item=>({...item}))};
  }

  function invalidate(failure:TitleSearchFailure|null=null):void{
    state={...empty(),status:failure?"error":"idle",failure};
    seenCursors.clear();
  }

  function reset():void{
    generation++;
    running?.abort();
    running=null;
    invalidate();
  }

  async function execute(
    id:number,controller:AbortController,
    query:string,scope:TitleSearchScope,limit:number,cursor?:string,
    previous:TitleSearchItem[]=[],
  ):Promise<TitleSearchSessionOutcome>{
    const response=await loadStagingTitleSearchPage({
      query,scope,limit,cursor,signal:controller.signal,
    },fetchImpl);
    // An earlier in-flight response must never repopulate a reset or new query.
    if(id!==generation)return {ok:false,reason:"aborted"};
    running=null;
    if(!response.ok){
      invalidate(response.reason);
      return {ok:false,reason:response.reason};
    }
    const page=response.page;
    const first=page.items[0],last=previous[previous.length-1];
    // Each page is sorted by BE-16; enforce ordering ACROSS page boundaries.
    // Detect replayed/cyclic cursors and refuse unbounded in-memory results.
    if((first&&last&&itemOrder(last,first)>=0)||
      (cursor!==undefined&&seenCursors.has(cursor))||
      (page.nextCursor!==null&&seenCursors.has(page.nextCursor))||
      (cursor!==undefined&&page.nextCursor===cursor)||
      previous.length+page.items.length>maxRetainedItems){
      invalidate("invalid-response");
      return {ok:false,reason:"invalid-response"};
    }
    if(cursor!==undefined)seenCursors.add(cursor);
    state={
      status:"ready",query,scope,limit,
      items:[...previous,...page.items],
      hasMore:page.hasMore,nextCursor:page.nextCursor,failure:null,
    };
    return {ok:true};
  }

  function first(options:{
    query:string;scope?:TitleSearchScope;limit?:number;
  }):Promise<TitleSearchSessionOutcome>{
    const id=++generation;
    running?.abort();
    seenCursors.clear();
    const controller=new AbortController();
    running=controller;
    const scope=options.scope??"all",limit=options.limit??50;
    state={...empty(),status:"loading",query:options.query,scope,limit};
    return execute(id,controller,options.query,scope,limit);
  }

  function next():Promise<TitleSearchSessionOutcome>{
    if(state.status!=="ready"||!state.hasMore||
      state.nextCursor===null||running!==null)
      return Promise.resolve({ok:false,reason:"invalid-request"});
    const id=++generation;
    const controller=new AbortController();
    running=controller;
    const {query,scope,limit,nextCursor,items}=state;
    state={...state,status:"loading"};
    // A completed first page always has a query; no identity is passed in.
    return execute(id,controller,query!,scope,limit,nextCursor,items);
  }

  return {first,next,reset,getSnapshot:snapshot};
}
