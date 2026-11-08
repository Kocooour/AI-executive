/** R2d.5e: opt-in, ephemeral, identity-bound in-memory Attention controller.
 * Complements target-staging-attention-client (transport) the way BE-18/19
 * complement BE-16/17: explicit loadFirst/loadMore, contextVersion binding with
 * terminal A->B->A, copy-out snapshots, suspend/resume wipe, dispose.
 *
 * CACHE INVALIDATION: the loaded list is derived from server state and is never
 * patched optimistically. act() wipes every loaded page and cursor when it
 * starts and ends in `invalidated` for every outcome; only an explicit
 * loadFirst()/reload() shows data again. A page whose attentionEpoch differs from
 * the one the chain was read with also invalidates it (another tab/device acted).
 * No persistence APIs are used. The UI must drop its own copies of any item it
 * received whenever the snapshot is not `ready`. */
import {
  appendAttentionPage,fetchAttentionCommandPreview,fetchAttentionCommandReceipt,
  fetchAttentionPage,sendAttentionCommand,validAttentionTimeZone,
  type AttentionAction,type AttentionAreaFilter,type AttentionCommand,
  type AttentionFailure,type AttentionItem,type AttentionPage,type AttentionView,
} from "./target-staging-attention-client";

export type AttentionSessionReadFailure=Exclude<AttentionFailure,"uncertain"|"conflict">;
export type AttentionSessionNotReady="superseded"|"busy"|"not-ready"|"stale";
export type AttentionSessionPage={
  items:AttentionItem[];hasMore:boolean;evaluatedAtMs:number;
  evaluationDate:string;soonThroughDate:string|null;
};
export type AttentionSessionReadResult=
  |{ok:true;page:AttentionSessionPage}
  |{ok:false;reason:AttentionSessionReadFailure|AttentionSessionNotReady|"invalidated"};
export type AttentionSessionSnapshot=
  |{status:"idle"|"loading"|"acting"|"suspended"|"invalidated"|"disposed"}
  |{status:"ready";page:AttentionSessionPage}
  |{status:"failed";reason:AttentionSessionReadFailure};
export type AttentionActOutcome=
  |{outcome:"committed";replayed:boolean}
  |{outcome:"rejected";
    reason:"unauthorized"|"stale"|"conflict"|"not_found"|"invalid"|"unavailable"|"aborted"|"invalid_response"}
  |{outcome:"uncertain";receipt:"committed"|"not_recorded"|"unknown"};
export type AttentionActResult=
  |({ok:true}&AttentionActOutcome)
  |{ok:false;reason:"busy"|"not-ready"|"stale"|"superseded"|"invalid-request"|"unknown-item"};

type Chain={
  page:AttentionPage;issuedCursors:readonly string[];
};

function detachItem(item:AttentionItem):AttentionItem{return {...item};}
function detach(page:AttentionPage):AttentionSessionPage{
  return {items:page.items.map(detachItem),hasMore:page.hasMore,
    evaluatedAtMs:page.evaluatedAtMs,evaluationDate:page.evaluationDate,
    soonThroughDate:page.soonThroughDate};
}

/** contextVersion is a NON-SECRET auth-generation (login/logout/account swap).
 * It is only a client response-lifecycle guard; the server authorizes every call. */
export function createAttentionSession(
  config:{areaFilter:AttentionAreaFilter;view:AttentionView;timeZone:string;
    limit:number;contextVersion:()=>string;fetch?:typeof fetch},
){
  const fetchImpl:typeof fetch=config.fetch??((input,init)=>fetch(input,init));
  const {areaFilter,view,timeZone,limit}=config;
  const valid=()=>{
    try{
      const value=config.contextVersion();
      return typeof value==="string"&&value.length>0&&value.length<=256?value:null;
    }catch{return null;}
  };
  const pinned=valid();
  const validParams=["all","personal","shared"].includes(areaFilter)&&
    ["active","hidden"].includes(view)&&validAttentionTimeZone(timeZone)&&
    Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&pinned!==null;
  let revision=0;
  // Observed auth-generation mismatch is terminal, even for A -> B -> A.
  let invalidatedContext=false;
  let active:AbortController|null=null;
  let chain:Chain|null=null;
  let status:"idle"|"loading"|"acting"|"ready"|"failed"|"suspended"|
    "invalidated"|"disposed"=validParams?"idle":"failed";
  let failure:AttentionSessionReadFailure="invalid";

  const clear=()=>{chain=null;active?.abort();active=null;};
  const guard=():boolean=>{
    if(status==="disposed"||!validParams||invalidatedContext)return false;
    if(valid()!==pinned){
      invalidatedContext=true;revision++;clear();
      status="failed";failure="stale";
      return false;
    }
    return true;
  };
  const getSnapshot=():AttentionSessionSnapshot=>{
    guard();
    if(status==="ready")
      return chain?{status:"ready",page:detach(chain.page)}
        :{status:"failed",reason:"invalid_response"};
    if(status==="failed")return {status,reason:failure};
    return {status};
  };
  const suspend=():void=>{
    if(status==="disposed"||!guard())return;
    revision++;clear();status="suspended";
  };
  const resume=():boolean=>{
    if(status==="disposed"||!guard())return false;
    revision++;clear();status="idle";
    return true;
  };
  const dispose=()=>{revision++;clear();status="disposed";};
  /** Drop every page and cursor; an explicit load is the only way back. */
  const invalidate=()=>{chain=null;status="invalidated";};

  const request=async(cursor?:string):Promise<AttentionSessionReadResult>=>{
    const previous=cursor===undefined?null:chain;
    const ticket=++revision;
    active?.abort();
    chain=null;
    const controller=new AbortController();
    active=controller;
    status="loading";
    const result=await fetchAttentionPage({
      areaFilter,view,timeZone,limit,
      ...(cursor===undefined?{}:{cursor}),signal:controller.signal,
    },fetchImpl);
    if(ticket!==revision)return {ok:false,reason:"superseded"};
    if(!guard())return {ok:false,reason:"stale"};
    active=null;
    if(result.status!=="ok"){
      status="failed";failure=result.status;
      return {ok:false,reason:result.status};
    }
    const page=result.page;
    if(previous===null){
      chain={page,issuedCursors:page.nextCursor?[page.nextCursor]:[]};
      status="ready";
      return {ok:true,page:detach(page)};
    }
    // Another tab/device changed attention state while this list was open.
    if(page.attentionEpoch!==previous.page.attentionEpoch){
      invalidate();
      return {ok:false,reason:"invalidated"};
    }
    const combined=previous.page.nextCursor===cursor&&
      previous.issuedCursors.includes(cursor as string)&&
      !(page.nextCursor!==null&&previous.issuedCursors.includes(page.nextCursor))
      ?appendAttentionPage(previous.page,page):null;
    if(!combined){
      status="failed";failure="invalid_response";
      return {ok:false,reason:failure};
    }
    chain={page:combined,issuedCursors:page.nextCursor
      ?[...previous.issuedCursors,page.nextCursor]:[...previous.issuedCursors]};
    status="ready";
    return {ok:true,page:detach(combined)};
  };
  const loadFirst=async():Promise<AttentionSessionReadResult>=>{
    if(status==="disposed")return {ok:false,reason:"aborted"};
    if(!validParams)return {ok:false,reason:"invalid"};
    if(!guard())return {ok:false,reason:"stale"};
    if(status==="suspended")return {ok:false,reason:"not-ready"};
    if(status==="acting")return {ok:false,reason:"busy"};
    return request();
  };
  /** Same as loadFirst: a reload is never a refresh of old cursors. */
  const reload=loadFirst;
  const loadMore=async():Promise<AttentionSessionReadResult>=>{
    if(status==="disposed")return {ok:false,reason:"aborted"};
    if(!validParams)return {ok:false,reason:"invalid"};
    if(!guard())return {ok:false,reason:"stale"};
    if(status==="suspended")return {ok:false,reason:"not-ready"};
    if(status==="loading"||status==="acting")return {ok:false,reason:"busy"};
    if(status!=="ready"||!chain)return {ok:false,reason:"not-ready"};
    if(!chain.page.hasMore)return {ok:true,page:detach(chain.page)};
    if(!chain.page.nextCursor){
      chain=null;status="failed";failure="invalid_response";
      return {ok:false,reason:failure};
    }
    return request(chain.page.nextCursor);
  };

  /** preview -> single PATCH -> (receipt if uncertain). The command is built
   * ONLY from the server preview, this session's own copy of the loaded item
   * (looked up by attentionKey; caller fields are ignored), the session
   * timeZone and a fresh commandId. All loaded data is dropped before the first
   * request, so no stale list is visible while the outcome is unknown. */
  const act=async(
    item:Pick<AttentionItem,"attentionKey">,action:AttentionAction,
    snoozedUntilMs?:number,
  ):Promise<AttentionActResult>=>{
    if(status==="disposed")return {ok:false,reason:"superseded"};
    if(!validParams||!guard())return {ok:false,reason:"stale"};
    if(status==="suspended")return {ok:false,reason:"not-ready"};
    if(status==="loading"||status==="acting")return {ok:false,reason:"busy"};
    if(status!=="ready"||!chain)return {ok:false,reason:"not-ready"};
    if(!["snooze","dismiss","restore"].includes(action)||
      (action==="snooze"
        ?!(typeof snoozedUntilMs==="number"&&Number.isSafeInteger(snoozedUntilMs)&&
          snoozedUntilMs>0)
        :snoozedUntilMs!==undefined))return {ok:false,reason:"invalid-request"};
    const key=item?.attentionKey;
    const loaded=typeof key==="string"
      ?chain.page.items.find(i=>i.attentionKey===key):undefined;
    if(!loaded)return {ok:false,reason:"unknown-item"};
    const own=detachItem(loaded);
    const loadedEpoch=chain.page.attentionEpoch;
    const ticket=++revision;
    active?.abort();
    const controller=new AbortController();
    active=controller;
    chain=null;
    status="acting";
    let sent=false;
    // After the PATCH left, a superseded act has an unknown outcome and the
    // receipt must not be asked under a possibly different identity.
    const gone=():AttentionActResult|null=>{
      if(ticket!==revision||status==="disposed")
        return sent?{ok:true,outcome:"uncertain",receipt:"unknown"}
          :{ok:false,reason:"superseded"};
      if(!guard())
        return sent?{ok:true,outcome:"uncertain",receipt:"unknown"}
          :{ok:false,reason:"stale"};
      return null;
    };
    const finish=(outcome:AttentionActOutcome):AttentionActResult=>{
      active=null;invalidate();
      return {ok:true,...outcome};
    };
    const preview=await fetchAttentionCommandPreview({
      taskId:own.taskId,ruleId:own.ruleId,occurrenceOn:own.relevantOn,
      signal:controller.signal,
    },fetchImpl);
    let early=gone();if(early)return early;
    if(preview.status!=="ok")
      return finish({outcome:"rejected",reason:preview.status});
    const p=preview.preview;
    // Another tab/device acted, or the row moved: do not send a doomed command.
    if(p.expectedAttentionEpoch!==loadedEpoch||p.lifecycle!==own.lifecycle||
      p.expectedStateRevision!==own.lifecycleRevision)
      return finish({outcome:"rejected",reason:"stale"});
    if((action==="restore")===(p.lifecycle==="active"))
      return finish({outcome:"rejected",reason:"conflict"});
    // Without a secure-context UUID source no command can be built: end the
    // flow cleanly (invalidated) instead of wedging the session in "acting".
    let commandId:string;
    try{commandId=globalThis.crypto.randomUUID();}
    catch{return finish({outcome:"rejected",reason:"unavailable"});}
    if(typeof commandId!=="string")return finish({outcome:"rejected",reason:"unavailable"});
    const command:AttentionCommand={
      commandId,taskId:own.taskId,ruleId:own.ruleId,
      occurrenceOn:own.relevantOn,action,
      snoozedUntilMs:action==="snooze"?snoozedUntilMs as number:null,
      expectedRevision:p.expectedRevision,
      expectedAttentionEpoch:p.expectedAttentionEpoch,
      expectedStateRevision:p.expectedStateRevision,
      writeAreaId:p.writeAreaId,restoreGeneration:p.restoreGeneration,timeZone,
    };
    sent=true;
    const sentResult=await sendAttentionCommand(command,controller.signal,fetchImpl);
    // A 400 (or a local refusal) is definitive: nothing was committed.
    if(sentResult.status==="invalid")sent=false;
    early=gone();if(early)return early;
    if(sentResult.status==="ok")
      return finish({outcome:"committed",replayed:sentResult.replayed});
    if(sentResult.status!=="uncertain")
      return finish({outcome:"rejected",reason:sentResult.status});
    const receipt=await fetchAttentionCommandReceipt(command,controller.signal,fetchImpl);
    early=gone();if(early)return early;
    return finish({outcome:"uncertain",
      receipt:receipt.status==="ok"?receipt.receipt:"unknown"});
  };
  return {getSnapshot,loadFirst,loadMore,reload,act,suspend,resume,dispose};
}
