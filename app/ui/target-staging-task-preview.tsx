"use client";

/** UI-09f: authorized task detail stays in memory only for this visible actor.
 * No prefetch, writes, reload, persistence or production navigation. */
import {useEffect,useRef,useState} from "react";
import {
  readStagingTaskPreview,
  type TaskPreview,type TaskPreviewFailure,
} from "../../lib/target-staging-task-preview-client";

const reasons:Record<TaskPreviewFailure,string>={
  "invalid-request":"Neplatný odkaz na úkol.",
  "signed-out":"Přístup zanikl. Obsah byl odstraněn.",
  "not-found":"Úkol není dostupný.",
  "stale":"Oprávnění nebo úkol se změnily. Obsah byl odstraněn.",
  "disabled":"Náhled není povolen.",
  "rate-limited":"Příliš mnoho požadavků. Zkuste to později.",
  "unavailable":"Bezpečné čtení úkolu není dostupné.",
  "offline":"Není dostupné připojení. Obsah byl odstraněn.",
  "aborted":"Čtení bylo přerušeno. Pro nové ověření jej znovu spusťte.",
  "invalid-response":"Odpověď neprošla kontrolou. Obsah není zobrazen.",
};
function foregroundOnline(){return document.visibilityState!=="hidden"&&navigator.onLine;}
type State={status:"idle"|"loading"}|
  {status:"ready";task:TaskPreview}|
  {status:"error";reason:TaskPreviewFailure};

export function TargetStagingTaskPreview({taskId}:{taskId:string}){
  const [state,setState]=useState<State>({status:"idle"});
  const current=useRef<AbortController|null>(null);
  const epoch=useRef(0);
  const statusRef=useRef<HTMLParagraphElement>(null);

  function conceal(reason:TaskPreviewFailure|null=null){
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
  },[taskId]);

  async function load(){
    conceal();
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setState({status:"error",reason:navigator.onLine?"stale":"offline"});
      return;
    }
    const id=++epoch.current;
    const controller=new AbortController();
    current.current=controller;
    // The read button is disabled during authorization; retain keyboard focus
    // on a stable live status instead of losing it to the document.
    statusRef.current?.focus();
    setState({status:"loading"});
    const result=await readStagingTaskPreview(taskId,controller.signal);
    if(controller.signal.aborted||epoch.current!==id||!foregroundOnline())return;
    current.current=null;
    if(result.ok===true)setState({status:"ready",task:result.task});
    else setState({status:"error",reason:result.reason});
  }
  const task=state.status==="ready"?state.task:null;
  return <main className="stagingTaskPreview">
    <header>
      <p className="stagingTaskEyebrow">Lumi · izolovaný staging · pouze čtení</p>
      <h1>Detail úkolu</h1>
      <p>Obsah se zobrazí pouze po výslovném načtení a novém ověření
        aktuálního oprávnění na serveru.</p>
    </header>
    <button type="button" className="stagingTaskRead" disabled={state.status==="loading"}
      onClick={()=>{void load();}}>
      {state.status==="loading"?"Ověřuji přístup…":"Načíst úkol"}
    </button>
    <p role="status" tabIndex={-1} ref={statusRef} className="stagingTaskStatus">
      {state.status==="loading"?"Načítám autorizovaný obsah…":
        task?"Autorizovaný obsah je zobrazen.":""}
    </p>
    {state.status==="error"&&<p role="alert" className="stagingTaskError">
      {reasons[state.reason]}</p>}
    {task&&<article className="stagingTaskContent" data-area-kind={task.areaKind} aria-label="Autorizovaný úkol">
      <p className="stagingTaskScope">
        {task.areaKind==="shared"?"Sdílená oblast":"Osobní oblast"}
      </p>
      <h2>{task.title}</h2>
      <p>{task.status==="completed"?"Dokončeno":"Otevřeno"}</p>
      {task.dueOn&&<p>Termín: <time dateTime={task.dueOn}>{task.dueOn}</time></p>}
      {task.assignedToMe&&<p>Přiřazeno mně</p>}
    </article>}
    <p className="stagingTaskDisclaimer">Obsah se neukládá do prohlížeče,
      URL ani offline úložiště. Při skrytí stránky, ztrátě fokusu nebo
      připojení se okamžitě odstraní. Obnovení vyžaduje nové ruční načtení.</p>
  </main>;
}
