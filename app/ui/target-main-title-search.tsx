"use client";
/** R3-FE-05: real server-authorized Search in the main shell, no legacy mixing.
 * No automatic query, prefetch, persistence or speculative detail opening. */
import {useEffect,useRef,useState} from "react";
import {useTargetGeneration,useTargetSession} from "./target-data-provider";
import {useTargetScope} from "./target-scope-state";
import {useTargetGate} from "./use-target-gate";
import {queuedTargetFetch} from "../../lib/target-read-queue";
import {validTitleSearchQuery,type TitleSearchFailure} from "../../lib/target-staging-title-search-client";
import {createStagingTitleSearchSession} from "../../lib/target-staging-title-search-session";
import {
  mainTitleSearchCopy,visibleMainTitleSearchResult,TARGET_MAIN_SEARCH_SUBMIT_EVENT,
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

export default function TargetMainTitleSearch({query,language="cs"}:{
  query:string;language?:MainTitleSearchLanguage;
}){
  const copy=mainTitleSearchCopy[language];
  const scope=useTargetScope();
  const generation=useTargetGeneration();
  const {gate,onRefusal,retry}=useTargetGate();
  const session=useTargetSession(()=>makeSession(),[scope]);
  const sessionRef=useRef<Session|null>(session);
  sessionRef.current=session;
  const current:MainTitleSearchBinding={input:query,scope,generation};
  const bindingRef=useRef(current);
  bindingRef.current=current;
  const epoch=useRef(0);
  const [result,setResult]=useState<BoundMainTitleSearch|null>(null);
  const statusRef=useRef<HTMLParagraphElement>(null);
  const submitRef=useRef<()=>void>(()=>{});

  // Query edits, navigation across Personal/Shared and auth rotation cannot
  // leave an older actor's data or a stale count on screen.
  useEffect(()=>{
    ++epoch.current;
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

  useEffect(()=>{
    const submit=()=>submitRef.current();
    window.addEventListener(TARGET_MAIN_SEARCH_SUBMIT_EVENT,submit);
    return ()=>window.removeEventListener(TARGET_MAIN_SEARCH_SUBMIT_EVENT,submit);
  },[]);

  const allowed=gate.kind==="ready"&&session!==null&&foregroundOnline();
  const shown=visibleMainTitleSearchResult(result,current,allowed);
  const snapshot=shown?.snapshot??null;
  const failure=shown?.failure??null;
  const busy=snapshot?.status==="loading";
  const ready=snapshot?.status==="ready"?snapshot:null;

  function stillCurrent(binding:MainTitleSearchBinding,run:number,active:Session):boolean{
    const now=bindingRef.current;
    return epoch.current===run&&sessionRef.current===active&&foregroundOnline()&&
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
    if(!session||gate.kind!=="ready")return;
    const binding={...bindingRef.current};
    const input=query.trim();
    const run=++epoch.current;
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
    {gate.kind==="ready"&&foregroundOnline()&&
      <p role="status" tabIndex={-1} ref={statusRef} className="searchSummary">
        {busy?copy.loading:ready?copy.count(ready.items.length):failure?"":copy.idle}
      </p>}
    {failure&&<p role="alert" className="targetMainSearchError">{copy.failures[failure]}</p>}
    {ready&&<section aria-label={language==="cs"?"Autorizované výsledky":"Authorized results"}>
      {ready.items.length===0?<p className="searchState" role="status">{copy.empty}</p>:
        <ul className="targetMainSearchItems">
          {ready.items.map(item=><li key={item.kind+":"+item.id} className="targetMainSearchItem"
            data-kind={item.kind} data-area-kind={item.areaKind}>
            <span className="targetMainSearchGlyph" aria-hidden="true"/>
            <span className="targetMainSearchText">
              <strong>{item.title}</strong>
              <small>{copy[item.kind]} · {copy[item.areaKind==="private"?"personal":"shared"]}</small>
            </span>
          </li>)}
        </ul>}
      {ready.hasMore&&<button type="button" className="targetMainSearchMore"
        onClick={loadMore}>{copy.more}</button>}
      {ready.limitReached&&<p role="status">{copy.cap}</p>}
      <p className="targetMainSearchPrivacy">{copy.privacy}</p>
    </section>}
  </section>;
}
