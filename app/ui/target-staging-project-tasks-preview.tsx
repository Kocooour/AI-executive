"use client";

/** UI-09c: a linkable, default-off, server-authorized project read.
 * This component never treats a project ID or a cached page as permission. */
import {useEffect,useRef,useState} from "react";
import {
  appendProjectTasksPage,loadProjectTasksPage,
  type ProjectTasksFailure,type ProjectTasksPage,
} from "../../lib/target-staging-project-tasks-client";

type View={status:"empty"|"loading"}|
  {status:"ready";page:ProjectTasksPage}|
  {status:"error";reason:ProjectTasksFailure};
const failures:Record<ProjectTasksFailure,string>={
  "invalid-request":"Neplatný požadavek na projekt.",
  "signed-out":"Přihlášení nebo oprávnění zaniklo. Předchozí data byla skryta.",
  "not-found":"Projekt nebyl nalezen nebo k němu nemáte přístup.",
  "stale":"Projekt nebo přístup se změnil. Spusťte nové ověření.",
  "unavailable":"Autorizované zobrazení projektu není dostupné.",
  "offline":"Připojení není dostupné. Předchozí data byla skryta.",
  "aborted":"Načítání bylo přerušeno. Spusťte nové ověření.",
  "invalid-response":"Odpověď neprošla kontrolou. Data nebyla zobrazena.",
};
const foreground=()=>document.visibilityState!=="hidden"&&navigator.onLine;
const pageLimit=25,maxItems=500;

export function TargetStagingProjectTasksPreview({projectId}:{projectId:string}){
  const [view,setView]=useState<View>({status:"empty"});
  const generation=useRef(0);
  const running=useRef<AbortController|null>(null);
  const inFlight=useRef(false);
  const statusRef=useRef<HTMLParagraphElement>(null);
  const seenCursors=useRef(new Set<string>());

  function conceal(reason?:ProjectTasksFailure){
    generation.current++;
    running.current?.abort();
    running.current=null;
    inFlight.current=false;
    seenCursors.current.clear();
    setView(reason?{status:"error",reason}:{status:"empty"});
  }
  useEffect(()=>{
    const hide=()=>conceal("stale");
    const visible=()=>{if(document.visibilityState==="hidden")hide();};
    const offline=()=>conceal("offline");
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)hide();};
    document.addEventListener("visibilitychange",visible);
    window.addEventListener("pagehide",hide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("blur",hide);
    window.addEventListener("focus",hide);
    window.addEventListener("offline",offline);
    if(!foreground())conceal(navigator.onLine?"stale":"offline");
    return ()=>{
      generation.current++;
      running.current?.abort();
      document.removeEventListener("visibilitychange",visible);
      window.removeEventListener("pagehide",hide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("blur",hide);
      window.removeEventListener("focus",hide);
      window.removeEventListener("offline",offline);
    };
  },[projectId]);

  async function read(next=false){
    if(inFlight.current)return;
    const prior=next&&view.status==="ready"?view.page:null;
    const cursor=prior?.nextCursor;
    if(next&&(!prior||!prior.hasMore||!cursor||
      seenCursors.current.has(cursor)||prior.tasks.length+pageLimit>maxItems))
      return;
    if(!foreground()){
      conceal(navigator.onLine?"stale":"offline");
      return;
    }
    if(next)statusRef.current?.focus(); // before the result list unmounts
    inFlight.current=true;
    const id=++generation.current;
    running.current?.abort();
    const controller=new AbortController();
    running.current=controller;
    if(!next)seenCursors.current.clear();
    setView({status:"loading"}); // never render old titles during live ACL check
    const result=await loadProjectTasksPage({
      projectId,limit:pageLimit,...(cursor?{cursor}:{}),signal:controller.signal,
    });
    if(id!==generation.current||!foreground())return;
    inFlight.current=false;
    running.current=null;
    if(result.ok===false){
      seenCursors.current.clear();
      setView({status:"error",reason:result.reason});return;
    }
    const page=prior&&cursor?appendProjectTasksPage(prior,result.page,cursor):result.page;
    if(!page||((page.nextCursor&&seenCursors.current.has(page.nextCursor))||
      page.tasks.length>maxItems)){
      seenCursors.current.clear();
      setView({status:"error",reason:"invalid-response"});return;
    }
    if(cursor)seenCursors.current.add(cursor);
    setView({status:"ready",page});
  }

  const ready=view.status==="ready"?view.page:null;
  const loading=view.status==="loading";
  return <main className="stagingProjectTasks">
    <header>
      <p className="stagingProjectEyebrow">Lumi · izolovaný staging · pouze čtení</p>
      <h1>Úkoly projektu</h1>
      <p>Obsah se zobrazí až po vašem výslovném načtení. Server při každé
        stránce znovu ověří oprávnění k projektu i jeho úkolům.</p>
    </header>
    <div className="stagingProjectActions">
      <button type="button" disabled={loading}
        onClick={()=>{conceal();void read();}}>Ověřit a načíst projekt</button>
    </div>
    <p role="status" tabIndex={-1} ref={statusRef}>
      {loading?"Ověřuji aktuální přístup…":
        ready?"Zobrazeno "+ready.tasks.length+" úkolů projektu.":
        view.status==="error"?"Autorizovaný obsah není dostupný.":""}
    </p>
    {view.status==="error"&&<p role="alert" className="stagingProjectError">
      {failures[view.reason]}</p>}
    {ready&&<section aria-label="Autorizovaný detail projektu">
      <h2>{ready.project.title}</h2>
      <p className="stagingProjectScope">
        {ready.project.areaKind==="private"?"Osobní":"Sdílený"} projekt
      </p>
      {ready.tasks.length===0
        ?<p>Projekt nemá dostupné úkoly.</p>
        :<ul className="stagingProjectItems">
          {ready.tasks.map(task=><li className="stagingProjectItem" key={task.id}>
            <span aria-hidden="true" className="stagingProjectSquare"/>
            <span className="stagingProjectTaskTitle">{task.title}</span>
            {task.areaKind==="shared"&&task.assignedToMe===true&&
              <span className="stagingProjectMine">Přiřazeno mně</span>}
          </li>)}
        </ul>}
      {ready.hasMore&&ready.nextCursor&&ready.tasks.length+pageLimit<=maxItems
        ?<button type="button" onClick={()=>{void read(true);}}>Načíst další úkoly</button>
        :null}
      {ready.hasMore&&ready.tasks.length+pageLimit>maxItems&&
        <p role="status">Dosažen bezpečnostní limit zobrazení.</p>}
      <p className="stagingProjectPrivacy">Výsledky se neukládají.
        Při ztrátě přístupu, připojení nebo opuštění stránky se skryjí.
        Jde o technický náhled, nikoliv o produkční obrazovku.</p>
    </section>}
  </main>;
}
