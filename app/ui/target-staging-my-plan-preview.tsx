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
import {canRetryUncertainMyPlanRead} from "../../lib/target-staging-my-plan-status-recovery";
import {myPlanToolbarChangeBlocked} from "../../lib/target-staging-my-plan-toolbar-lock";
import {
  myPlanWhenTarget,prepareMyPlanWhen,dispatchMyPlanWhen,checkMyPlanWhenReceipt,
  type MyPlanWhenCommand,type MyPlanWhenFailure,
} from "../../lib/target-staging-my-plan-when-client";
import {
  prepareConfirmedWhenUndo,keepConfirmedWhenOnRefresh,
  type ConfirmedWhen,
} from "../../lib/target-staging-my-plan-when-undo";
import {
  prepareConfirmedMyPlanUndo,keepConfirmedMyPlanUndoOnRefresh,
} from "../../lib/target-staging-my-plan-undo";

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

type WhenAction=
  |{kind:"idle"|"pending"|"checking"|"uncertain"}
  |{kind:"committed";taskId:string;areaId:string;
    whenOn:string|null;previousWhenOn:string|null;undoable:boolean}
  |{kind:"error";reason:MyPlanWhenFailure};
type WhenOperation={
  controller:AbortController;privacyEpoch:number;command:MyPlanWhenCommand|null;
};
type UncertainWhen={command:MyPlanWhenCommand;previousWhenOn:string|null;undo:boolean};
const whenReasons:Record<MyPlanWhenFailure,string>={
  "signed-out":"Přístup k osobnímu plánu zanikl. Přihlaste se znovu.",
  "stale":"Osobní plán nebo úkol se mezitím změnil. Načetl se aktuální přehled.",
  "unavailable":"Osobní plánování na stagingu není dostupné nebo bylo vypnuto.",
  "invalid-response":"Odpověď plánovacího endpointu nebyla bezpečně ověřena.",
  "invalid-request":"Plánovací požadavek nesplňuje bezpečný kontrakt.",
  "offline":"Spojení selhalo; žádný automatický zápis se neopakuje.",
  "aborted":"Požadavek byl přerušen; stav je nutné znovu ověřit.",
  "unchanged":"Zvolený osobní den už je nastavený.",
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

function PlanDay({label,tasks,date,canComplete,onComplete,canWhen,onWhen}:{
  label:string;tasks:MyPlanSliceTask[];date:string;
  canComplete:boolean;onComplete:(task:MyPlanSliceTask)=>void;
  canWhen:boolean;onWhen:(task:MyPlanSliceTask,whenOn:string)=>void;
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
                  {canWhen&&<div className="stagingMyPlanWhenControls" role="group"
                    aria-label={"Osobní plán pro úkol: "+task.title}>
                    {(["today","tomorrow"] as const).map(choice=>{
                      const target=myPlanWhenTarget(date,choice);
                      return target&&task.whenOn!==target
                        ?<button key={choice} type="button"
                            aria-label={choice==="today"
                              ?"Naplánovat osobně na dnešek: "+task.title
                              :"Naplánovat osobně na zítřek: "+task.title}
                            onClick={()=>onWhen(task,target)}>
                            {choice==="today"?"Kdy: Dnes":"Kdy: Zítra"}
                          </button>:null;
                    })}
                  </div>}
                </div>
              </li>)}</ul>
          </div>)}
      </div>}
  </section>;
}
export function TargetStagingMyPlanPreview({
  statusWriteEnabled=false,whenWriteEnabled=false,
}:{statusWriteEnabled?:boolean;whenWriteEnabled?:boolean}){
  const [date,setDate]=useState<string|null>(null);
  const [followToday,setFollowToday]=useState(true);
  const [areaFilter,setAreaFilter]=useState<MyPlanSliceFilter>("all");
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<ReadState>({status:"loading"});
  const [moreBusy,setMoreBusy]=useState(false);
  const [action,setAction]=useState<StatusAction>({kind:"idle"});
  const [undoFailure,setUndoFailure]=useState<MyPlanStatusFailure|null>(null);
  const [whenAction,setWhenAction]=useState<WhenAction>({kind:"idle"});
  const [whenFailure,setWhenFailure]=useState<MyPlanWhenFailure|null>(null);
  const confirmedWhen=useRef<ConfirmedWhen|null>(null);
  const uncertainWhen=useRef<UncertainWhen|null>(null);
  const whenOperation=useRef<WhenOperation|null>(null);
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
    whenOperation.current?.controller.abort();
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
          confirmedWhen.current=null;
          uncertainWhen.current=null;
          setWhenAction({kind:"idle"});
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
    confirmedWhen.current=null;
    setWhenFailure(null);
    whenOperation.current?.controller.abort();
    setWhenAction(old=>old.kind==="committed"||old.kind==="error"
      ?{kind:"idle"}:old.kind==="checking"?{kind:"uncertain"}:
      old.kind==="pending"
        ?whenOperation.current?.command?{kind:"uncertain"}:{kind:"idle"}:old);
    setUndoFailure(null);
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
    if(!statusWriteEnabled||statusOperation.current||whenOperation.current||
      whenAction.kind==="pending"||whenAction.kind==="checking"||
      whenAction.kind==="uncertain"||
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
    // Switching mutation families is deliberate; never during an unresolved CAS.
    confirmedWhen.current=null;
    uncertainWhen.current=null;
    setWhenAction({kind:"idle"});
    setWhenFailure(null);
    uncertainCommand.current=null;
    // Never discard the original confirmed completion BEFORE a possible Undo.
    // Receipt/preflight/400/409 failures cannot have reversed this task.
    if(!prior)confirmedCommand.current=null;
    setUndoFailure(null);
    setAction({kind:"pending"});
    invalidate("stale",true); // No stale open row during a possible PATCH.

    let command:MyPlanStatusCommand;
    if(prior){
      const undo=await prepareConfirmedMyPlanUndo(
        prior,fetch,op.controller.signal,
      );
      if(statusOperation.current!==op)return;
      if(op.privacyEpoch!==privacyEpoch.current){
        statusOperation.current=null;
        setAction({kind:"idle"});
        return;
      }
      if(undo.kind!=="ready"){
        statusOperation.current=null;
        if(undo.kind==="signed-out"){
          confirmedCommand.current=null;
          setAction({kind:"idle"});
          invalidate("signed-out");
          return;
        }
        // Only read-only work happened, so the original completion is still
        // available for a manual retry after a freshly authorized list GET.
        setUndoFailure(undo.reason);
        setAction({kind:"committed",taskId:prior.taskId,
          areaId:prior.writeAreaId,status:"completed"});
        refreshAfterStatus();
        return;
      }
      command=undo.command; // NEW idempotency key, never a replay of the old PATCH.
    }else{
      const prepared=await prepareMyPlanStatus({
        taskId:task.taskId,areaId:task.areaId,status,
        signal:op.controller.signal,
      });
      if(statusOperation.current!==op)return;
      if(op.privacyEpoch!==privacyEpoch.current){
        statusOperation.current=null;
        setAction({kind:"idle"});
        return;
      }
      if(prepared.ok===false){
        statusOperation.current=null;
        if(prepared.reason==="signed-out"){
          setAction({kind:"idle"});
          invalidate("signed-out");
        }else{
          setAction({kind:"error",reason:prepared.reason});
          refreshAfterStatus();
        }
        return;
      }
      command=prepared.command;
    }

    op.command=command;
    const result=await dispatchMyPlanStatus(command,fetch,op.controller.signal);
    if(statusOperation.current!==op)return;
    statusOperation.current=null;
    if(op.privacyEpoch!==privacyEpoch.current){
      // A privacy transition invalidates prior Undo, including if a PATCH
      // might have committed. Keep only its new command for receipt recovery.
      if(op.command){
        uncertainCommand.current=op.command;
        setAction({kind:"uncertain"});
      }else setAction({kind:"idle"});
      return;
    }
    if(result.kind==="committed"){
      confirmedCommand.current=status==="completed"?result.command:null;
      setAction({kind:"committed",taskId:task.taskId,areaId:task.areaId,status});
    }else if(result.kind==="uncertain"){
      // An Undo PATCH may already have reversed the task: don't offer the
      // previous Undo again until the NEW command's receipt is reconciled.
      confirmedCommand.current=null;
      uncertainCommand.current=result.command;
      setAction({kind:"uncertain"});
    }else if(result.reason==="signed-out"){
      confirmedCommand.current=null;
      uncertainCommand.current=null;
      setAction({kind:"idle"});
      invalidate("signed-out");
      return;
    }else if(prior){
      // Only a definite pre-commit refusal: original Undo remains available.
      setUndoFailure(result.reason);
      setAction({kind:"committed",taskId:prior.taskId,
        areaId:prior.writeAreaId,status:"completed"});
    }else setAction({kind:"error",reason:result.reason});
    refreshAfterStatus();
  }

  /** Actor-private `whenOn`: one explicit operation, never a common dueOn edit.
   * An uncertain command blocks BOTH mutation families until original receipt.
   * The same privacy generation guards status and personal-plan operations. */
  async function changeWhen(
    task:{taskId:string;areaId:string},target:string|null,undo=false,
  ){
    if(!whenWriteEnabled||statusOperation.current||whenOperation.current||
      action.kind==="pending"||action.kind==="checking"||
      action.kind==="uncertain"||
      whenAction.kind==="pending"||whenAction.kind==="checking"||
      whenAction.kind==="uncertain"||state.status!=="ready"||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    const prior=undo?confirmedWhen.current:null;
    if(undo){
      if(!prior||whenAction.kind!=="committed"||!whenAction.undoable||
        prior.command.taskId!==task.taskId||
        prior.command.writeAreaId!==task.areaId||
        prior.previousWhenOn!==target)return;
    }else{
      const row=[...state.page.today.tasks,...state.page.tomorrow.tasks].find(
        item=>item.taskId===task.taskId&&item.areaId===task.areaId);
      const today=date?myPlanWhenTarget(date,"today"):null;
      const tomorrow=date?myPlanWhenTarget(date,"tomorrow"):null;
      // "Dnes/Zítra" is never silently relative to a pinned historical day.
      if(!followToday||date!==localMyPlanDate()||
        !row||target===null||target!==today&&target!==tomorrow||
        row.whenOn===target)return;
    }
    const op:WhenOperation={
      controller:new AbortController(),privacyEpoch:privacyEpoch.current,command:null,
    };
    whenOperation.current=op; // Synchronous cross-family submission lock.
    uncertainWhen.current=null;
    // A confirmed status operation is no longer undoable after this different
    // explicit action; status cannot have been uncertain (guard above).
    uncertainCommand.current=null;
    confirmedCommand.current=null;
    setUndoFailure(null);
    setAction({kind:"idle"});
    setWhenFailure(null);
    setWhenAction({kind:"pending"});
    invalidate("stale",true); // Hide potentially stale rows BEFORE preflight.

    let command:MyPlanWhenCommand;
    let previousWhenOn:string|null;
    if(prior){
      const prepared=await prepareConfirmedWhenUndo(
        prior,fetch,op.controller.signal);
      if(whenOperation.current!==op)return;
      if(op.privacyEpoch!==privacyEpoch.current){
        whenOperation.current=null;
        setWhenAction({kind:"idle"});
        return;
      }
      if(prepared.kind!=="ready"){
        whenOperation.current=null;
        if(prepared.kind==="signed-out"){
          confirmedWhen.current=null;
          setWhenAction({kind:"idle"});
          invalidate("signed-out");
          return;
        }
        setWhenFailure(prepared.reason);
        // No PATCH yet: previous completion of the private plan is intact.
        setWhenAction({kind:"committed",taskId:prior.command.taskId,
          areaId:prior.command.writeAreaId,whenOn:prior.command.whenOn,
          previousWhenOn:prior.previousWhenOn,undoable:true});
        refreshAfterStatus();
        return;
      }
      command=prepared.command;
      previousWhenOn=prior.command.whenOn;
    }else{
      const prepared=await prepareMyPlanWhen({
        taskId:task.taskId,areaId:task.areaId,whenOn:target,
        signal:op.controller.signal,
      },fetch);
      if(whenOperation.current!==op)return;
      if(op.privacyEpoch!==privacyEpoch.current){
        whenOperation.current=null;
        setWhenAction({kind:"idle"});
        return;
      }
      if(prepared.ok===false){
        whenOperation.current=null;
        if(prepared.reason==="signed-out"){
          setWhenAction({kind:"idle"});
          invalidate("signed-out");
        }else{
          setWhenAction({kind:"error",reason:prepared.reason});
          refreshAfterStatus();
        }
        return;
      }
      command=prepared.command;
      previousWhenOn=prepared.previousWhenOn;
    }

    op.command=command;
    const context:UncertainWhen={command,previousWhenOn,undo};
    uncertainWhen.current=context; // In-memory only, before the first PATCH.
    const result=await dispatchMyPlanWhen(command,fetch,op.controller.signal);
    if(whenOperation.current!==op)return;
    whenOperation.current=null;
    if(op.privacyEpoch!==privacyEpoch.current){
      // A possible commit across identity loss is ALWAYS uncertain, even if
      // a stale network response says success. No old actor's Undo is offered.
      confirmedWhen.current=null;
      setWhenAction({kind:"uncertain"});
      return;
    }
    if(result.kind==="committed"){
      uncertainWhen.current=null;
      confirmedWhen.current=undo?null:{command,previousWhenOn};
      setWhenAction({kind:"committed",taskId:task.taskId,
        areaId:task.areaId,whenOn:command.whenOn,
        previousWhenOn,undoable:!undo});
    }else if(result.kind==="uncertain"){
      confirmedWhen.current=null;
      setWhenAction({kind:"uncertain"});
    }else if(prior){
      // Only a definite 400/409 PRE-COMMIT rejection can retain original Undo.
      uncertainWhen.current=null;
      setWhenFailure(result.reason);
      setWhenAction({kind:"committed",taskId:prior.command.taskId,
        areaId:prior.command.writeAreaId,whenOn:prior.command.whenOn,
        previousWhenOn:prior.previousWhenOn,undoable:true});
    }else{
      uncertainWhen.current=null;
      setWhenAction({kind:"error",reason:result.reason});
    }
    refreshAfterStatus(); // Always fresh actor/ACL/private epoch list GET.
  }

  /** Manual receipt lookup ONLY, for the original exact eight-field CAS.
   * No automatic PATCH on `not_recorded` or transient failures. */
  async function verifyUncertainWhenReceipt(){
    const original=uncertainWhen.current;
    if(!whenWriteEnabled||!original||whenOperation.current||
      statusOperation.current||action.kind==="pending"||
      action.kind==="checking"||action.kind==="uncertain"||
      whenAction.kind!=="uncertain"||state.status!=="ready"||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    const op:WhenOperation={
      controller:new AbortController(),privacyEpoch:privacyEpoch.current,
      command:original.command,
    };
    whenOperation.current=op;
    setWhenAction({kind:"checking"});
    const receipt=await checkMyPlanWhenReceipt(
      original.command,fetch,op.controller.signal);
    if(whenOperation.current!==op)return;
    whenOperation.current=null;
    if(op.privacyEpoch!==privacyEpoch.current){
      setWhenAction({kind:"uncertain"});
      return;
    }
    if(receipt.kind==="committed"){
      uncertainWhen.current=null;
      confirmedWhen.current=original.undo?null:{
        command:original.command,previousWhenOn:original.previousWhenOn,
      };
      setWhenAction({kind:"committed",taskId:original.command.taskId,
        areaId:original.command.writeAreaId,
        whenOn:original.command.whenOn,
        previousWhenOn:original.previousWhenOn,
        undoable:!original.undo});
      refreshAfterStatus();
    }else if(receipt.kind==="unknown"&&receipt.reason==="signed-out"){
      uncertainWhen.current=null;
      confirmedWhen.current=null;
      setWhenAction({kind:"idle"});
      invalidate("signed-out");
    }else setWhenAction({kind:"uncertain"});
  }

  /** When the list GET fails after a possibly committed whenOn PATCH,
   * reauthorize just the list first. Keep the original command for receipt. */
  function retryUncertainWhenRead(){
    if(!whenWriteEnabled||whenAction.kind!=="uncertain"||
      state.status!=="error"||state.reason==="signed-out"||
      !uncertainWhen.current||statusOperation.current||whenOperation.current||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    invalidate("stale",true);
    setRefresh(n=>n+1);
  }

  /** Manually recheck only the ORIGINAL command; never resend PATCH. */
  async function verifyUncertainReceipt(){
    const command=uncertainCommand.current;
    if(!statusWriteEnabled||!command||statusOperation.current||
      whenOperation.current||
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

  /** Escape hatch when the fresh ACL-checked list read fails after a PATCH.
   * Preserve the original command, prevent new mutations, and retry ONLY GET.
   * The existing fetch effect will reauthorize the current session and Area
   * before the separate receipt-only button can be shown again. */
  function retryUncertainRead(){
    if(!canRetryUncertainMyPlanRead({
      statusWriteEnabled,actionKind:action.kind,readStatus:state.status,
      hasOriginalCommand:uncertainCommand.current!==null,
      operationInFlight:statusOperation.current!==null,
      visible:document.visibilityState==="visible",online:navigator.onLine,
    }))return;
    invalidate("stale",true);
    setRefresh(n=>n+1);
  }

  /** Explicit GET-only refresh: preserve a confirmed Undo through
   * temporary slice failures. Context changes still call resetFeedback().
   * The list GET enforces current actor/ACL and clears old data on 401/403. */
  function refreshPlan(){
    if(statusOperation.current||whenOperation.current||
      whenAction.kind==="pending"||whenAction.kind==="checking"||
      whenAction.kind==="uncertain"||
      action.kind==="pending"||
      action.kind==="checking"||action.kind==="uncertain"||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    if(!keepConfirmedMyPlanUndoOnRefresh(action,confirmedCommand.current)){
      uncertainCommand.current=null;
      confirmedCommand.current=null;
      setUndoFailure(null);
      setAction({kind:"idle"});
    }
    if(!keepConfirmedWhenOnRefresh(whenAction,confirmedWhen.current)){
      uncertainWhen.current=null;
      confirmedWhen.current=null;
      setWhenFailure(null);
      setWhenAction({kind:"idle"});
    }
    invalidate("stale",true);
    setRefresh(n=>n+1);
  }

  function resetFeedback(){
    uncertainCommand.current=null;
    confirmedCommand.current=null;
    setUndoFailure(null);
    setAction({kind:"idle"});
    uncertainWhen.current=null;
    confirmedWhen.current=null;
    setWhenFailure(null);
    setWhenAction({kind:"idle"});
  }
  const actionPending=action.kind==="pending"||action.kind==="checking"||
    action.kind==="uncertain";
  const whenPending=whenAction.kind==="pending"||
    whenAction.kind==="checking"||whenAction.kind==="uncertain";
  const anyPending=actionPending||whenPending;
  // Read the live synchronous refs from EACH handler, not just disabled state.
  // A second event may arrive before React commits the pending render.
  const toolbarChangeBlocked=()=>myPlanToolbarChangeBlocked({
    anyPending,statusInFlight:statusOperation.current!==null,
    whenInFlight:whenOperation.current!==null,
  });
  const canComplete=statusWriteEnabled&&!anyPending;
  const canWhen=whenWriteEnabled&&!anyPending&&
    followToday&&date!==null&&date===localMyPlanDate();
  async function more(){
    if(statusOperation.current||whenOperation.current||anyPending||
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
      <p>{whenWriteEnabled
        ?"Izolovaný stagingový Můj plán: osobní Kdy Dnes/Zítra s novým CAS a bezpečným Undo. Bez offline fronty a změn společných termínů."
        :statusWriteEnabled
          ?"Izolovaný stagingový náhled s dokončením a bezpečným Undo. Bez kalendářových událostí, přesunu dne a offline fronty."
          :"Čtecí náhled cílového modelu. Jen úkoly; bez úprav, kalendářových událostí a offline ukládání."}</p>
    </header>
    <div className="stagingMyPlanToolbar">
      <label>Den
        <input type="date" disabled={anyPending} value={date??""}
          onChange={event=>{
            const chosen=event.target.value;
            if(!validMyPlanDate(chosen))return;
            if(toolbarChangeBlocked())return;
            resetFeedback();
            setFollowToday(false); // A manual date remains pinned at midnight.
            if(chosen!==date){invalidate("stale",true);setDate(chosen);}
          }}/>
      </label>
      <label>Moje práce
        <select value={areaFilter} disabled={anyPending}
          onChange={event=>{
            if(toolbarChangeBlocked())return;
            resetFeedback();
            invalidate("stale",true);
            setAreaFilter(event.target.value as MyPlanSliceFilter);
          }}>
          <option value="all">Osobní i přiřazené sdílené</option>
          <option value="personal">Osobní</option>
          <option value="shared">Přiřazené sdílené</option>
        </select>
      </label>
      <button type="button" disabled={anyPending} onClick={()=>{
        if(toolbarChangeBlocked())return;
        resetFeedback();
        const chosen=localMyPlanDate();
        invalidate("stale",true);
        setFollowToday(true);
        if(chosen===date)setRefresh(n=>n+1);
        else setDate(chosen);
      }}>Aktuální den</button>
      <button type="button" disabled={anyPending}
        onClick={refreshPlan}>Obnovit</button>
    </div>
    {state.status==="loading"&&<p role="status">Načítám aktuální přehled…</p>}
    {whenWriteEnabled&&whenAction.kind==="pending"&&
      <p role="status" className="stagingMyPlanMutation">Ověřuji osobní plán a ukládám změnu…</p>}
    {whenWriteEnabled&&whenAction.kind==="checking"&&
      <p role="status" className="stagingMyPlanMutation">Kontroluji původní potvrzení plánování…</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="pending"&&
      <p role="status" className="stagingMyPlanMutation">Ověřuji oprávnění a ukládám změnu…</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="checking"&&
      <p role="status" className="stagingMyPlanMutation">Ověřuji potvrzení předchozí operace…</p>}
    {state.status==="error"&&
      <p role="alert" className="stagingMyPlanWarning">{reasons[state.reason]}</p>}
    {statusWriteEnabled&&state.status==="error"&&
      state.reason!=="signed-out"&&action.kind==="committed"&&
      action.status==="completed"&&confirmedCommand.current!==null&&
      <div className="stagingMyPlanWarning" role="status">
        <p>Dokončení je potvrzené. Načtení přehledu selhalo;
          po novém ověření oprávnění bude možné Undo.</p>
        <button type="button" onClick={refreshPlan}>
          Znovu načíst přehled (Undo zůstane)
        </button>
      </div>}
    {whenWriteEnabled&&state.status==="error"&&
      state.reason!=="signed-out"&&whenAction.kind==="committed"&&
      whenAction.undoable&&confirmedWhen.current!==null&&
      <div role="status" className="stagingMyPlanWarning">
        <p>Osobní plán je potvrzený, ale načtení přehledu selhalo.
          Undo bude dostupné po novém ověření oprávnění.</p>
        <button type="button" onClick={refreshPlan}>
          Znovu načíst osobní plán (Undo zůstane)
        </button>
      </div>}
    {whenWriteEnabled&&whenAction.kind==="uncertain"&&
      state.status==="error"&&state.reason!=="signed-out"&&
      uncertainWhen.current!==null&&
      <div role="alert" className="stagingMyPlanWarning">
        <p>Výsledek osobního plánování je nejistý.
          Znovu se načte pouze autorizovaný přehled, nikoli zápis.</p>
        <button type="button" onClick={retryUncertainWhenRead}>
          Znovu ověřit osobní přehled (bez zápisu)
        </button>
      </div>}
    {statusWriteEnabled&&action.kind==="uncertain"&&
      state.status==="error"&&state.reason!=="signed-out"&&
      uncertainCommand.current!==null&&
      <div role="alert" className="stagingMyPlanWarning">
        <p>Výsledek předchozího zápisu není potvrzen. Obnovení přehledu
          provede pouze nové autorizované čtení, nikdy další zápis.</p>
        <button type="button" onClick={retryUncertainRead}>
          Znovu ověřit přehled (bez zápisu)
        </button>
      </div>}
    {state.status==="ready"&&date&&
      state.page.evaluationDate===date&&state.page.areaFilter===areaFilter&&<>
      {whenWriteEnabled&&whenAction.kind==="uncertain"&&
        <div role="alert" className="stagingMyPlanWarning">
          <p>Předchozí osobní zápis nebyl potvrzen.
            Další změny jsou zablokované; žádný PATCH se neopakuje.</p>
          <button type="button" onClick={()=>{void verifyUncertainWhenReceipt();}}>
            Ověřit původní osobní potvrzení
          </button>
        </div>}
      {whenWriteEnabled&&whenAction.kind==="error"&&
        <p role="alert" className="stagingMyPlanWarning">
          {whenReasons[whenAction.reason]}
        </p>}
      {whenWriteEnabled&&whenAction.kind==="committed"&&
        <div role="status" className="stagingMyPlanMutation">
          <span>Osobní plán potvrzen: {whenAction.whenOn
            ?humanDate(whenAction.whenOn):"bez plánovaného dne"}.</span>
          {whenFailure&&<span role="alert">Undo nebylo provedeno:
            {" "+whenReasons[whenFailure]} Původní plán zůstává potvrzený.</span>}
          {whenAction.undoable&&
            <button type="button" onClick={()=>{void changeWhen({
              taskId:whenAction.taskId,areaId:whenAction.areaId,
            },whenAction.previousWhenOn,true);}}>Vrátit osobní plán (Undo)</button>}
        </div>}
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
          {action.status==="completed"&&undoFailure&&
            <span role="alert">Undo nebylo provedeno: {statusReasons[undoFailure]}
              Původní dokončení zůstává potvrzené; Undo můžete zkusit znovu.</span>}
          {action.status==="completed"&&
            <button type="button" onClick={()=>{void changeStatus({
              taskId:action.taskId,areaId:action.areaId,
            },"open");}}>Vrátit dokončení (Undo)</button>}
        </div>}
      {/* During an uncertain write, a read could have raced the commit.
          Never render its potentially stale open-task list until confirmed. */}
      {!anyPending&&<>
      <PlanDay label={followToday?"Dnes a dřívější":"Do vybraného dne včetně"}
        date={date} tasks={state.page.today.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}
        canWhen={canWhen} onWhen={(task,on)=>{void changeWhen(task,on);}}/>
      <PlanDay label={(followToday?"Zítra · ":"Následující den · ")+
        nextHumanDate(date)}
        date={date} tasks={state.page.tomorrow.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}
        canWhen={canWhen} onWhen={(task,on)=>{void changeWhen(task,on);}}/>
      {state.page.hasMore&&
        <button disabled={moreBusy||anyPending} type="button" onClick={()=>{void more();}}>
          {moreBusy?"Načítám…":"Načíst další úkoly"}
        </button>}
      </>}
      <p className="stagingMyPlanScope">{whenWriteEnabled
        ?"Osobní Kdy mění jen plán aktuálního uživatele, nikdy společný termín dueOn. Každý zápis vyžaduje nový CAS; žádná offline fronta."
        :statusWriteEnabled
          ?"Izolované dokončení a Undo používají nové serverové CAS, nikoli offline synchronizaci. Přesun dne zůstává vypnutý."
          :"Náhled je pouze pro čtení: dokončení, přesun a Undo nejsou zapnuté."}
        {" "}Oprávnění se ověřují na serveru při každém načtení.</p>
    </>}
  </main>;
}
