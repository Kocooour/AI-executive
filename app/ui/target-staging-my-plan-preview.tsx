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
import {supersedesCrossFamilyUndo} from "../../lib/target-staging-my-plan-cross-family-undo";
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
import {scopeFeedbackDecision} from "../../lib/target-my-plan-scope-feedback";
import {myPlanCopy,type MyPlanCopy,type MyPlanLanguage} from "../../lib/target-my-plan-copy";

type StatusAction=
  |{kind:"idle"}
  |{kind:"pending"|"checking"|"uncertain"}
  |{kind:"committed";taskId:string;areaId:string;status:MyPlanStatus}
  |{kind:"error";reason:MyPlanStatusFailure};
type StatusOperation={
  controller:AbortController;privacyEpoch:number;command:MyPlanStatusCommand|null;
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

type ReadState=
  |{status:"loading"}
  |{status:"error";reason:MyPlanReadFailure}
  |{status:"ready";page:MyPlanSlicePage};

const humanDate=(day:string,locale="cs-CZ")=>new Intl.DateTimeFormat(locale,{
  day:"numeric",month:"long",year:"numeric",
}).format(new Date(day+"T12:00:00"));
const nextHumanDate=(day:string,locale="cs-CZ")=>{
  const following=new Date(day+"T12:00:00.000Z");
  following.setUTCDate(following.getUTCDate()+1);
  return humanDate(following.toISOString().slice(0,10),locale);
};

function PlanDay({label,tasks,date,canComplete,onComplete,canWhen,onWhen,copy}:{
  copy:MyPlanCopy;label:string;tasks:MyPlanSliceTask[];date:string;
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
      ?<p className="stagingMyPlanEmpty">{copy.dayEmpty}</p>
      :<div className="stagingMyPlanGroups">
        {[...areas].map(([id,group])=>
          <div className="stagingMyPlanArea" data-area-kind={group.kind}
            aria-label={group.kind==="private"?copy.areaPrivate:copy.areaShared}
            role="group" key={id}>
            <ul>{group.tasks.map(task=>
              <li key={task.taskId}>
                {canComplete
                  ?<button type="button" className="stagingMyPlanSquare stagingMyPlanComplete"
                    aria-label={copy.completeTask(task.title)}
                    onClick={()=>onComplete(task)}/>
                  :<span className="stagingMyPlanSquare" aria-hidden="true"/>}
                <div className="stagingMyPlanTask">
                  <strong>{task.title}</strong>
                  {task.attentionOn<date&&
                    <small>{copy.attentionSince(humanDate(task.attentionOn,copy.locale))}</small>}
                  {task.dueOn&&<small>{copy.dueOn(humanDate(task.dueOn,copy.locale))}</small>}
                  {task.whenOn&&<small>{copy.plannedOn(humanDate(task.whenOn,copy.locale))}</small>}
                  {canWhen&&<div className="stagingMyPlanWhenControls" role="group"
                    aria-label={copy.whenGroup(task.title)}>
                    {(["today","tomorrow"] as const).map(choice=>{
                      const target=myPlanWhenTarget(date,choice);
                      return target&&task.whenOn!==target
                        ?<button key={choice} type="button"
                            aria-label={choice==="today"
                              ?copy.whenTodayAria(task.title)
                              :copy.whenTomorrowAria(task.title)}
                            onClick={()=>onWhen(task,target)}>
                            {choice==="today"?copy.whenToday:copy.whenTomorrow}
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
  statusWriteEnabled=false,whenWriteEnabled=false,embedded=false,onRefusal,
  language="cs",areaFilter:controlledFilter,
}:{
  /** R3-FE-3: when given, the global scope (Vše / Osobní / Sdílené) owns the
   * area filter: the plan's own toolbar filter is hidden and this value is used. */
  areaFilter?:MyPlanSliceFilter;
  statusWriteEnabled?:boolean;whenWriteEnabled?:boolean;
  /** R3-FE-2: rendered inside the main app (its <main>/<h1> own the page). */
  embedded?:boolean;
  /** R3-FE-2: called when a read or write ended signed-out (401/403). */
  onRefusal?:()=>void;
  /** R3-FE-2b: copy and date language; the standalone page keeps Czech. */
  language?:MyPlanLanguage;
}){
  const copy=myPlanCopy[language];
  const statusReasons=copy.statusReasons;
  const whenReasons=copy.whenReasons;
  const reasons=copy.readReasons;
  const [date,setDate]=useState<string|null>(null);
  const [followToday,setFollowToday]=useState(true);
  const [ownFilter,setAreaFilter]=useState<MyPlanSliceFilter>("all");
  const areaFilter=controlledFilter??ownFilter;
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

  const refusalRef=useRef(onRefusal);
  refusalRef.current=onRefusal;
  // Every 401/403 from a read or write ends in a signed-out read state.
  useEffect(()=>{
    if(state.status==="error"&&state.reason==="signed-out")refusalRef.current?.();
  },[state]);

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
    // A second action of the SAME family must not discard an earlier committed
    // Undo if its new read-only preflight (or definite PATCH refusal) fails.
    const retainedStatusUndo=prior??(status==="completed"&&
      keepConfirmedMyPlanUndoOnRefresh(action,confirmedCommand.current)
        ?confirmedCommand.current:null);
    const restoreStatusUndoOnFailure=(reason:MyPlanStatusFailure)=>{
      if(retainedStatusUndo){
        setUndoFailure(reason);
        setAction({kind:"committed",taskId:retainedStatusUndo.taskId,
          areaId:retainedStatusUndo.writeAreaId,status:"completed"});
      }else setAction({kind:"error",reason});
    };
    const op:StatusOperation={
      controller:new AbortController(),privacyEpoch:privacyEpoch.current,command:null,
    };
    statusOperation.current=op; // Synchronous mutex against double clicks.
    // Do not erase the previously confirmed personal-plan Undo before a status
    // PATCH: a failed read-only preflight must leave it recoverable.
    uncertainCommand.current=null;
    // Preserve the prior confirmed command until an accepted or uncertain
    // PATCH supersedes it. Read-only failures never erase the Undo.
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
          confirmedWhen.current=null;
          uncertainWhen.current=null;
          setWhenFailure(null);
          setWhenAction({kind:"idle"});
          setAction({kind:"idle"});
          invalidate("signed-out");
          return;
        }
        // Only read-only work happened; the original confirmed Undo survives.
        restoreStatusUndoOnFailure(undo.reason);
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
          confirmedCommand.current=null;
          confirmedWhen.current=null;
          uncertainWhen.current=null;
          setWhenFailure(null);
          setWhenAction({kind:"idle"});
          setAction({kind:"idle"});
          invalidate("signed-out");
        }else{
          restoreStatusUndoOnFailure(prepared.reason);
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
    if(supersedesCrossFamilyUndo(result.kind)){
      // Neither read-only preflight nor definitive PATCH refusal can discard
      // the previously confirmed private-plan Undo.
      confirmedWhen.current=null;
      uncertainWhen.current=null;
      setWhenAction({kind:"idle"});
      setWhenFailure(null);
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
      confirmedWhen.current=null;
      uncertainWhen.current=null;
      setWhenFailure(null);
      setWhenAction({kind:"idle"});
      setAction({kind:"idle"});
      invalidate("signed-out");
      return;
    }else{
      // A definite 400/409 did not write B; keep any confirmed A Undo.
      restoreStatusUndoOnFailure(result.reason);
    }
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
    const retainedWhenUndo=prior??(!undo&&
      keepConfirmedWhenOnRefresh(whenAction,confirmedWhen.current)
        ?confirmedWhen.current:null);
    const restoreWhenUndoOnFailure=(reason:MyPlanWhenFailure)=>{
      if(retainedWhenUndo){
        setWhenFailure(reason);
        setWhenAction({kind:"committed",taskId:retainedWhenUndo.command.taskId,
          areaId:retainedWhenUndo.command.writeAreaId,
          whenOn:retainedWhenUndo.command.whenOn,
          previousWhenOn:retainedWhenUndo.previousWhenOn,undoable:true});
      }else setWhenAction({kind:"error",reason});
    };
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
    // Keep a confirmed status Undo while the new whenOn request performs only
    // read-only receipt/preflight. Supersede it on accepted/uncertain PATCH.
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
          confirmedCommand.current=null;
          uncertainCommand.current=null;
          setUndoFailure(null);
          setAction({kind:"idle"});
          setWhenAction({kind:"idle"});
          invalidate("signed-out");
          return;
        }
        // A failed read-only receipt/CAS cannot invalidate the earlier Undo.
        restoreWhenUndoOnFailure(prepared.reason);
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
          confirmedWhen.current=null;
          confirmedCommand.current=null;
          uncertainCommand.current=null;
          setUndoFailure(null);
          setAction({kind:"idle"});
          setWhenAction({kind:"idle"});
          invalidate("signed-out");
        }else{
          restoreWhenUndoOnFailure(prepared.reason);
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
    if(supersedesCrossFamilyUndo(result.kind)){
      // Previous status Undo remains until this different command actually
      // commits or might have committed. A definite 400/409 retains it.
      confirmedCommand.current=null;
      uncertainCommand.current=null;
      setUndoFailure(null);
      setAction({kind:"idle"});
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
    }else{
      // A definite 400/409 refused B; A's confirmed Undo remains valid.
      uncertainWhen.current=null;
      restoreWhenUndoOnFailure(result.reason);
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
  // R3-FE-3: feedback (Undo, receipts) of a previous scope is cleared once no
  // write is in flight; an uncertain command is never dropped (see the helper).
  const feedbackScope=useRef<string|null>(null);
  useEffect(()=>{
    const decision=scopeFeedbackDecision({
      recorded:feedbackScope.current,current:areaFilter,
      statusKind:action.kind,whenKind:whenAction.kind,
    });
    feedbackScope.current=decision.recorded;
    if(decision.clear)resetFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[areaFilter,action.kind,whenAction.kind]);
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
  const Root=embedded?"section":"main";
  return <Root className={embedded?"stagingMyPlanPreview stagingMyPlanEmbedded":"stagingMyPlanPreview"}
    data-testid={embedded?"target-my-plan":undefined}
    aria-label={embedded?copy.regionLabel:undefined}>
    {!embedded&&<header>
      <p className="stagingMyPlanEyebrow">{copy.eyebrow}</p>
      <h1>{copy.heading}</h1>
      <p>{whenWriteEnabled
        ?copy.headerWhen
        :statusWriteEnabled
          ?copy.headerStatus
          :copy.headerReadOnly}</p>
    </header>}
    <div className="stagingMyPlanToolbar">
      <label>{copy.toolbarDay}
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
      {controlledFilter===undefined&&<label>{copy.toolbarWork}
        <select value={areaFilter} disabled={anyPending}
          onChange={event=>{
            if(toolbarChangeBlocked())return;
            resetFeedback();
            invalidate("stale",true);
            setAreaFilter(event.target.value as MyPlanSliceFilter);
          }}>
          <option value="all">{copy.filterAll}</option>
          <option value="personal">{copy.filterPersonal}</option>
          <option value="shared">{copy.filterShared}</option>
        </select>
      </label>}
      <button type="button" disabled={anyPending} onClick={()=>{
        if(toolbarChangeBlocked())return;
        resetFeedback();
        const chosen=localMyPlanDate();
        invalidate("stale",true);
        setFollowToday(true);
        if(chosen===date)setRefresh(n=>n+1);
        else setDate(chosen);
      }}>{copy.currentDay}</button>
      <button type="button" disabled={anyPending}
        onClick={refreshPlan}>{copy.refresh}</button>
    </div>
    {state.status==="loading"&&<p role="status">{copy.loading}</p>}
    {whenWriteEnabled&&whenAction.kind==="pending"&&
      <p role="status" className="stagingMyPlanMutation">{copy.whenPending}</p>}
    {whenWriteEnabled&&whenAction.kind==="checking"&&
      <p role="status" className="stagingMyPlanMutation">{copy.whenChecking}</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="pending"&&
      <p role="status" className="stagingMyPlanMutation">{copy.statusPending}</p>}
    {statusWriteEnabled&&state.status!=="error"&&action.kind==="checking"&&
      <p role="status" className="stagingMyPlanMutation">{copy.statusChecking}</p>}
    {state.status==="error"&&
      <p role="alert" className="stagingMyPlanWarning">{reasons[state.reason]}</p>}
    {statusWriteEnabled&&state.status==="error"&&
      state.reason!=="signed-out"&&action.kind==="committed"&&
      action.status==="completed"&&confirmedCommand.current!==null&&
      <div className="stagingMyPlanWarning" role="status">
        <p>{copy.completedReadFailed}</p>
        <button type="button" onClick={refreshPlan}>
          {copy.completedReloadButton}
        </button>
      </div>}
    {whenWriteEnabled&&state.status==="error"&&
      state.reason!=="signed-out"&&whenAction.kind==="committed"&&
      whenAction.undoable&&confirmedWhen.current!==null&&
      <div role="status" className="stagingMyPlanWarning">
        <p>{copy.whenReadFailed}</p>
        <button type="button" onClick={refreshPlan}>
          {copy.whenReloadButton}
        </button>
      </div>}
    {whenWriteEnabled&&whenAction.kind==="uncertain"&&
      state.status==="error"&&state.reason!=="signed-out"&&
      uncertainWhen.current!==null&&
      <div role="alert" className="stagingMyPlanWarning">
        <p>{copy.whenUncertainRead}</p>
        <button type="button" onClick={retryUncertainWhenRead}>
          {copy.whenUncertainReadButton}
        </button>
      </div>}
    {statusWriteEnabled&&action.kind==="uncertain"&&
      state.status==="error"&&state.reason!=="signed-out"&&
      uncertainCommand.current!==null&&
      <div role="alert" className="stagingMyPlanWarning">
        <p>{copy.statusUncertainRead}</p>
        <button type="button" onClick={retryUncertainRead}>
          {copy.statusUncertainReadButton}
        </button>
      </div>}
    {state.status==="ready"&&date&&
      state.page.evaluationDate===date&&state.page.areaFilter===areaFilter&&<>
      {whenWriteEnabled&&whenAction.kind==="uncertain"&&
        <div role="alert" className="stagingMyPlanWarning">
          <p>{copy.whenUncertain}</p>
          <button type="button" onClick={()=>{void verifyUncertainWhenReceipt();}}>
            {copy.whenUncertainButton}
          </button>
        </div>}
      {whenWriteEnabled&&whenAction.kind==="error"&&
        <p role="alert" className="stagingMyPlanWarning">
          {whenReasons[whenAction.reason]}
        </p>}
      {whenWriteEnabled&&!anyPending&&whenAction.kind==="committed"&&
        <div role="status" className="stagingMyPlanMutation">
          <span>{copy.whenConfirmed(whenAction.whenOn?humanDate(whenAction.whenOn,copy.locale):null)}</span>
          {whenFailure&&<span role="alert">{copy.newChangeNotMade}
            {" "+whenReasons[whenFailure]+" "+copy.whenKept}</span>}
          {whenAction.undoable&&
            <button type="button" onClick={()=>{void changeWhen({
              taskId:whenAction.taskId,areaId:whenAction.areaId,
            },whenAction.previousWhenOn,true);}}>{copy.whenUndo}</button>}
        </div>}
      {statusWriteEnabled&&action.kind==="uncertain"&&
        <div role="alert" className="stagingMyPlanWarning">
          <p>{copy.statusUncertain}</p>
          <button type="button" onClick={()=>{void verifyUncertainReceipt();}}>
            {copy.statusUncertainButton}
          </button>
        </div>}
      {statusWriteEnabled&&action.kind==="error"&&
        <p role="alert" className="stagingMyPlanWarning">{statusReasons[action.reason]}</p>}
      {statusWriteEnabled&&!anyPending&&action.kind==="committed"&&
        <div role="status" className="stagingMyPlanMutation">
          <span>{action.status==="completed"?copy.completedConfirmed:copy.restoredConfirmed}</span>
          {action.status==="completed"&&undoFailure&&
            <span role="alert">{copy.newChangeNotMade} {statusReasons[undoFailure]+" "+copy.statusKept}</span>}
          {action.status==="completed"&&
            <button type="button" onClick={()=>{void changeStatus({
              taskId:action.taskId,areaId:action.areaId,
            },"open");}}>{copy.statusUndo}</button>}
        </div>}
      {/* During an uncertain write, a read could have raced the commit.
          Never render its potentially stale open-task list until confirmed. */}
      {!anyPending&&<>
      <PlanDay copy={copy} label={followToday?copy.dayTodayAndEarlier:copy.dayUpToSelected}
        date={date} tasks={state.page.today.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}
        canWhen={canWhen} onWhen={(task,on)=>{void changeWhen(task,on);}}/>
      <PlanDay copy={copy} label={(followToday?copy.dayTomorrowPrefix:copy.dayNextPrefix)+
        nextHumanDate(date,copy.locale)}
        date={date} tasks={state.page.tomorrow.tasks}
        canComplete={canComplete} onComplete={task=>{void changeStatus(task,"completed");}}
        canWhen={canWhen} onWhen={(task,on)=>{void changeWhen(task,on);}}/>
      {state.page.hasMore&&
        <button disabled={moreBusy||anyPending} type="button" onClick={()=>{void more();}}>
          {moreBusy?copy.moreBusy:copy.more}
        </button>}
      </>}
      <p className="stagingMyPlanScope">{whenWriteEnabled
        ?copy.scopeWhen
        :statusWriteEnabled
          ?copy.scopeStatus
          :copy.scopeReadOnly}
        {" "}{copy.scopeServer}</p>
    </>}
  </Root>;
}
