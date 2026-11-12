"use client";
/** R3-FE-05: real server-authorized Search in the main shell, no legacy mixing.
 * No automatic query, prefetch, persistence or speculative detail opening. */
import {useEffect,useRef,useState} from "react";
import {useTargetGeneration,useTargetRuntime,useTargetSession} from "./target-data-provider";
import {useTargetScope} from "./target-scope-state";
import {useTargetGate} from "./use-target-gate";
import {queuedTargetFetch} from "../../lib/target-read-queue";
import {detailRowKey,focusPendingRow,openTargetDetail} from "./target-detail-state";
import {detailCopy} from "../../lib/target-detail-copy";
import type {TargetDetailGates,TargetDetailView} from "../../lib/target-detail-route";
import {validTitleSearchQuery,type TitleSearchFailure} from "../../lib/target-staging-title-search-client";
import {createStagingTitleSearchSession} from "../../lib/target-staging-title-search-session";
import {
  mainTitleSearchCopy,subscribeMainTitleSearchAclInvalidation,
  mainTitleSearchDetailRoute,rememberMainTitleSearchReturn,consumeMainTitleSearchReturn,
  visibleMainTitleSearchResult,TARGET_MAIN_SEARCH_SUBMIT_EVENT,
  type MainTitleSearchBinding,type BoundMainTitleSearch,type MainTitleSearchLanguage,
} from "../../lib/target-main-title-search-ui";
import "./target-main-title-search.css";

const readFetch=queuedTargetFetch();
function makeSession(){
  const core=createStagingTitleSearchSession(readFetch);
  return {...core,dispose:()=>core.reset(),suspend:()=>core.reset()};
}
type Session=ReturnType<typeof makeSession>;
function foregroundOnline():boolean{
  return typeof document!=="undefined"&&document.visibilityState!=="hidden"&&navigator.onLine;
}

export default function TargetMainTitleSearch({query,language="cs",details,detailViews}:{
  query:string;language?:MainTitleSearchLanguage;details:TargetDetailGates;
  detailViews:readonly TargetDetailView[];
}){
  const copy=mainTitleSearchCopy[language];
  const rowCopy=detailCopy[language];
  const scope=useTargetScope();
  const generation=useTargetGeneration();
  const runtime=useTargetRuntime();
  const {gate,onRefusal,retry}=useTargetGate();
  const session=useTargetSession(()=>makeSession(),[scope]);
  const sessionRef=useRef<Session|null>(session);
  sessionRef.current=session;
  const current:MainTitleSearchBinding={input:query,scope,generation};
  const bindingRef=useRef(current);
  bindingRef.current=current;
  const epoch=useRef(0);
  // An address navigation unmounts Search. Restore only the single-use, same-
  // identity in-memory result, never web storage or an automatic HTTP query.
  const fromReturn=useRef(false);
  const [result,setResult]=useState<BoundMainTitleSearch|null>(()=>{
    const value=consumeMainTitleSearchReturn(current,runtime);
    fromReturn.current=Boolean(value);
    return value;
  });
  const mounted=useRef(false);
  const returnSessionPending=useRef(fromReturn.current);
  const returnBinding=useRef(current);
  const statusRef=useRef<HTMLParagraphElement>(null);
  const submitRef=useRef<()=>void>(()=>{});

  // Query edits, navigation across Personal/Shared and auth rotation cannot
  // leave an older actor's data or a stale count on screen.
  useEffect(()=>{
    if(!mounted.current){mounted.current=true;return;}
    // useTargetSession is created in an effect, so the first null -> session
    // transition after a Back navigation is NOT a change of actor/scope/query.
    // Keep the one-use return rows through that transition only.
    if(returnSessionPending.current&&session&&
      returnBinding.current.input===query&&returnBinding.current.scope===scope&&
      returnBinding.current.generation===generation&&runtime?.lastOutcome()==="ok"){
      returnSessionPending.current=false;
      return;
    }
    returnSessionPending.current=false;
    ++epoch.current;
    fromReturn.current=false;
    session?.reset();
    setResult(null);
  },[session,query,scope,generation]);
  useEffect(()=>{
    const conceal=()=>{
      ++epoch.current;
      sessionRef.current?.reset();
      setResult(null);
    };
    const visibility=()=>{if(document.visibilityState==="hidden")conceal();};
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)conceal();};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("pagehide",conceal);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("blur",conceal);
    window.addEventListener("offline",conceal);
    if(!foregroundOnline())conceal();
    return ()=>{
      conceal();
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("pagehide",conceal);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("blur",conceal);
      window.removeEventListener("offline",conceal);
    };
  },[]);

  // A live Area membership change need not rotate the login generation.
  // A successful verification tick, OR a failed authentication revalidation,
  // discards all titles/counts, cancels pending work, and requires a NEW
  // explicit search after access has been successfully verified again.
  useEffect(()=>subscribeMainTitleSearchAclInvalidation(runtime,()=>{
    ++epoch.current;
    sessionRef.current?.reset();
    setResult(null);
  }),[runtime]);

  useEffect(()=>{
    const submit=()=>submitRef.current();
    window.addEventListener(TARGET_MAIN_SEARCH_SUBMIT_EVENT,submit);
    return ()=>window.removeEventListener(TARGET_MAIN_SEARCH_SUBMIT_EVENT,submit);
  },[]);

  // A failed 503/timeout poll retains the login generation in the runtime.
  // Its outcome must nevertheless block both rendering AND explicit submits
  // until a later successful re-verification (never auto-refetch titles).
  const verificationReady=runtime?.lastOutcome()==="ok";
  const allowed=gate.kind==="ready"&&verificationReady&&session!==null&&foregroundOnline();
  const shown=visibleMainTitleSearchResult(result,current,allowed);
  const snapshot=shown?.snapshot??null;
  const failure=shown?.failure??null;
  const busy=snapshot?.status==="loading";
  const ready=snapshot?.status==="ready"?snapshot:null;

  function stillCurrent(binding:MainTitleSearchBinding,run:number,active:Session):boolean{
    const now=bindingRef.current;
    return epoch.current===run&&sessionRef.current===active&&
      runtime?.lastOutcome()==="ok"&&foregroundOnline()&&
      now.input===binding.input&&now.scope===binding.scope&&now.generation===binding.generation;
  }
  function finish(active:Session,binding:MainTitleSearchBinding,run:number,
    outcome:{ok:true}|{ok:false;reason:TitleSearchFailure|"limit-reached"}){
    if(!stillCurrent(binding,run,active))return;
    const reason:TitleSearchFailure|null=outcome.ok===false
      ?(outcome.reason==="limit-reached"?"invalid-request":outcome.reason):null;
    setResult({binding,snapshot:active.getSnapshot(),failure:reason});
    if(reason==="signed-out")onRefusal();
  }
  function search(){
    if(!session||!allowed)return;
    const binding={...bindingRef.current};
    const input=query.trim();
    const run=++epoch.current;
    fromReturn.current=false;
    session.reset();
    if(!validTitleSearchQuery(input)){
      setResult({binding,snapshot:session.getSnapshot(),failure:"invalid-request"});
      return;
    }
    if(!foregroundOnline()){
      setResult(null);
      return;
    }
    const pending=session.first({query:input,scope,limit:25});
    setResult({binding,snapshot:session.getSnapshot(),failure:null});
    void pending.then(outcome=>finish(session,binding,run,outcome)).catch(()=>{
      if(stillCurrent(binding,run,session))
        setResult({binding,snapshot:session.getSnapshot(),failure:"unavailable"});
    });
  }
  // One explicit Enter from the topbar uses the same guarded path as the button.
  submitRef.current=search;
  function loadMore(){
    if(!session||!ready||!ready.hasMore||!foregroundOnline())return;
    // After navigation, a new session has no valid paging cursor. The user
    // explicitly starts a fresh server query before requesting another page.
    if(fromReturn.current){search();return;}
    statusRef.current?.focus();
    const binding={...bindingRef.current};
    const run=++epoch.current;
    const pending=session.next();
    // Hide ALL old titles while the next page rechecks current server ACL.
    setResult({binding,snapshot:session.getSnapshot(),failure:null});
    void pending.then(outcome=>finish(session,binding,run,outcome)).catch(()=>{
      if(stillCurrent(binding,run,session))
        setResult({binding,snapshot:session.getSnapshot(),failure:"unavailable"});
    });
  }

  // The detail closes back to Search. The originating keyed button has been
  // remounted by now, so it wins focus over the shell\x27s neutral heading fallback.
  useEffect(()=>{if(ready)focusPendingRow();},[ready]);

  return <section className="searchExplorer targetMainSearch" data-testid="target-main-title-search"
    aria-label={language==="cs"?"Autorizované hledání":"Authorized search"}>
    <p className="targetMainSearchIntro">{copy.intro}</p>
    <div className="targetMainSearchActions">
      <p>{copy.instruction}</p>
      <button type="button" onClick={search} disabled={!allowed||Boolean(busy)}>
        {copy.submit}
      </button>
    </div>
    {gate.kind!=="ready"&&<div className="searchState" role="status">
      <p>{gate.kind==="checking"?copy.verifying:copy.unavailable}</p>
      {gate.kind!=="checking"&&<button type="button" onClick={retry}>{copy.retry}</button>}
    </div>}
    {gate.kind==="ready"&&!foregroundOnline()&&
      <p role="status" className="searchState">{copy.offline}</p>}
    {gate.kind==="ready"&&!verificationReady&&foregroundOnline()&&
      <div className="searchState" role="status">
        <p>{copy.unavailable}</p>
        <button type="button" onClick={retry}>{copy.retry}</button>
      </div>}
    {gate.kind==="ready"&&verificationReady&&foregroundOnline()&&
      <p role="status" tabIndex={-1} ref={statusRef} className="searchSummary">
        {busy?copy.loading:ready?copy.count(ready.items.length):failure?"":copy.idle}
      </p>}
    {failure&&<p role="alert" className="targetMainSearchError">{copy.failures[failure]}</p>}
    {ready&&<section aria-label={language==="cs"?"Autorizované výsledky":"Authorized results"}>
      {ready.items.length===0?<p className="searchState" role="status">{copy.empty}</p>:
        <ul className="targetMainSearchItems">
          {ready.items.map(item=>{
            const route=mainTitleSearchDetailRoute(item,details,detailViews);
            const body=<>
              <span className="targetMainSearchGlyph" aria-hidden="true"/>
              <span className="targetMainSearchText">
                <strong>{item.title}</strong>
                <small>{copy[item.kind]} · {copy[item.areaKind==="private"?"personal":"shared"]}</small>
              </span>
            </>;
            const openLabel=item.kind==="project"?rowCopy.rowOpenProject(item.title):
              item.kind==="note"?rowCopy.rowOpenNote(item.title):rowCopy.planOpenTask(item.title);
            return <li key={item.kind+":"+item.id} className="targetMainSearchItem"
              data-kind={item.kind} data-area-kind={item.areaKind}>
              {route?<button type="button" className="targetMainSearchItemButton"
                data-detail-row={detailRowKey(item.kind,item.id)} aria-label={openLabel}
                onClick={event=>{
                  if(shown)rememberMainTitleSearchReturn(shown,current,runtime);
                  openTargetDetail(route,event.currentTarget);
                }}>{body}</button>
                :<span className="targetMainSearchRowContent">{body}</span>}
            </li>;
          })}
        </ul>}
      {ready.hasMore&&<button type="button" className="targetMainSearchMore"
        onClick={loadMore}>{copy.more}</button>}
      {ready.limitReached&&<p role="status">{copy.cap}</p>}
      <p className="targetMainSearchPrivacy">{copy.privacy}</p>
    </section>}
  </section>;
}
