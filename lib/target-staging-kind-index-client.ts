/** R3-FE-3: typed read client for the dedicated global Projects / Notes
 * staging indexes (`project-index/global`, `note-index/global`). Each returns
 * one kind, so the list never picks rows out of a combined page.
 *
 * The strict DTO parsing, ordering, cursor-chain and lifecycle rules of the
 * combined-index client are reused unchanged: the dedicated response is first
 * checked for its exact envelope here, then adapted to the combined page shape
 * and handed to that parser. The server remains the only authority for actor,
 * Area ACL and cursors; nothing is persisted. */
import {createGlobalIndexReadSession} from "./target-staging-global-index-read-session";
import {boundedJson} from "./target-staging-global-index-client";

export type KindIndexKind="project"|"note";
const endpoints:Record<KindIndexKind,string>={
  project:"/api/target-staging/project-index/global",
  note:"/api/target-staging/note-index/global",
};
const listKey:Record<KindIndexKind,"projects"|"notes">={project:"projects",note:"notes"};
const COMBINED_PATH="/api/target-staging/global-index";

function sameKeys(value:Record<string,unknown>,expected:string[]):boolean{
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,i)=>key===wanted[i]);
}

/** A fetch that asks the dedicated endpoint and returns the combined envelope. */
export function kindIndexFetch(kind:KindIndexKind,fetchImpl:typeof fetch=fetch):typeof fetch{
  const key=listKey[kind];
  return (async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const text=String(input);
    if(!text.startsWith(COMBINED_PATH+"?"))throw new TypeError("unexpected request");
    const response=await fetchImpl(endpoints[kind]+text.slice(COMBINED_PATH.length),init);
    if(response.status!==200||response.redirected)return response;
    const headers=new Headers();
    for(const name of ["content-type","cache-control"]){
      const value=response.headers.get(name);
      if(value!==null)headers.set(name,value);
    }
    let adapted:unknown=null;
    try{
      // Bounded, strict UTF-8 read of the ORIGINAL body (never an unbounded parse).
      const raw:unknown=await boundedJson(response,init?.signal??undefined);
      if(raw!==null&&typeof raw==="object"&&!Array.isArray(raw)){
        const body=raw as Record<string,unknown>;
        if(sameKeys(body,[key,"scope","hasMore","nextCursor"])&&Array.isArray(body[key]))
          adapted={scope:body.scope,hasMore:body.hasMore,nextCursor:body.nextCursor,
            items:(body[key] as unknown[]).map(item=>({kind,item}))};
      }
    }catch(error){
      // Keep abort semantics: an aborted read rejects like an aborted fetch.
      if(init?.signal?.aborted)throw init.signal.reason??new DOMException("Aborted","AbortError");
      /* oversized / invalid UTF-8 / invalid JSON: handled as an invalid response below */
      void error;
    }
    // An unparsable or off-contract body becomes a body the strict parser refuses.
    return new Response(JSON.stringify(adapted),{status:200,headers});
  }) as typeof fetch;
}

/** Same ephemeral, generation-bound controller as the combined index, one kind. */
export function createKindIndexReadSession(
  kind:KindIndexKind,
  config:Parameters<typeof createGlobalIndexReadSession>[0],
  fetchImpl:typeof fetch=fetch,
){
  return createGlobalIndexReadSession(config,kindIndexFetch(kind,fetchImpl));
}
