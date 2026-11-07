/** R3 / BE-18: opt-in, ephemeral controller for explicitly requested global-index
 * reads. Complements BE-16/17 transport and cursor chain; does not replace
 * server actor/Area ACL or bind the production UI. Never persist this object. */
import {
  advanceGlobalIndexPageChain,beginGlobalIndexPageChain,fetchGlobalIndexPage,
  type GlobalIndexFailure,type GlobalIndexItem,type GlobalIndexPage,
  type GlobalIndexPageChain,
  type GlobalIndexScope,
} from "./target-staging-global-index-client";

export type GlobalIndexReadSessionResult=
  |{ok:true;page:GlobalIndexPage}
  |{ok:false;reason:GlobalIndexFailure|"superseded"|"busy"|"not-ready"};

/** Never expose the internal chain's mutable row references. */
function detachItem(entry:GlobalIndexItem):GlobalIndexItem{
  if(entry.kind==="project")
    return{kind:"project",item:{...entry.item}};
  if(entry.kind==="task")
    return{kind:"task",item:{...entry.item}};
  return{kind:"note",item:{...entry.item}};
}
function detachPage(page:GlobalIndexPage):GlobalIndexPage{
  return {...page,items:page.items.map(detachItem)};
}

export type GlobalIndexReadSessionSnapshot=
  |{status:"idle"|"loading"|"disposed"}
  |{status:"ready";page:GlobalIndexPage}
  |{status:"failed";reason:GlobalIndexFailure};

/** contextVersion is a NON-SECRET, monotonic app-auth/session epoch. Advance it
 * on login, logout, account swap or scope-auth invalidation. This is only a
 * client response-lifecycle guard; actual permissions are server-authorized.
 * Call dispose() and discard all previously rendered references on teardown. */
export function createGlobalIndexReadSession(
  config:{
    scope:GlobalIndexScope;
    limit?:number;
    contextVersion:()=>string;
  },
  fetchImpl:typeof fetch=fetch,
){
  const limit=config.limit??50;
  const valid=()=>{
    try{
      const value=config.contextVersion();
      return typeof value==="string"&&value.length>0&&value.length<=256
        ?value:null;
    }catch{return null;}
  };
  const pinned=valid();
  const params={scope:config.scope,limit};
  const validParams=["all","personal","shared"].includes(params.scope)&&
    Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&pinned!==null;
  let revision=0;
  // An observed auth-generation mismatch is terminal even if a buggy
  // caller later reuses the earlier value (A -> B -> A).
  let invalidated=false;
  let active:AbortController|null=null;
  let chain:GlobalIndexPageChain|null=null;
  let status:"idle"|"loading"|"ready"|"failed"|"disposed"=
    validParams?"idle":"failed";
  let failure:GlobalIndexFailure="invalid-request";

  const clear=()=>{
    chain=null;
    active?.abort();
    active=null;
  };
  const guard=():boolean=>{
    if(status==="disposed")return false;
    if(!validParams||invalidated)return false;
    if(valid()!==pinned){
      invalidated=true;
      revision++;
      clear();
      status="failed";
      failure="stale";
      return false;
    }
    return true;
  };
  const getSnapshot=():GlobalIndexReadSessionSnapshot=>{
    guard();
    if(status==="ready")
      return chain?{status:"ready",page:detachPage(chain.page)}
        :{status:"failed",reason:"invalid-response"};
    if(status==="failed")return{status,reason:failure};
    return{status};
  };
  const dispose=()=>{
    revision++;
    clear();
    status="disposed";
  };
  const request=async(cursor?:string):Promise<GlobalIndexReadSessionResult>=>{
    const previous=cursor===undefined?null:chain;
    const ticket=++revision;
    active?.abort();
    chain=null;
    const controller=new AbortController();
    active=controller;
    status="loading";
    const result=await fetchGlobalIndexPage(
      {...params,...(cursor===undefined?{}:{cursor}),signal:controller.signal},
      fetchImpl,
    );
    // Do not let a stale, aborted, or disposed request return another
    // generation's title list to the caller or overwrite current state.
    if(ticket!==revision)
      return{ok:false,reason:"superseded"};
    if(!guard())return{ok:false,reason:"stale"};
    active=null;
    if(result.ok===false){
      status="failed";
      failure=result.reason;
      return result;
    }
    const next=previous===null
      ?beginGlobalIndexPageChain(result,params)
      :advanceGlobalIndexPageChain(previous,cursor!,result);
    if(!next){
      status="failed";
      failure="invalid-response";
      return{ok:false,reason:failure};
    }
    chain=next;
    status="ready";
    return{ok:true,page:detachPage(next.page)};
  };
  const loadFirst=async():Promise<GlobalIndexReadSessionResult>=>{
    if(status==="disposed")return{ok:false,reason:"aborted"};
    if(!validParams)return{ok:false,reason:"invalid-request"};
    if(!guard())return{ok:false,reason:"stale"};
    return request();
  };
  const loadMore=async():Promise<GlobalIndexReadSessionResult>=>{
    if(status==="disposed")return{ok:false,reason:"aborted"};
    if(!validParams)return{ok:false,reason:"invalid-request"};
    if(!guard())return{ok:false,reason:"stale"};
    if(status==="loading")return{ok:false,reason:"busy"};
    if(status!=="ready"||!chain)return{ok:false,reason:"not-ready"};
    if(!chain.page.hasMore)return{ok:true,page:detachPage(chain.page)};
    if(!chain.page.nextCursor){
      chain=null;status="failed";failure="invalid-response";
      return{ok:false,reason:failure};
    }
    return request(chain.page.nextCursor);
  };
  return{getSnapshot,loadFirst,loadMore,dispose};
}
