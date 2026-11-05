"use client";

/** R3-slice/UI-01: isolated read-only target preview, NEVER the legacy task view.
 * No writes, local cache, sync queue, optimistic completion or offline storage. */
import {useEffect,useRef,useState} from "react";
import {
  appendMyPlanSlice,fetchMyPlanSlice,localMyPlanDate,validMyPlanDate,
  type MyPlanReadFailure,type MyPlanSliceFilter,
  type MyPlanSlicePage,type MyPlanSliceTask,
} from "../../lib/target-staging-my-plan-client";
import {
  msUntilNextLocalMyPlanDay,resumeMyPlanDate,
} from "../../lib/target-staging-my-plan-lifecycle";

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
  const [followToday,setFollowToday]=useState(true);
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
    // A backgrounded/offline tab may not display an old actor's sensitive rows.
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setState({status:"error",reason:navigator.onLine?"stale":"offline"});
      return;
    }
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
      if(result.ok===true)setState({status:"ready",page:result.page});
      else setState({status:"error",reason:result.reason});
    });
    return()=>controller.abort();
  },[date,areaFilter,refresh]);

  /** Discard tasks synchronously in state before any new authorization read. */
  function invalidate(reason:MyPlanReadFailure){
    requestSequence.current++;
    current.current?.abort();
    moreInFlight.current=false;
    setMoreBusy(false);
    setState({status:"error",reason});
  }

  // Reactivating a tab always requires a new server ACL/session/epoch witness.
  // Track the local-day boundary separately from user-selected historical days.
  useEffect(()=>{
    if(!date)return;
    let clockTimer:ReturnType<typeof setTimeout>|undefined;
    let lastAwake=0;
    const armClock=()=>{
      if(clockTimer!==undefined)clearTimeout(clockTimer);
      clockTimer=setTimeout(()=>{
        if(document.visibilityState==="visible")wake(true);
        else{
          invalidate("stale");
          armClock();
        }
      },msUntilNextLocalMyPlanDay());
    };
    const wake=(force=false)=>{
      if(document.visibilityState!=="visible")return;
      const now=Date.now();
      // Focus and visibilitychange commonly arrive as a pair.
      if(!force&&now-lastAwake<350)return;
      lastAwake=now;
      if(!navigator.onLine){invalidate("offline");return;}
      const chosen=resumeMyPlanDate(date,followToday,new Date());
      invalidate("stale");
      if(chosen.changed)setDate(chosen.evaluationDate);
      else setRefresh(value=>value+1);
      armClock();
    };
    const visibility=()=>{
      if(document.visibilityState==="hidden")invalidate("stale");
      else wake();
    };
    const foreground=()=>wake();
    const offline=()=>invalidate("offline");
    const online=()=>wake(true);
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("focus",foreground);
    window.addEventListener("pageshow",foreground);
    window.addEventListener("offline",offline);
    window.addEventListener("online",online);
    armClock();
    return()=>{
      if(clockTimer!==undefined)clearTimeout(clockTimer);
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("focus",foreground);
      window.removeEventListener("pageshow",foreground);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",online);
    };
  },[date,followToday]);

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
    if(result.ok===false){
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
          onChange={event=>{
            const chosen=event.target.value;
            if(!validMyPlanDate(chosen))return;
            setFollowToday(false); // A manual date remains pinned at midnight.
            if(chosen!==date){invalidate("stale");setDate(chosen);}
          }}/>
      </label>
      <label>Moje práce
        <select value={areaFilter}
          onChange={event=>{
            invalidate("stale");
            setAreaFilter(event.target.value as MyPlanSliceFilter);
          }}>
          <option value="all">Osobní i přiřazené sdílené</option>
          <option value="personal">Osobní</option>
          <option value="shared">Přiřazené sdílené</option>
        </select>
      </label>
      <button type="button" onClick={()=>{
        const chosen=localMyPlanDate();
        invalidate("stale");
        setFollowToday(true);
        if(chosen===date)setRefresh(n=>n+1);
        else setDate(chosen);
      }}>Aktuální den</button>
      <button type="button" onClick={()=>{
        invalidate("stale");
        setRefresh(n=>n+1);
      }}>Obnovit</button>
    </div>
    {state.status==="loading"&&<p role="status">Načítám aktuální přehled…</p>}
    {state.status==="error"&&
      <p role="alert" className="stagingMyPlanWarning">{reasons[state.reason]}</p>}
    {state.status==="ready"&&date&&
      state.page.evaluationDate===date&&state.page.areaFilter===areaFilter&&<>
      <PlanDay label={followToday?"Dnes a dřívější":"Do vybraného dne včetně"}
        date={date} tasks={state.page.today.tasks}/>
      <PlanDay label={(followToday?"Zítra · ":"Následující den · ")+
        nextHumanDate(date)}
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
