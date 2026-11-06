"use client";

/** R3-slice/UI-03b: gated staging My Plan. Never the legacy task view.
 * Status controls require an independent SERVER opt-in. No offline queue,
 * optimistic status, persistent task cache or production UI integration. */
import {useEffect,useRef,useState} from "react";
import {
  appendMyPlanSlice,fetchMyPlanSlice,localMyPlanDate,validMyPlanDate,
  type MyPlanReadFailure,type MyPlanSliceFilter,
  type MyPlanSlicePage,type MyPlanSliceTask,
} from "../../lib/target-staging-my-plan-client";
import {
  msUntilNextLocalMyPlanDay,resumeMyPlanDate,
  initialMyPlanWakeGate,invalidateMyPlanWakeGate,consumeMyPlanWake,
} from "../../lib/target-staging-my-plan-lifecycle";
import {
  prepareMyPlanStatus,dispatchMyPlanStatus,checkMyPlanStatusReceipt,
  type MyPlanStatus,type MyPlanStatusCommand,type MyPlanStatusFailure,
} from "../../lib/target-staging-my-plan-status-client";

type StatusAction=
  |{kind:"idle"}
  |{kind:"pending"|"checking"|"uncertain"}
  |{kind:"committed";taskId:string;areaId:string;status:MyPlanStatus}
  |{kind:"error";reason:MyPlanStatusFailure};
type StatusOperation={
  controller:AbortController;privacyEpoch:number;command:MyPlanStatusCommand|null;
};
const statusReasons:Record<MyPlanStatusFailure,string>={
  "signed-out":"Přístup k zápisu zanikl. Znovu se přihlaste.",
  "stale":"Úkol byl změněn jiným zápisem. Načetl se aktuální přehled.",
  "unavailable":"Stagingový zápis není dostupný nebo byl vypnut.",
  "invalid-response":"Odpověď zápisového endpointu nebyla bezpečně ověřena.",
  "invalid-request":"Neplatné parametry zápisu; úkol nebyl potvrzen.",
  "offline":"Připojení selhalo. Neproběhl žádný automatický opakovaný zápis.",
  "aborted":"Operace byla přerušena. Aktuální stav je třeba znovu ověřit.",
};

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

function PlanDay({label,tasks,date,canComplete,onComplete}:{
  label:string;tasks:MyPlanSliceTask[];date:string;
  canComplete:boolean;onComplete:(task:MyPlanSliceTask)=>void;
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
                {canComplete
                  ?<button type="button" className="stagingMyPlanSquare stagingMyPlanComplete"
                    aria-label={"Dokončit úkol: "+task.title}
                    onClick={()=>onComplete(task)}/>
                  :<span className="stagingMyPlanSquare" aria-hidden="true"/>}
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
export function TargetStagingMyPlanPreview({
  statusWriteEnabled=false,
}:{statusWriteEnabled?:boolean}){
  const [date,setDate]=useState<string|null>(null);
  const [followToday,setFollowToday]=useState(true);
  const [areaFilter,setAreaFilter]=useState<MyPlanSliceFilter>("all");
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<ReadState>({status:"loading"});
  const [moreBusy,setMoreBusy]=useState(false);
  const [action,setAction]=useState<StatusAction>({kind:"idle"});
  // A command needed for read-only reconciliation is kept in volatile memory,
  // never in React-rendered state, browser storage, or a background queue.
  const uncertainCommand=useRef<MyPlanStatusCommand|null>(null);
  // The previous command's actor-bound receipt must STILL be visible to the
  // current identity before offering its reversal, even in a shared Area.
  const confirmedCommand=useRef<MyPlanStatusCommand|null>(null);
  const statusOperation=useRef<StatusOperation|null>(null);
  const privacyEpoch=useRef(0);
  const requestSequence=useRef(0);
  const current=useRef<AbortController|null>(null);
  const moreInFlight=useRef(false);

  // Compute the local calendar anchor only after hydration, never server TZ.
  useEffect(()=>{setDate(localMyPlanDate());return()=>{
    requestSequence.current++;
    current.current?.abort();
    statusOperation.current?.controller.abort();
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
      else{
        if(result.reason==="signed-out"){
          uncertainCommand.current=null;
          confirmedCommand.current=null;
          setAction({kind:"idle"});
        }
        setState({status:"error",reason:result.reason});
      }
    });
    return()=>controller.abort();
  },[date,areaFilter,refresh]);

  /** Cancel old reads; show loading for deliberate revalidation, not a false
   * conflict warning. In either case prior task contents leave render state. */
  function invalidate(reason:MyPlanReadFailure,refreshing=false){
    requestSequence.current++;
    current.current?.abort();
    moreInFlight.current=false;
    setMoreBusy(false);
    if(refreshing)setState({status:"loading"});
    else setState({status:"error",reason});
  }

  /** No hidden/offline user or task state can remain on screen. A status PATCH
   * interrupted after dispatch is conservatively uncertain, not rolled back.
   * Receipt may be checked only after a fresh authorized My Plan read. */
  function privacyChange(){
    privacyEpoch.current++;
    confirmedCommand.current=null;
    statusOperation.current?.controller.abort();
    setAction(old=>old.kind==="committed"||old.kind==="error"
      ?{kind:"idle"}
      :old.kind==="checking"?{kind:"uncertain"}:old);
  }

  // Reactivating a tab always requires a new server ACL/session/epoch witness.
  // Track the local-day boundary separately from user-selected historical days.
  useEffect(()=>{
    if(!date)return;
    let clockTimer:ReturnType<typeof setTimeout>|undefined;
    let wakeGate=initialMyPlanWakeGate();
    const hide=()=>{
      privacyChange();
      wakeGate=invalidateMyPlanWakeGate(wakeGate);
      invalidate("stale");
    };
    const armClock=()=>{
      if(clockTimer!==undefined)clearTimeout(clockTimer);
      clockTimer=setTimeout(()=>{
        if(document.visibilityState==="visible")wake(true);
        else{
          hide();
          armClock();
        }
      },msUntilNextLocalMyPlanDay());
    };
    const wake=(force=false)=>{
      if(document.visibilityState!=="visible")return;
      // A real hide/show invalidation must bypass focus event coalescing.
      // Only duplicate wake events with no intervening hide/offline are skipped.
      const attempt=consumeMyPlanWake(wakeGate,Date.now(),force);
      wakeGate=attempt.gate;
      if(!attempt.reload)return;
      if(!navigator.onLine){
        wakeGate=invalidateMyPlanWakeGate(wakeGate);
        invalidate("offline");
        return;
      }
      const chosen=resumeMyPlanDate(date,followToday,new Date());
      invalidate("stale",true);
      if(chosen.changed)setDate(chosen.evaluationDate);
      else setRefresh(value=>value+1);
      armClock();
    };
    const visibility=()=>{
      if(document.visibilityState==="hidden")hide();
      else wake();
    };
    const foreground=()=>wake();
    // Back/Forward Cache navigation does not guarantee visibilitychange.
    const pagehide=()=>hide();
    const pageshow=(event:PageTransitionEvent)=>wake(event.persisted);
    const offline=()=>{
      privacyChange();
      wakeGate=invalidateMyPlanWakeGate(wakeGate);
      invalidate("offline");
    };
    const online=()=>wake(true);
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("focus",foreground);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("offline",offline);
    window.addEventListener("online",online);
    armClock();
    return()=>{
      if(clockTimer!==undefined)clearTimeout(clockTimer);
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("focus",foreground);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",online);
    };
  },[date,followToday]);

  function refreshAfterStatus(){
    if(document.visibilityState!=="visible"||!navigator.onLine)return;
    invalidate("stale",true);
    setRefresh(n=>n+1); // Force a NEW actor/session/ACL-checked slice.
  }

  /** The list DTO contains only open tasks. Completed rows disappear after
   * server refresh; a confirmed completion offers a distinct Undo action. */
  async function changeStatus(
    task:{taskId:string;areaId:string},status:MyPlanStatus,
  ){
    if(!statusWriteEnabled||statusOperation.current||
      action.kind==="pending"||action.kind==="checking"||
      action.kind==="uncertain"||state.status!=="ready"||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    if(status==="completed"&&
      ![...state.page.today.tasks,...state.page.tomorrow.tasks].some(
        row=>row.taskId===task.taskId&&row.areaId===task.areaId))return;
    if(status==="open"&&
      !(action.kind==="committed"&&action.status==="completed"&&
        action.taskId===task.taskId&&action.areaId===task.areaId))return;
    const prior= status==="open"?confirmedCommand.current:null;
    if(status==="open"&&(!prior||prior.taskId!==task.taskId||
      prior.writeAreaId!==task.areaId||prior.status!=="completed"))return;
    const op:StatusOperation={
      controller:new AbortController(),privacyEpoch:privacyEpoch.current,command:null,
    };
    statusOperation.current=op; // Synchronous mutex against double clicks.
    uncertainCommand.current=null;
    confirmedCommand.current=null;
    setAction({kind:"pending"});
    invalidate("stale",true); // No stale open row during an uncertain PATCH.
    // Re-read the ORIGINAL actor-bound completion receipt before Undo.
    // A different session/actor must not inherit an old actor's Undo affordance.
    if(prior){
      const receipt=await checkMyPlanStatusReceipt(prior,fetch,op.controller.signal);
      if(statusOperation.current!==op)return;
      if(op.privacyEpoch!==privacyEpoch.current){
        statusOperation.current=null;
        setAction({kind:"idle"});
        return;
      }
      if(receipt.kind!=="committed"){
        statusOperation.current=null;
        if(receipt.kind==="unknown"&&receipt.reason==="signed-out"){
          setAction({kind:"idle"});
          invalidate("signed-out");
        }else{
          setAction({kind:"error",reason:receipt.kind==="unknown"
            ?receipt.reason:"stale"});
          refreshAfterStatus();
        }
        return;
      }
    }
    const prepared=await prepareMyPlanStatus({
      taskId:task.taskId,areaId:task.areaId,status,signal:op.controller.signal,
    });
    if(statusOperation.current!==op)return;
    const result=prepared.ok===false
      ?{kind:"rejected" as const,reason:prepared.reason}
      :await (async()=>{
        op.command=prepared.command;
        return dispatchMyPlanStatus(prepared.command,fetch,op.controller.signal);
      })();
    if(statusOperation.current!==op)return;
    statusOperation.current=null;
    if(op.privacyEpoch!==privacyEpoch.current){
      // If pagehide/offline interrupted a possible write, don't expose
      // the old actor's completion or retry it after the identity changes.
      if(op.command){
        uncertainCommand.current=op.command;
        setAction({kind:"uncertain"});
      }else setAction({kind:"idle"});
      return;
    }
    if(result.kind==="committed"){
      confirmedCommand.current=result.command;
      setAction({kind:"committed",taskId:task.taskId,areaId:task.areaId,status});
    }else if(result.kind==="uncertain"){
      uncertainCommand.current=result.command;
      setAction({kind:"uncertain"});
    }else if(result.reason==="signed-out"){
      uncertainCommand.current=null;
      setAction({kind:"idle"});
      invalidate("signed-out");
      return;
    }else setAction({kind:"error",reason:result.reason});
    refreshAfterStatus();
  }

  /** Manually recheck only the ORIGINAL command; never resend PATCH. */
  async function verifyUncertainReceipt(){
    const command=uncertainCommand.current;
    if(!statusWriteEnabled||!command||statusOperation.current||
      action.kind!=="uncertain"||state.status!=="ready"||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    const op:StatusOperation={
      controller:new AbortController(),privacyEpoch:privacyEpoch.current,command,
    };
    statusOperation.current=op;
    setAction({kind:"checking"});
    const receipt=await checkMyPlanStatusReceipt(command,fetch,op.controller.signal);
    if(statusOperation.current!==op)return;
    statusOperation.current=null;
    if(op.privacyEpoch!==privacyEpoch.current){
      setAction({kind:"uncertain"});
      return;
    }
    if(receipt.kind==="committed"){
      uncertainCommand.current=null;
      confirmedCommand.current=command;
      setAction({kind:"committed",taskId:command.taskId,
        areaId:command.writeAreaId,status:command.status});
      refreshAfterStatus();
    }else if(receipt.kind==="unknown"&&receipt.reason==="signed-out"){
      uncertainCommand.current=null;
      setAction({kind:"idle"});
      invalidate("signed-out");
    }else setAction({kind:"uncertain"});
  }

  function resetFeedback(){
    uncertainCommand.current=null;
    confirmedCommand.current=null;
    setAction({kind:"idle"});
  }
  const actionPending=action.kind==="pending"||action.kind==="checking"||
    action.kind==="uncertain";
  const canComplete=statusWriteEnabled&&!actionPending;
  async function more(){
    if(statusOperation.current||actionPending||
      moreInFlight.current||state.status!=="ready"||
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
        <input type="date" disabled={actionPending} value={date??""}
          onChange={event=>{
            const chosen=event.target.value;
            if(!validMyPlanDate(chosen))return;
            if(actionPending||statusOperation.current)return;
            resetFeedback();
            setFollowToday(false); // A manual date remains pinned at midnight.
            if(chosen!==date){invalidate("stale",true);setDate(chosen);}
          }}/>
      </label>
      <label>Moje práce
        <select value={areaFilter} disabled={actionPending}
          onChange={event=>{
            if(actionPending||statusOperation.current)return;
            resetFeedback();
            invalidate("stale",true);
            setAreaFilter(event.target.value as MyPlanSliceFilter);
          }}>
          <option value="all">Osobní i přiřazené sdílené</option>
          <option value="personal">Osobní</option>
          <option value="shared">Přiřazené sdílené</option>
        </select>
      </label>
      <button type="button" disabled={actionPending} onClick={()=>{
        if(actionPending||statusOperation.current)return;
        resetFeedback();
        const chosen=localMyPlanDate();
        invalidate("stale",true);
        setFollowToday(true);
        if(chosen===date)setRefresh(n=>n+1);
        else setDate(chosen);
      }}>Aktuální den</button>
      <button type="button" disabled={actionPending} onClick={()=>{
        if(actionPending||statusOperation.current)return;
        resetFeedback();
        invalidate("stale",true);
        setRefresh(n=>n+1);
      }}>Obnovit</button>
    </div>
    {state.status==="loading"&&<p role="status">Načítám aktuální přehled…</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="pending"&&
      <p role="status" className="stagingMyPlanMutation">Ověřuji oprávnění a ukládám změnu…</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="checking"&&
      <p role="status" className="stagingMyPlanMutation">Ověřuji potvrzení předchozí operace…</p>}
    {state.status==="error"&&
      <p role="alert" className="stagingMyPlanWarning">{reasons[state.reason]}</p>}
    {state.status==="ready"&&date&&
      state.page.evaluationDate===date&&state.page.areaFilter===areaFilter&&<>
      {statusWriteEnabled&&action.kind==="uncertain"&&
        <div role="alert" className="stagingMyPlanWarning">
          <p>Výsledek zápisu není potvrzen. Žádná další změna se neodešle automaticky.</p>
          <button type="button" onClick={()=>{void verifyUncertainReceipt();}}>
            Ověřit původní potvrzení
          </button>
        </div>}
      {statusWriteEnabled&&action.kind==="error"&&
        <p role="alert" className="stagingMyPlanWarning">{statusReasons[action.reason]}</p>}
      {statusWriteEnabled&&action.kind==="committed"&&
        <div role="status" className="stagingMyPlanMutation">
          <span>{action.status==="completed"?"Dokončení potvrzeno.":"Obnovení potvrzeno."}</span>
          {action.status==="completed"&&
            <button type="button" onClick={()=>{void changeStatus({
              taskId:action.taskId,areaId:action.areaId,
            },"open");}}>Vrátit dokončení (Undo)</button>}
        </div>}
      {/* During an uncertain write, a read could have raced the commit.
          Never render its potentially stale open-task list until confirmed. */}
      {!actionPending&&<>
      <PlanDay label={followToday?"Dnes a dřívější":"Do vybraného dne včetně"}
        date={date} tasks={state.page.today.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}/>
      <PlanDay label={(followToday?"Zítra · ":"Následující den · ")+
        nextHumanDate(date)}
        date={date} tasks={state.page.tomorrow.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}/>
      {state.page.hasMore&&
        <button disabled={moreBusy} type="button" onClick={()=>{void more();}}>
          {moreBusy?"Načítám…":"Načíst další úkoly"}
        </button>}
      </>}
      <p className="stagingMyPlanScope">{statusWriteEnabled
        ?"Izolované dokončení a Undo používají nové serverové CAS, nikoli offline synchronizaci. Přesun dne zůstává vypnutý."
        :"Náhled je pouze pro čtení: dokončení, přesun a Undo nejsou zapnuté."}
        {" "}Oprávnění se ověřují na serveru při každém načtení.</p>
    </>}
  </main>;
}
