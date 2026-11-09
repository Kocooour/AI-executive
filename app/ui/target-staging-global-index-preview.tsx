"use client";

/** UI-09a: read-only global index preview isolated from legacy Lumi and Můj plán.
 * The server authorizes every page; no writes, offline queue or storage. */
import {useEffect,useRef,useState} from "react";
import {
  appendGlobalIndexPage,fetchGlobalIndexPage,
  type GlobalIndexFailure,type GlobalIndexItem,type GlobalIndexPage,type GlobalIndexScope,
} from "../../lib/target-staging-global-index-client";
import {
  consumeGlobalIndexWake,initialGlobalIndexWakeGate,invalidateGlobalIndexWakeGate,
} from "../../lib/target-staging-global-index-lifecycle";
import {stagingIndexDetailHref} from "../../lib/target-staging-index-detail-links";

type ReadState={status:"loading"}|{status:"error";reason:GlobalIndexFailure}|
  {status:"ready";page:GlobalIndexPage};
const scopeLabels:Record<GlobalIndexScope,string>={
  all:"Vše",personal:"Osobní",shared:"Sdílené",
};
const kindLabels:Record<GlobalIndexItem["kind"],string>={
  project:"Projekt",task:"Úkol",note:"Poznámka",
};
const failures:Record<GlobalIndexFailure,string>={
  "signed-out":"Přihlášení nebo přístup zanikl. Staré údaje byly skryty.",
  "stale":"Obsah nebo oprávnění se změnily. Obnovte autorizovaný přehled.",
  "invalid-request":"Neplatný filtr nebo požadavek.",
  "invalid-response":"Odpověď neprošla validací. Obsah nebyl zobrazen.",
  "unavailable":"Bezpečný stagingový index není dostupný nebo je vypnutý.",
  "offline":"Připojení selhalo. Staré údaje nejsou zobrazeny.",
  "aborted":"Načítání bylo přerušeno. Přehled je nutné znovu ověřit.",
};

export function TargetStagingGlobalIndexPreview({
  projectDetailEnabled=false,noteDetailEnabled=false,taskDetailEnabled=false,
}:{projectDetailEnabled?:boolean;noteDetailEnabled?:boolean;taskDetailEnabled?:boolean}){
  const [scope,setScope]=useState<GlobalIndexScope>("all");
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<ReadState>({status:"loading"});
  const [moreBusy,setMoreBusy]=useState(false);
  const requestSequence=useRef(0);
  const current=useRef<AbortController|null>(null);
  const moreInFlight=useRef(false);
  // Persistent keyboard / VoiceOver focus target while server reauthorizes
  // each page. The result list and its Load more button are hidden until then.
  const resultStatusRef=useRef<HTMLParagraphElement>(null);
  const wakeGate=useRef(initialGlobalIndexWakeGate());

  function invalidate(reason:GlobalIndexFailure,loading=false){
    requestSequence.current++;
    current.current?.abort();
    current.current=null;
    moreInFlight.current=false;
    setMoreBusy(false);
    setState(loading?{status:"loading"}:{status:"error",reason});
  }

  useEffect(()=>{
    const id=++requestSequence.current;
    current.current?.abort();
    const controller=new AbortController();
    current.current=controller;
    moreInFlight.current=false;
    setMoreBusy(false);
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setState({status:"error",reason:navigator.onLine?"stale":"offline"});
      return ()=>{requestSequence.current++;controller.abort();};
    }
    setState({status:"loading"});
    void fetchGlobalIndexPage({scope,signal:controller.signal}).then(result=>{
      if(controller.signal.aborted||requestSequence.current!==id)return;
      if(result.ok===true)setState({status:"ready",page:result.page});
      else setState({status:"error",reason:result.reason});
    }).catch(()=>{
      if(!controller.signal.aborted&&requestSequence.current===id)
        setState({status:"error",reason:"unavailable"});
    });
    return ()=>{requestSequence.current++;controller.abort();};
  },[scope,refresh]);

  useEffect(()=>{
    wakeGate.current=consumeGlobalIndexWake(wakeGate.current,Date.now(),true).gate;
    const hide=(reason:GlobalIndexFailure="stale")=>{
      wakeGate.current=invalidateGlobalIndexWakeGate(wakeGate.current);
      invalidate(reason);
    };
    const wake=(force=false)=>{
      if(document.visibilityState==="hidden"||!navigator.onLine)return;
      const choice=consumeGlobalIndexWake(wakeGate.current,Date.now(),force);
      wakeGate.current=choice.gate;
      if(choice.reload){
        invalidate("stale",true);
        setRefresh(value=>value+1);
      }
    };
    const visibility=()=>document.visibilityState==="hidden"?hide():wake();
    const offline=()=>hide("offline");
    const online=()=>wake(true);
    const pagehide=()=>hide();
    const pageshow=(event:PageTransitionEvent)=>wake(event.persisted);
    const foreground=()=>wake();
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("offline",offline);
    window.addEventListener("online",online);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("focus",foreground);
    if(document.visibilityState==="hidden"||!navigator.onLine)
      hide(navigator.onLine?"stale":"offline");
    return ()=>{
      requestSequence.current++;
      current.current?.abort();
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",online);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("focus",foreground);
    };
  },[]);

  function selectScope(next:GlobalIndexScope){
    if(next===scope)return;
    invalidate("stale",true);
    wakeGate.current=consumeGlobalIndexWake(wakeGate.current,Date.now(),true).gate;
    setScope(next);
  }
  function reload(){
    if(document.visibilityState==="hidden"||!navigator.onLine){
      invalidate(navigator.onLine?"stale":"offline");
      return;
    }
    invalidate("stale",true);
    wakeGate.current=consumeGlobalIndexWake(wakeGate.current,Date.now(),true).gate;
    setRefresh(value=>value+1);
  }
  async function loadMore(){
    if(state.status!=="ready"||state.page.scope!==scope||
      !state.page.hasMore||!state.page.nextCursor||
      moreInFlight.current||document.visibilityState==="hidden"||
      !navigator.onLine)return;
    // The focused paging button will unmount when old private titles hide.
    // Rehome focus before updating React state; do not abandon keyboard users.
    resultStatusRef.current?.focus();
    moreInFlight.current=true;
    const previous=state.page;
    const id=++requestSequence.current;
    current.current?.abort();
    const controller=new AbortController();
    current.current=controller;
    setMoreBusy(true);
    // No previously authorized titles remain visible during the new check.
    setState({status:"loading"});
    const result=await fetchGlobalIndexPage({
      scope,cursor:previous.nextCursor,signal:controller.signal,
    });
    if(controller.signal.aborted||requestSequence.current!==id)return;
    moreInFlight.current=false;
    setMoreBusy(false);
    if(result.ok===false){setState({status:"error",reason:result.reason});return;}
    const combined=appendGlobalIndexPage(previous,result.page);
    setState(combined?{status:"ready",page:combined}:
      {status:"error",reason:"invalid-response"});
  }

  const ready=state.status==="ready"&&state.page.scope===scope?state.page:null;
  return <main className="stagingGlobalIndex">
    <header>
      <p className="stagingGlobalEyebrow">Lumi · izolovaný staging · pouze čtení</p>
      <h1>Pracovní přehled</h1>
      <p>Obsahuje jen položky, které aktuální uživatel smí číst.
        <strong> Vše není Můj plán.</strong> Tento náhled není běžná aplikace.</p>
    </header>
    <nav className="stagingGlobalScopes" aria-label="Rozsah pracovního přehledu">
      {(["all","personal","shared"] as const).map(value=>
        <button key={value} type="button" aria-pressed={scope===value}
          onClick={()=>selectScope(value)}>{scopeLabels[value]}</button>)}
    </nav>
    <div className="stagingGlobalActions">
      <button type="button" onClick={reload}>Znovu ověřit a načíst</button>
    </div>
    <p ref={resultStatusRef} role="status" tabIndex={-1}
      className="stagingGlobalResultStatus">
      {state.status==="loading"?"Načítám autorizovaný přehled…":
        ready?`Zobrazeno ${ready.items.length} autorizovaných položek.`:
        "Dřívější výsledky byly odstraněny."}
    </p>
    {state.status==="error"&&<p role="alert" className="stagingGlobalError">
      {failures[state.reason]}</p>}
    {ready&&<section aria-label={"Položky rozsahu "+scopeLabels[scope]}>
      {ready.items.length===0
        ?<p className="stagingGlobalEmpty">V tomto rozsahu nejsou dostupné položky.</p>
        :<ul className="stagingGlobalItems">
          {ready.items.map(entry=>{const href=stagingIndexDetailHref(entry.kind,entry.item.id,{
            project:projectDetailEnabled,note:noteDetailEnabled,task:taskDetailEnabled,
          });return <li
            key={entry.kind+":"+entry.item.id}
            className="stagingGlobalItem" data-area-kind={entry.item.areaKind}>
            <span className="stagingGlobalGlyph" data-kind={entry.kind}
              aria-hidden="true"/>
            {href ? <a className="stagingGlobalItemTitle stagingGlobalItemLink"
              href={href}
              aria-label={entry.kind==="project"
                ?"Otevřít projekt: "+entry.item.title
                :entry.kind==="note"?"Otevřít poznámku: "+entry.item.title
                :"Otevřít úkol: "+entry.item.title}>
              {entry.item.title}
            </a> : <span className="stagingGlobalItemTitle">{entry.item.title}</span>}
            <span className="stagingGlobalKind">{kindLabels[entry.kind]}</span>
            <span className="stagingGlobalArea">
              {entry.item.areaKind==="private"?"Osobní":"Sdílené"}
            </span>
          </li>;})}
        </ul>}
      {ready.hasMore&&<button type="button" disabled={moreBusy}
        onClick={()=>{void loadMore();}}>Načíst další položky</button>}
      <p className="stagingGlobalPrivacy">Údaje se neukládají do offline cache.
        Poznámky zobrazují jen název, nikoli obsah. Případný odkaz
        otevírá samostatný náhled, který obsah zobrazí až po dalším
        výslovném serverově autorizovaném načtení. Žádné zápisy zde nejsou.</p>
    </section>}
  </main>;
}
