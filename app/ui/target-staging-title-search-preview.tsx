"use client";

/** UI-09b: deliberately isolated, read-only staging search. Every result page is
 * authorized by the live server. Never persist, prefetch or reuse results. */
import {useEffect,useRef,useState} from "react";
import {
  validTitleSearchQuery,
  type TitleSearchFailure,type TitleSearchScope,type TitleSearchKind,
} from "../../lib/target-staging-title-search-client";
import {
  createStagingTitleSearchSession,
  type TitleSearchSessionSnapshot,
} from "../../lib/target-staging-title-search-session";

const scopes:Record<TitleSearchScope,string>={
  all:"Vše",personal:"Osobní",shared:"Sdílené",
};
const kinds:Record<TitleSearchKind,string>={
  project:"Projekt",task:"Úkol",note:"Poznámka",
};
const failures:Record<TitleSearchFailure,string>={
  "invalid-request":"Zadejte 2 až 80 znaků, nejvýše osm slov, bez řídicích znaků.",
  "signed-out":"Přihlášení nebo přístup zanikl. Výsledky byly odstraněny.",
  "stale":"Vyhledávání je neaktuální. Pro nové ověření ho znovu spusťte.",
  "disabled":"Stagingové vyhledávání není zapnuté.",
  "rate-limited":"Příliš mnoho dotazů. Vyhledávání spusťte později.",
  "unavailable":"Autorizované vyhledávání není dostupné.",
  "offline":"Připojení není dostupné. Předchozí výsledky byly skryty.",
  "aborted":"Vyhledávání bylo přerušeno. Spusťte ho znovu.",
  "invalid-response":"Odpověď neprošla kontrolou. Žádné výsledky se nezobrazují.",
};

function foregroundOnline(){return document.visibilityState!=="hidden"&&navigator.onLine;}

export function TargetStagingTitleSearchPreview(){
  const session=useRef<ReturnType<typeof createStagingTitleSearchSession>|null>(null);
  if(session.current===null)session.current=createStagingTitleSearchSession();
  const epoch=useRef(0);
  const [draft,setDraft]=useState("");
  const [scope,setScope]=useState<TitleSearchScope>("all");
  const [snapshot,setSnapshot]=useState<TitleSearchSessionSnapshot|null>(null);
  const [failure,setFailure]=useState<TitleSearchFailure|null>(null);

  function invalidate(reason:TitleSearchFailure|null=null){
    epoch.current++;
    session.current?.reset();
    setSnapshot(null);
    setFailure(reason);
  }

  useEffect(()=>{
    const conceal=(reason:TitleSearchFailure="stale")=>{
      epoch.current++;
      session.current?.reset();
      setSnapshot(null);
      setDraft("");
      setFailure(reason);
    };
    const visibility=()=>{if(document.visibilityState==="hidden")conceal();};
    const offline=()=>conceal("offline");
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)conceal();};
    document.addEventListener("visibilitychange",visibility);
    const pagehide=()=>conceal();
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("blur",pagehide);
    window.addEventListener("focus",pagehide);
    window.addEventListener("offline",offline);
    if(document.visibilityState==="hidden"||!navigator.onLine)
      conceal(navigator.onLine?"stale":"offline");
    return ()=>{
      epoch.current++;
      session.current?.reset();
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("blur",pagehide);
      window.removeEventListener("focus",pagehide);
      window.removeEventListener("offline",offline);
    };
  },[]);

  function changeDraft(value:string){
    // Never leave results for an older query visible below an edited input.
    invalidate();
    setDraft(value);
  }
  function changeScope(value:TitleSearchScope){
    if(value===scope)return;
    invalidate();
    setScope(value);
  }
  async function search(){
    const query=draft.trim();
    invalidate();
    if(!validTitleSearchQuery(query)){setFailure("invalid-request");return;}
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setFailure(navigator.onLine?"stale":"offline");
      return;
    }
    const id=++epoch.current;
    const pending=session.current!.first({query,scope,limit:25});
    setSnapshot(session.current!.getSnapshot());
    const result=await pending;
    if(epoch.current!==id||!foregroundOnline())return;
    setSnapshot(session.current!.getSnapshot());
    setFailure(result.ok===false?result.reason:null);
  }
  async function loadMore(){
    if(snapshot?.status!=="ready"||!snapshot.hasMore||
      document.visibilityState==="hidden"||!navigator.onLine){
      if(!navigator.onLine)invalidate("offline");
      return;
    }
    const id=++epoch.current;
    const pending=session.current!.next();
    // Snapshot is loading and cannot render old titles while server rechecks ACL.
    setSnapshot(session.current!.getSnapshot());
    const result=await pending;
    if(epoch.current!==id||!foregroundOnline())return;
    setSnapshot(session.current!.getSnapshot());
    setFailure(result.ok===false
      ?(result.reason==="limit-reached"?"invalid-request":result.reason):null);
  }

  const ready=snapshot?.status==="ready"?snapshot:null;
  const busy=snapshot?.status==="loading";
  return <main className="stagingTitleSearch">
    <header>
      <p className="stagingTitleSearchEyebrow">Lumi · izolovaný staging · pouze čtení</p>
      <h1>Hledání v názvech</h1>
      <p>Vše zahrnuje jen aktuálně oprávněné osobní a sdílené položky.
        <strong> Vše není Můj plán.</strong> Tento náhled není součástí běžné aplikace.</p>
    </header>
    <nav className="stagingTitleSearchScopes" aria-label="Rozsah vyhledávání">
      {(["all","personal","shared"] as const).map(value=>
        <button key={value} type="button" aria-pressed={scope===value}
          onClick={()=>changeScope(value)}>{scopes[value]}</button>)}
    </nav>
    <form className="stagingTitleSearchForm" role="search"
      onSubmit={event=>{event.preventDefault();void search();}}>
      <label htmlFor="staging-title-search-query">Hledaný název</label>
      <div className="stagingTitleSearchFields">
        <input id="staging-title-search-query" type="search" autoComplete="off"
          maxLength={80} value={draft} onChange={event=>changeDraft(event.target.value)}
          placeholder="Hledat projekty, úkoly a poznámky" />
        <button type="submit" disabled={busy}>Vyhledat</button>
      </div>
      <p className="stagingTitleSearchHint">2–80 znaků, nejvýše osm slov. Vyhledávání proběhne pouze po odeslání.</p>
    </form>
    {busy&&<p role="status">Načítám autorizované výsledky…</p>}
    {failure&&<p role="alert" className="stagingTitleSearchError">{failures[failure]}</p>}
    {ready&&<section aria-label="Autorizované výsledky vyhledávání">
      {ready.items.length===0
        ?<p role="status">Pro dotaz nebyly nalezeny žádné dostupné názvy.</p>
        :<ul className="stagingTitleSearchItems">
          {ready.items.map(item=><li key={item.kind+":"+item.id}
            data-area-kind={item.areaKind} className="stagingTitleSearchItem">
            <span aria-hidden="true" className="stagingTitleSearchGlyph" data-kind={item.kind}/>
            <span className="stagingTitleSearchTitle">{item.title}</span>
            <span className="stagingTitleSearchKind">{kinds[item.kind]}</span>
          </li>)}
        </ul>}
      {ready.hasMore&&<button type="button" onClick={()=>{void loadMore();}}>
        Načíst další výsledky</button>}
      {ready.limitReached&&<p role="status">
        Dosažen bezpečnostní limit zobrazených výsledků. Upřesněte dotaz.</p>}
      <p className="stagingTitleSearchPrivacy">Poznámky zobrazují pouze název, nikdy obsah.
        Výsledky se neukládají, při opuštění stránky se odstraní a každý další
        dotaz i stránka znovu ověřuje aktuální přístup na serveru.</p>
    </section>}
  </main>;
}
