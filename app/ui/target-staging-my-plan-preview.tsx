"use client";

/** R3-slice/UI-01: isolated read-only target preview, NEVER the legacy task view.
 * No writes, local cache, sync queue, optimistic completion or offline storage. */
import {useEffect,useRef,useState} from "react";
import {
  appendMyPlanSlice,fetchMyPlanSlice,localMyPlanDate,validMyPlanDate,
  type MyPlanReadFailure,type MyPlanSliceFilter,
  type MyPlanSlicePage,type MyPlanSliceTask,
} from "../../lib/target-staging-my-plan-client";

type ReadState=
  |{status:"loading"}
  |{status:"error";reason:MyPlanReadFailure}
  |{status:"ready";page:MyPlanSlicePage};

const reasons:Record<MyPlanReadFailure,string>={
  "signed-out":"Přihlášení není platné. Přehled byl skryt; přihlaste se znovu.",
  "stale":"Data nebo oprávnění se změnily. Přehled byl skryt; obnovte jej.",
  "unavailable":"Bezpečný stagingový přehled není dostupný nebo je vypnutý.",
  "offline":"Připojení se nezdařilo. Žádné úkoly nebyly změněny.",
  "invalid-response":"Odpověď neodpovídá bezpečnému kontraktu; údaje nejsou zobrazeny.",
  "invalid-request":"Neplatné datum nebo parametry požadavku.",
  "aborted":"Načítání bylo přerušeno.",
};
const humanDate=(day:string)=>new Intl.DateTimeFormat("cs-CZ",{
  day:"numeric",month:"long",year:"numeric",
}).format(new Date(day+"T12:00:00"));
const nextHumanDate=(day:string)=>{
  const following=new Date(day+"T12:00:00.000Z");
  following.setUTCDate(following.getUTCDate()+1);
  return humanDate(following.toISOString().slice(0,10));
};

function PlanDay({label,tasks,date}:{
  label:string;tasks:MyPlanSliceTask[];date:string;
}){
  const areas=new Map<string,{kind:"private"|"shared";tasks:MyPlanSliceTask[]}>();
  for(const task of tasks){
    const group=areas.get(task.areaId);
    if(group)group.tasks.push(task);
    else areas.set(task.areaId,{kind:task.areaKind,tasks:[task]});
  }
  return <section className="stagingMyPlanDay" aria-label={label}>
    <h2>{label} <span className="stagingMyPlanCount">{tasks.length}</span></h2>
    {tasks.length===0
      ?<p className="stagingMyPlanEmpty">Žádné úkoly v tomto dni.</p>
      :<div className="stagingMyPlanGroups">
        {[...areas].map(([id,group])=>
          <div className="stagingMyPlanArea" data-area-kind={group.kind}
            aria-label={group.kind==="private"?"Soukromá oblast":"Sdílená oblast"}
            role="group" key={id}>
            <ul>{group.tasks.map(task=>
              <li key={task.taskId}>
                <span className="stagingMyPlanSquare" aria-hidden="true"/>
                <div className="stagingMyPlanTask">
                  <strong>{task.title}</strong>
                  {task.attentionOn<date&&
                    <small>Vyžaduje pozornost od {humanDate(task.attentionOn)}</small>}
                  {task.dueOn&&<small>Termín: {humanDate(task.dueOn)}</small>}
                  {task.whenOn&&<small>Naplánováno: {humanDate(task.whenOn)}</small>}
                </div>
              </li>)}</ul>
          </div>)}
      </div>}
  </section>;
}
export function TargetStagingMyPlanPreview(){
  const [date,setDate]=useState<string|null>(null);
  const [areaFilter,setAreaFilter]=useState<MyPlanSliceFilter>("all");
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<ReadState>({status:"loading"});
  const [moreBusy,setMoreBusy]=useState(false);
  const requestSequence=useRef(0);
  const current=useRef<AbortController|null>(null);
  const moreInFlight=useRef(false);

  // Compute the local calendar anchor only after hydration, never server TZ.
  useEffect(()=>{setDate(localMyPlanDate());return()=>{
    requestSequence.current++;
    current.current?.abort();
  };},[]);

  useEffect(()=>{
    if(!date)return;
    const id=++requestSequence.current;
    current.current?.abort();
    const controller=new AbortController();
    current.current=controller;
    moreInFlight.current=false;
    setMoreBusy(false);
    setState({status:"loading"}); // Never display the prior identity's data.
    void fetchMyPlanSlice({
      evaluationDate:date,areaFilter,signal:controller.signal,
    }).then(result=>{
      if(controller.signal.aborted||requestSequence.current!==id)return;
      setState(result.ok?{status:"ready",page:result.page}:
        {status:"error",reason:result.reason});
    });
    return()=>controller.abort();
  },[date,areaFilter,refresh]);

  async function more(){
    if(moreInFlight.current||state.status!=="ready"||
      !state.page.hasMore||!state.page.nextCursor||!date)return;
    moreInFlight.current=true;
    setMoreBusy(true);
    const id=++requestSequence.current;
    const controller=new AbortController();
    current.current?.abort();
    current.current=controller;
    const result=await fetchMyPlanSlice({
      evaluationDate:date,areaFilter,cursor:state.page.nextCursor,
      signal:controller.signal,
    });
    if(controller.signal.aborted||requestSequence.current!==id)return;
    moreInFlight.current=false;
    setMoreBusy(false);
    if(!result.ok){
      // On any error discard ALL previously displayed sensitive data.
      setState({status:"error",reason:result.reason});
      return;
    }
    const combined=appendMyPlanSlice(state.page,result.page);
    setState(combined?{status:"ready",page:combined}:
      {status:"error",reason:"invalid-response"});
  }
  return <main className="stagingMyPlanPreview">
    <header>
      <p className="stagingMyPlanEyebrow">Lumi · izolovaný staging</p>
      <h1>Můj plán</h1>
      <p>Čtecí náhled cílového modelu. Jen úkoly; bez kalendářových
        událostí, úprav, synchronizační fronty a ukládání offline.</p>
    </header>
    <div className="stagingMyPlanToolbar">
      <label>Den
        <input type="date" value={date??""}
          onChange={event=>{if(validMyPlanDate(event.target.value))
            setDate(event.target.value);}}/>
      </label>
      <label>Moje práce
        <select value={areaFilter}
          onChange={event=>setAreaFilter(event.target.value as MyPlanSliceFilter)}>
          <option value="all">Osobní i přiřazené sdílené</option>
          <option value="personal">Osobní</option>
          <option value="shared">Přiřazené sdílené</option>
        </select>
      </label>
      <button type="button" onClick={()=>setRefresh(n=>n+1)}>Obnovit</button>
    </div>
    {state.status==="loading"&&<p role="status">Načítám aktuální přehled…</p>}
    {state.status==="error"&&
      <p role="alert" className="stagingMyPlanWarning">{reasons[state.reason]}</p>}
    {state.status==="ready"&&date&&<>
      <PlanDay label="Dnes a dřívější" date={date} tasks={state.page.today.tasks}/>
      <PlanDay label={"Zítra · "+nextHumanDate(date)}
        date={date} tasks={state.page.tomorrow.tasks}/>
      {state.page.hasMore&&
        <button disabled={moreBusy} type="button" onClick={()=>{void more();}}>
          {moreBusy?"Načítám…":"Načíst další úkoly"}
        </button>}
      <p className="stagingMyPlanScope">Náhled neumožňuje dokončení, přesun ani Undo.
        Oprávnění se ověřují na serveru při každém načtení.</p>
    </>}
  </main>;
}
