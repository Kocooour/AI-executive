"use client";

/** UI-09d: authorized note body stays in memory only for this visible actor.
 * No prefetch, writes, reload, persistence or production navigation. */
import {useEffect,useRef,useState} from "react";
import {
  readStagingNotePreview,
  type NotePreview,type NotePreviewFailure,
} from "../../lib/target-staging-note-preview-client";

const reasons:Record<NotePreviewFailure,string>={
  "invalid-request":"Neplatný odkaz na poznámku.",
  "signed-out":"Přístup zanikl. Obsah byl odstraněn.",
  "not-found":"Poznámka není dostupná.",
  "stale":"Oprávnění nebo poznámka se změnily. Obsah byl odstraněn.",
  "disabled":"Náhled není povolen.",
  "rate-limited":"Příliš mnoho požadavků. Zkuste to později.",
  "unavailable":"Bezpečné čtení poznámky není dostupné.",
  "offline":"Není dostupné připojení. Obsah byl odstraněn.",
  "aborted":"Čtení bylo přerušeno. Pro nové ověření jej znovu spusťte.",
  "invalid-response":"Odpověď neprošla kontrolou. Obsah není zobrazen.",
};
type State={status:"idle"|"loading"}|
  {status:"ready";note:NotePreview}|
  {status:"error";reason:NotePreviewFailure};

export function TargetStagingNotePreview({noteId}:{noteId:string}){
  const [state,setState]=useState<State>({status:"idle"});
  const current=useRef<AbortController|null>(null);
  const epoch=useRef(0);

  function conceal(reason:NotePreviewFailure|null=null){
    epoch.current++;
    current.current?.abort();
    current.current=null;
    setState(reason?{status:"error",reason}:{status:"idle"});
  }
  useEffect(()=>{
    const hidden=()=>{if(document.visibilityState==="hidden")conceal("stale");};
    const blur=()=>conceal("stale");
    const offline=()=>conceal("offline");
    const bfcache=(event:PageTransitionEvent)=>{if(event.persisted)conceal("stale");};
    document.addEventListener("visibilitychange",hidden);
    window.addEventListener("pagehide",blur);
    window.addEventListener("blur",blur);
    window.addEventListener("focus",blur);
    window.addEventListener("pageshow",bfcache);
    window.addEventListener("offline",offline);
    if(document.visibilityState==="hidden"||!navigator.onLine)
      conceal(navigator.onLine?"stale":"offline");
    return ()=>{
      epoch.current++;
      current.current?.abort();
      current.current=null;
      document.removeEventListener("visibilitychange",hidden);
      window.removeEventListener("pagehide",blur);
      window.removeEventListener("blur",blur);
      window.removeEventListener("focus",blur);
      window.removeEventListener("pageshow",bfcache);
      window.removeEventListener("offline",offline);
    };
  },[noteId]);

  async function load(){
    conceal();
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setState({status:"error",reason:navigator.onLine?"stale":"offline"});
      return;
    }
    const id=++epoch.current;
    const controller=new AbortController();
    current.current=controller;
    setState({status:"loading"});
    const result=await readStagingNotePreview(noteId,controller.signal);
    if(controller.signal.aborted||epoch.current!==id||
      document.visibilityState==="hidden"||!navigator.onLine)return;
    current.current=null;
    setState(result.ok?{status:"ready",note:result.note}:
      {status:"error",reason:result.reason});
  }
  const note=state.status==="ready"?state.note:null;
  return <main className="stagingNotePreview">
    <header>
      <p className="stagingNoteEyebrow">Lumi · izolovaný staging · pouze čtení</p>
      <h1>Detail poznámky</h1>
      <p>Obsah se zobrazí pouze po výslovném načtení a novém ověření
        aktuálního oprávnění na serveru.</p>
    </header>
    <button type="button" className="stagingNoteRead" disabled={state.status==="loading"}
      onClick={()=>{void load();}}>
      {state.status==="loading"?"Ověřuji přístup…":"Načíst poznámku"}
    </button>
    <p role="status" className="stagingNoteStatus">
      {state.status==="loading"?"Načítám autorizovaný obsah…":
        note?"Autorizovaný obsah je zobrazen.":""}
    </p>
    {state.status==="error"&&<p role="alert" className="stagingNoteError">
      {reasons[state.reason]}</p>}
    {note&&<article className="stagingNoteContent" data-area-kind={note.areaKind} aria-label="Autorizovaná poznámka">
      <p className="stagingNoteScope">
        {note.areaKind==="shared"?"Sdílená oblast":"Osobní oblast"}
      </p>
      <h2>{note.title}</h2>
      <pre className="stagingNoteBody">{note.body}</pre>
    </article>}
    <p className="stagingNoteDisclaimer">Obsah se neukládá do prohlížeče,
      URL ani offline úložiště. Při skrytí stránky, ztrátě fokusu nebo
      připojení se okamžitě odstraní. Obnovení vyžaduje nové ruční načtení.</p>
  </main>;
}
