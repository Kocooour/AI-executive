"use client";
/** C-3a: authorized, fail-closed Inbox with Process/Undo receipt reconciliation. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {targetOverviewGate} from "../../lib/target-my-plan-embed";
import {emitTargetChange,subscribeTargetChange,subscribeInboxDecision,inboxDecisionSnapshot,
  setInboxDecision,clearInboxDecision,restoreInboxDecision,markInboxRefused,
  clearInboxRefusedAfterSession,inboxRefused,subscribeInboxSecurity,
  inboxSecurityVersion,type InboxDecision} from "../../lib/target-data-invalidation";
import {detailIdOk} from "../../lib/target-detail-route";
import {detailRowKey,openTargetDetail} from "./target-detail-state";
import {inboxUncertainSnapshot,subscribeInboxUncertain,setInboxUncertain}
  from "../../lib/target-data-invalidation";
import {refusalBudgetFor} from "../../lib/target-refusal-budget";
import {
  fetchTargetInbox,sendInboxCommand,verifyInboxCommand,cancelInboxCommand,
  issueInboxClientCommandId,
  type InboxClientCommand,type InboxClientPage,type InboxClientFailure,
} from "../../lib/target-inbox-client";
import type {TargetInboxItem} from "../../lib/target-inbox-client-types";
import TargetInboxC3b,{type C3bOutcome} from "./target-inbox-c3b";
import {acceptC3b,undoC3b,receiptC3b,cancelC3b,persistC3bRecovery,readC3bRecovery,
  type C3bUndo,type C3bReceiptQuery,type C3bAccept}
  from "../../lib/target-inbox-c3b-client";
import "./target-inbox.css";

type Language="cs"|"en";
type State={kind:"loading";key:string}|{kind:"error";key:string;reason:InboxClientFailure}|
  {kind:"ready";key:string;page:InboxClientPage};
function useInbox(limit:number){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const subscribe=useMemo(
    ()=>(fn:()=>void)=>runtime?runtime.subscribeOutcome(fn):()=>{},[runtime]);
  const outcome=useSyncExternalStore(subscribe,
    ()=>runtime?runtime.lastOutcome():null,()=>null);
  const securityEpoch=useSyncExternalStore(subscribeInboxSecurity,
    inboxSecurityVersion,()=>0);
  const blocked=inboxRefused(runtime,generation);
  const [refresh,setRefresh]=useState(0);
  const [hidden,setHidden]=useState(false);
  const [state,setState]=useState<State>({kind:"loading",key:""});
  const abort=useRef<AbortController|null>(null);
  const more=useRef<AbortController|null>(null);
  const reload=useCallback(()=>setRefresh(n=>n+1),[]);
  const retry=useCallback(async()=>{
    // Explicitly revalidate before showing a formerly hidden actor's data.
    // Reload alone is insufficient when a prior 401/503 left hidden=true.
    if(!runtime)return;
    const result=await runtime.refresh();
    if(result==="ok"&&runtime.known()&&runtime.generation()===generation){
      clearInboxRefusedAfterSession(runtime,generation);
      setHidden(false);
      reload();
    }
  },[runtime,generation,reload]);
  const gate=targetOverviewGate(runtime,generation,outcome);
  const key=generation+":"+limit+":"+refresh+":"+securityEpoch;
  useTargetTick(()=>{
    // A passive tick follows a successful, fresh server session check.
    if(runtime?.known()&&runtime.generation()===generation)
      clearInboxRefusedAfterSession(runtime,generation);
    reload();
  });
  useEffect(()=>subscribeTargetChange(reload),[reload]);
  const {markHidden}=useTargetWake({
    hide(){abort.current?.abort();more.current?.abort();setHidden(true);
      setState({kind:"error",key,reason:"unavailable"});},
    ready(result){
      if(result==="ok"&&runtime?.known()&&runtime.generation()===generation)
        clearInboxRefusedAfterSession(runtime,generation);
      setHidden(false);reload();
    },
    signedOut(){abort.current?.abort();more.current?.abort();setHidden(true);
      setState({kind:"error",key,reason:"signed-out"});},
  });

  // Revocations must also arm the wake machine. Setting React's hidden
  // state alone does not mark it hidden, so an online event could never
  // trigger a fresh session check and a new authorized Inbox read.
  const revoke=useCallback(()=>{
    abort.current?.abort();more.current?.abort();
    markHidden();
    setHidden(true);
    if(runtime)markInboxRefused(runtime,generation);
    setState({kind:"error",key:"",reason:"signed-out"});
    if(runtime&&refusalBudgetFor(runtime).admit())
      void runtime.reportRefusal("session_revoked");
  },[runtime,generation,markHidden]);
  useEffect(()=>{
    if(gate.kind!=="ready"||hidden||blocked){
      abort.current?.abort();more.current?.abort();
      setState({kind:"error",key,reason:gate.kind==="signed_out"?"signed-out":"unavailable"});
      return;
    }
    if(document.visibilityState==="hidden"||!navigator.onLine){
      markHidden();return;
    }
    const controller=new AbortController();
    abort.current?.abort();more.current?.abort();abort.current=controller;
    setState({kind:"loading",key});
    void fetchTargetInbox(limit,null,controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      if(result.ok===true){
        // Never lift a write/revocation fence on an unrelated or old GET.
        setState({kind:"ready",key,page:result.value});
      }else{
        setState({kind:"error",key,reason:result.reason});
        // No failed first-page response (including 503, network errors or
        // 429) can justify showing a count cached by another useInbox(1)
        // consumer. Fence ALL Inbox surfaces until a fresh verified session
        // and a fresh authorized GET; old in-flight badge GETs cannot lift it.
        if(runtime){
          markInboxRefused(runtime,generation);
          if(result.reason==="signed-out"&&refusalBudgetFor(runtime).admit())
            void runtime.reportRefusal("session_revoked");
        }
      }
    }).catch(()=>{if(!controller.signal.aborted)
      setState({kind:"error",key,reason:"unavailable"});});
    return ()=>{controller.abort();more.current?.abort();};
    // gate is a derived object, not a dependency: avoid unbounded request loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[gate.kind,generation,refresh,limit,hidden,runtime,markHidden,securityEpoch,blocked]);
  const page=gate.kind==="ready"&&!hidden&&!blocked&&state.kind==="ready"&&state.key===key
    ?state.page:null;
  const loading=gate.kind==="checking"||
    (gate.kind==="ready"&&!hidden&&!blocked&&
      (state.kind==="loading"||state.key!==key));
  const signedOut=gate.kind==="signed_out"||gate.kind==="refused"||
    (state.kind==="error"&&state.key===key&&state.reason==="signed-out");
  const loadMore=useCallback(async()=>{
    const first=page;
    if(!first?.nextCursor||more.current)return;
    const ctrl=new AbortController();more.current=ctrl;
    const result=await fetchTargetInbox(limit,first.nextCursor,ctrl.signal);
    if(more.current===ctrl)more.current=null;
    if(ctrl.signal.aborted)return;
    if(result.ok===false||result.value.count!==first.count||
        result.value.restoreGeneration!==first.restoreGeneration||
        result.value.snapshotRevision!==first.snapshotRevision||
        result.value.nextCursor===first.nextCursor||
        result.value.items.some(item=>first.items.some(old=>old.id===item.id))){
      // The failure may mean an ACL revocation. A separate Inbox badge
      // must not keep showing the previously authorized count.
      if(result.ok===false&&result.reason==="signed-out"){
        // Only a genuine 401/403 can invalidate the authenticated runtime.
        // A 503, 409 or stale page witness MUST NOT erase a pending UUID.
        revoke();return;
      }
      // Hide every page and independent navigation badge, including when an
      // unresolved command is in 'not-recorded'. Never report session_revoked
      // for a pagination/transport failure; keep the tab recovery witness.
      if(runtime)markInboxRefused(runtime,generation);
      markHidden();
      setState({kind:"error",key,reason:"stale"});
      return;
    }
    setState(before=>before.kind==="ready"&&before.key===key?{
      kind:"ready",key,page:{...before.page,
        items:[...before.page.items,...result.value.items],
        nextCursor:result.value.nextCursor},
    }:before);
  },[page,key,limit,revoke,runtime,generation,markHidden]);
  return {page,loading,signedOut,gate:gate.kind,reload,loadMore,revoke,retry};
}
export default function TargetInbox({language="cs",taskDetail=false}:{language?:Language;taskDetail?:boolean}){
  const {page,loading,signedOut,gate,reload,loadMore,revoke,retry}=useInbox(50);
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [recoveredGeneration,setRecoveredGeneration]=useState("");
  const [recoveryFailed,setRecoveryFailed]=useState(false);
  type C3bLocalOutcome={
    command:C3bAccept|C3bReceiptQuery;status:"committed"|"uncertain";
    next:C3bOutcome["next"];undoCommand?:C3bUndo;
  };
  const [c3bOutcome,setC3bOutcome]=useState<C3bLocalOutcome|null>(null);
  const c3bClear=useCallback(()=>{
    persistC3bRecovery(null);
    if(!inboxDecisionSnapshot(runtime,generation))setInboxUncertain(null);
  },[runtime,generation]);
  const c3bPending=useCallback((next:C3bLocalOutcome):boolean=>{
    if(!runtime?.known()||runtime.generation()!==generation)return false;
    const command=next.command;
    const saved=persistC3bRecovery({version:1,generation,
      command:{commandId:command.commandId,taskId:command.taskId,
        restoreGeneration:command.restoreGeneration},
      undo:next.undoCommand??null,
    });
    if(!saved){setRecoveryFailed(true);return false;}
    setInboxUncertain(generation);
    setC3bOutcome(next);
    return true;
  },[runtime,generation]);
  const onC3bOutcome=useCallback((outcome:C3bOutcome):boolean=>{
    if(!runtime?.known()||runtime.generation()!==generation)return false;
    if(outcome.status==="uncertain")return c3bPending(outcome);
    c3bClear();
    setC3bOutcome(outcome);
    emitTargetChange({kind:"task",id:outcome.command.taskId,change:"updated"});
    reload();
    return true;
  },[runtime,generation,c3bPending,c3bClear,reload]);
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
    const recovered=readC3bRecovery(generation);
    if(recovered){
      setInboxUncertain(generation);
      setC3bOutcome({command:recovered.command,status:"uncertain",next:null,
        ...(recovered.undo?{undoCommand:recovered.undo}:{})});
    }
    const ok=restoreInboxDecision(runtime,generation);
    setRecoveryFailed(!ok);
    if(ok)setRecoveredGeneration(generation);
  },[runtime,generation]);
  const decision=useSyncExternalStore(subscribeInboxDecision,
    ()=>inboxDecisionSnapshot(runtime,generation),()=>null);
  const inFlight=useRef(false);
  const setDecision=useCallback((next:InboxDecision|null):boolean=>{
    if(!runtime)return false;
    if(next===null){clearInboxDecision(runtime,generation);return true;}
    return setInboxDecision(runtime,generation,next);
  },[runtime,generation]);
  const commandCurrent=useCallback((command:InboxClientCommand):boolean=>
    Boolean(runtime?.known()&&runtime.generation()===generation&&
      inboxDecisionSnapshot(runtime,generation)?.command.commandId===command.commandId),
    [runtime,generation]);
  const speak=(cs:string,en:string)=>language==="cs"?cs:en;
  const c3bVerify=useCallback(async()=>{
    const current=c3bOutcome;
    if(!current||!runtime?.known()||runtime.generation()!==generation)return;
    const result=await receiptC3b(current.command);
    if(result.ok===true&&(result.value.status==="undone"||
        result.value.status==="cancelled")){
      c3bClear();setC3bOutcome(null);
      emitTargetChange({kind:"task",id:current.command.taskId,change:"updated"});
      reload();
    }else if(result.ok===true&&result.value.status==="committed"&&
      !current.undoCommand){
      onC3bOutcome({command:current.command as C3bAccept,
        status:"committed",next:result.value.next});
    }else if(result.ok===false&&result.reason==="signed-out"){
      c3bClear();setC3bOutcome(null);revoke();
    }
    // If an Undo may be in flight, a still-committed Accept is NOT terminal
    // evidence that Undo cannot commit later; retain the exact UUID.
  },[c3bOutcome,runtime,generation,onC3bOutcome,c3bClear,reload,revoke]);
  const c3bCancel=useCallback(async()=>{
    const original=c3bOutcome;
    if(!original||original.status!=="uncertain"||
       original.undoCommand||!runtime?.known()||
       runtime.generation()!==generation)return;
    // Same pinned target write lock as Accept: whichever commits first wins.
    const cancelled=await cancelC3b({
      commandId:original.command.commandId,
      taskId:original.command.taskId,
      restoreGeneration:original.command.restoreGeneration,
    });
    if(!runtime.known()||runtime.generation()!==generation)return;
    if(cancelled.ok&&cancelled.value.status==="cancelled"){
      c3bClear();setC3bOutcome(null);
      emitTargetChange({kind:"task",id:original.command.taskId,
        change:"updated"});
      reload();
    }else if(cancelled.ok&&cancelled.value.status==="committed"){
      onC3bOutcome({command:original.command as C3bAccept,
        status:"committed",next:cancelled.value.next});
    }else if(cancelled.ok&&cancelled.value.status==="undone"){
      c3bClear();setC3bOutcome(null);reload();
    }else if(cancelled.ok===false&&cancelled.reason==="signed-out"){
      c3bClear();setC3bOutcome(null);revoke();
    }
    // Any failed/unknown cancellation retains the same UUID and lockout.
  },[c3bOutcome,runtime,generation,c3bClear,reload,onC3bOutcome,revoke]);
  const c3bRetry=useCallback(async()=>{
    const current=c3bOutcome;
    if(!current||current.status!=="uncertain"||
       !("token" in current.command))return;
    await acceptC3b(current.command);
    await c3bVerify();
  },[c3bOutcome,c3bVerify]);
  const c3bRetryUndo=useCallback(async()=>{
    const current=c3bOutcome;
    if(!current||current.status!=="uncertain"||!current.undoCommand)return;
    await undoC3b(current.undoCommand);
    await c3bVerify();
  },[c3bOutcome,c3bVerify]);
  const c3bUndo=useCallback(async()=>{
    const current=c3bOutcome;
    if(!current||current.status!=="committed"||!current.next)return;
    const original=current.command;
    const command:C3bUndo={commandId:crypto.randomUUID(),
      undoOfCommandId:original.commandId,taskId:original.taskId,
      restoreGeneration:original.restoreGeneration,...current.next};
    if(!c3bPending({...current,undoCommand:command,status:"uncertain"}))return;
    await undoC3b(command);
    const checked=await receiptC3b(original);
    if(checked.ok===true&&checked.value.status==="undone"){
      c3bClear();setC3bOutcome(null);
      emitTargetChange({kind:"task",id:original.taskId,change:"updated"});
      reload();
    }
  },[c3bOutcome,c3bPending,c3bClear,reload]);
  // Runtime generation rotation and explicit security clear retire the
  // tab-scoped command even while this view is unmounted.
  useEffect(()=>{
    if(runtime&&(gate==="signed_out"||gate==="refused")){
      clearInboxDecision(runtime,generation);
      c3bClear();
      setC3bOutcome(null);
    }
  },[runtime,generation,gate,c3bClear]);
  const confirm=useCallback(async(
    command:InboxClientCommand,title:string,processId:string,
  )=>{
    if(!commandCurrent(command))return;
    setDecision({command,title,processId,stage:"verifying",next:null});
    const check=await verifyInboxCommand(command);
    // A response from an old actor or superseded UUID can never resolve this command.
    if(!commandCurrent(command))return;
    if(check.ok===false&&check.reason==="signed-out"){
      revoke();setDecision(null);return;
    }
    if(check.ok===true&&check.status==="committed"){
      setDecision({command,title,processId,
        stage:command.mode==="undo"?"undone":"undo-ready",next:check.next});
      emitTargetChange({kind:"task",id:command.taskId,change:"updated"});
     }else if(check.ok===true&&check.status==="cancelled"&&
        command.mode==="undo"&&check.next){
      // The old Undo is irrevocably stale, but cancellation-only lineage
      // permits one new signed Undo with a distinct self-bound UUID.
      setDecision({command,title,processId,stage:"undo-ready",next:check.next});
      emitTargetChange({kind:"task",id:command.taskId,change:"updated"});
    }else if(check.ok===true&&check.status==="cancelled"){
      // A pinned, irreversible cancellation fence is terminal even if the
      // original POST appears later. It cannot commit after this point.
      setDecision({command,title,processId,stage:"cancelled",next:null});
      emitTargetChange({kind:"task",id:command.taskId,change:"updated"});
      reload();
    }else if(check.ok===true&&check.status==="not_recorded"){
      // The old request may still be in flight: NEVER allocate a fresh UUID.
      // Replaying the identical command is safe because the pinned SQLite
      // writer serializes transactions and deduplicates actor+UUID+digest.
      setDecision({command,title,processId,stage:"not-recorded",next:null});
    }else{
      setDecision({command,title,processId,
        stage:"uncertain",next:null});
      // A 409 can be read_stale_reload AFTER the original write committed.
      // It is not an authoritative negative receipt: never discard the UUID.
    }
  },[revoke,commandCurrent,setDecision,reload]);
  async function submit(
    command:InboxClientCommand,title:string,processId:string,replayOriginal=false,
  ){
    if(inFlight.current||!runtime?.known()||runtime.generation()!==generation)return;
    if(replayOriginal){
      const original=inboxDecisionSnapshot(runtime,generation);
      // A recovery attempt must use the EXACT stored command and original
      // UUID. Never accept a fresh command or replace its CAS/Area witness.
      if(!original||original.stage!=="not-recorded"||
          JSON.stringify(original.command)!==JSON.stringify(command))return;
    }
    inFlight.current=true;
    if(!setDecision({command,title,processId,stage:"sending",next:null})){
      inFlight.current=false;setRecoveryFailed(true);return;
    }
    try{
      const sent=await sendInboxCommand(command);
      if(!commandCurrent(command))return;
      if(sent.ok===false&&sent.reason==="signed-out"){
        revoke();setDecision(null);return;
      }
      if(sent.ok===true||(sent.ok===false&&sent.reason==="uncertain")||replayOriginal){
        // A recovery's 409/404 may race with the original write: reconcile
        // its historical receipt before considering any terminal outcome.
        await confirm(command,title,processId);
      }else{
        setDecision({command,title,processId,stage:"conflict",next:null});
        reload();
      }
    }finally{inFlight.current=false;}
  }
  async function cancelOriginal(){
    if(inFlight.current||!decision||
        !["uncertain","not-recorded"].includes(decision.stage)||
        !runtime?.known()||runtime.generation()!==generation)return;
    const {command,title,processId}=decision;
    inFlight.current=true;
    if(!setDecision({command,title,processId,stage:"verifying",next:null})){
      inFlight.current=false;setRecoveryFailed(true);return;
    }
    try{
      const result=await cancelInboxCommand(command);
      if(!commandCurrent(command))return;
      if(result.ok===true&&result.status==="cancelled"&&command.mode==="undo"){
        // Read the exact cancelled Undo receipt for a fresh, actor-authorized
        // replacement witness. Any failure keeps the original UUID uncertain.
        await confirm(command,title,processId);
      }else if(result.ok===true&&result.status==="cancelled"){
        // Only this durable server proof may retire the original UUID. A
        // missing read-only receipt or stale CAS is NOT terminal evidence.
        setDecision({command,title,processId,stage:"cancelled",next:null});
        emitTargetChange({kind:"task",id:command.taskId,change:"updated"});
        reload();
      }else if(result.ok===true&&result.status==="committed"){
        // The old Process won the lock. Recover its exact receipt and Undo.
        await confirm(command,title,processId);
      }else if(result.ok===false&&result.reason==="signed-out"){
        revoke();setDecision(null);
      }else{
        // Timeout/403/409/503 is ambiguous; a cancellation may have committed
        // after the response was lost. Check only its exact original receipt.
        await confirm(command,title,processId);
      }
    }finally{inFlight.current=false;}
  }
  async function process(item:TargetInboxItem){
    if(inFlight.current||decision&&["sending","verifying","uncertain","not-recorded"].includes(decision.stage)||
        !page||!item.canProcess||!item.expectedRevision)return;
    inFlight.current=true;
    const fields:Omit<InboxClientCommand,"commandId">={
      taskId:item.id,mode:"process",undoOfCommandId:null,
      expectedRevision:item.expectedRevision,
      expectedTriageRevision:item.triageRevision,writeAreaId:item.effectiveAreaId,
      restoreGeneration:page.restoreGeneration,
    };
    const commandId=await issueInboxClientCommandId(fields);
    inFlight.current=false;
    if(!commandId){setRecoveryFailed(true);return;}
    const command:InboxClientCommand={commandId,...fields};
    void submit(command,item.title,command.commandId);
  }
  async function undo(){
    if(inFlight.current||!decision||decision.stage!=="undo-ready"||!decision.next||
        !page)return;
    inFlight.current=true;
    const fields:Omit<InboxClientCommand,"commandId">={
      taskId:decision.command.taskId,mode:"undo",
      undoOfCommandId:decision.processId,
      expectedRevision:decision.next.expectedRevision,
      expectedTriageRevision:decision.next.triageRevision,
      writeAreaId:decision.next.writeAreaId,
      restoreGeneration:decision.command.restoreGeneration,
    };
    const commandId=await issueInboxClientCommandId(fields);
    inFlight.current=false;
    if(!commandId){setRecoveryFailed(true);return;}
    const command:InboxClientCommand={commandId,...fields};
    void submit(command,decision.title,decision.processId);
  }
  async function recheck(){
    if(inFlight.current||!decision||
        !["uncertain","not-recorded"].includes(decision.stage))return;
    inFlight.current=true;
    try{await confirm(decision.command,decision.title,decision.processId);}
    finally{inFlight.current=false;}
  }
  // An unresolved command survives navigating away and back. In every phase,
  // hide rows/count and block fresh UUIDs until the original receipt is settled.
  const unresolved=decision&&["sending","verifying","uncertain","not-recorded"].includes(decision.stage);
  if(c3bOutcome?.status==="uncertain")return <section className="targetInbox"
    data-testid="target-c3b-uncertain" aria-live="polite">
    <p role="alert">{speak("Ověřuji původní příkaz. Úkoly zůstávají skryté do potvrzení výsledku.",
      "Checking the original command. Rows remain hidden until its receipt is confirmed.")}</p>
    <button type="button" onClick={()=>void c3bVerify()}>
      {speak("Ověřit původní příkaz","Verify original receipt")}</button>
    {!c3bOutcome.undoCommand&&<button type="button"
      onClick={()=>void c3bCancel()}>
      {speak("Bezpečně ukončit původní Přijmout",
        "Safely cancel original Accept")}</button>}
    {c3bOutcome.undoCommand?<button type="button"
      onClick={()=>void c3bRetryUndo()}>
      {speak("Opakovat původní Undo","Retry original Undo")}</button>:
      ("token" in c3bOutcome.command)&&<button type="button"
        onClick={()=>void c3bRetry()}>
        {speak("Opakovat pouze původní příkaz","Retry only the original command")}</button>}
  </section>;
  if(recoveryFailed)return <section className="targetInbox" data-testid="target-inbox-recovery-error">
    <p role="alert">{speak(
      "Nelze bezpečně obnovit původní příkaz. Zápisy jsou zablokované, aby nedošlo k duplicitě.",
      "Original command recovery is unavailable. Writes are blocked to prevent duplication.")}</p>
  </section>;
  if(gate==="ready"&&recoveredGeneration!==generation)return <section
    className="targetInbox" data-testid="target-inbox-recovering">
    <p role="status">{speak("Ověřuji předchozí příkaz…","Checking prior command…")}</p>
  </section>;
  if(gate==="ready"&&unresolved)return <section
    className="targetInbox" data-testid="target-inbox-uncertain"
    aria-label={speak("Cílový Inbox","Target Inbox")}>
    <p role={decision?.stage==="uncertain"||decision?.stage==="not-recorded"
      ?"alert":"status"}>{decision?.stage==="not-recorded"
      ?speak("Původní zápis zatím není zaznamenaný. Seznam a počet zůstávají skryté. Můžete bezpečně zopakovat pouze původní příkaz se stejným UUID.",
        "The original write is not yet recorded. Rows and count stay hidden. You may safely replay only the original command with the same UUID.")
      :decision?.stage==="uncertain"
      ?speak("Výsledek posledního zápisu není potvrzen. Seznam a počet jsou skryté, dokud nelze získat aktuální stav.",
        "The latest write is uncertain. Rows and count remain hidden pending fresh verification.")
      :speak("Ověřuji původní příkaz. Seznam a počet jsou dočasně skryté.",
        "The original command is pending. Rows and count remain temporarily hidden.")}</p>
    {(decision?.stage==="uncertain"||decision?.stage==="not-recorded")&&
      <button type="button" onClick={()=>void recheck()}>
        {speak("Ověřit původní příkaz","Verify original command")}</button>}
    {decision?.stage==="not-recorded"&&
      <button type="button" onClick={()=>void submit(
        decision.command,decision.title,decision.processId,true)}>
        {speak("Opakovat původní příkaz","Retry original command")}</button>}
    {(decision?.stage==="uncertain"||decision?.stage==="not-recorded")&&
      <button type="button" onClick={()=>void cancelOriginal()}>
        {speak("Bezpečně ukončit původní příkaz","Safely cancel original command")}</button>}
  </section>;
  if(!page)return <section aria-label={speak("Cílový Inbox","Target Inbox")}
    className="targetInbox" data-testid="target-inbox">
    <p role={loading?"status":"alert"}>{loading?speak("Ověřuji Inbox…","Checking Inbox…"):
      signedOut?speak("Přístup k Inboxu je nutné znovu ověřit.","Inbox access needs re-verification."):
      speak("Inbox nelze bezpečně načíst. Staré položky nejsou zobrazeny.",
        "Inbox cannot be safely loaded. No old rows are displayed.")}</p>
    {!loading&&<button type="button" onClick={()=>void retry()}>{speak("Zkusit znovu","Retry")}</button>}
  </section>;
  return <section className="targetInbox" data-testid="target-inbox"
    aria-label={speak("Cílový Inbox","Target Inbox")}>
    <p className="targetInboxSummary" role="status">{speak("Čeká na zpracování: ","Unprocessed: ")}
      <strong data-testid="target-inbox-count">{page.count}</strong></p>
    {decision&&<div className="targetInboxDecision" role="status" aria-live="polite">
      <span>{decision.stage==="sending"?speak("Ukládám…","Saving…"):
        decision.stage==="verifying"?speak("Ověřuji potvrzení…","Checking receipt…"):
        decision.stage==="uncertain"?speak(
          "Výsledek není potvrzen. Stejný příkaz neposílejte znovu; ověřte původní potvrzení.",
          "The outcome is uncertain. Do not resubmit; check the original receipt."):
        decision.stage==="cancelled"?speak(
          "Původní příkaz byl bezpečně ukončen. Případný opožděný zápis už nemůže proběhnout.",
          "The original command was safely cancelled; no late write can commit."):
        decision.stage==="conflict"?speak("Konflikt revize nebo oprávnění. Načtěte aktuální stav.","Revision or access conflict. Refresh the current state."):
        decision.stage==="denied"?speak("Přístup byl odebrán. Změna není potvrzena.","Access revoked. Change not confirmed."):
        decision.stage==="undone"?speak("Úkol byl vrácen do Inboxu.","Task returned to Inbox."):
        decision.stage==="undo-ready"&&decision.command.mode==="undo"&&decision.next?speak(
          "Původní Undo bylo bezpečně zrušeno. Úkol lze nyní znovu vrátit do Inboxu.",
          "The original Undo was cancelled safely. You may now return the task to Inbox."):
        decision.stage==="undo-ready"&&!decision.next?speak(
          "Zpracování bylo potvrzeno. Po novější změně úkolu už Undo není dostupné.",
          "Processing was confirmed. Undo is unavailable after a newer task change."):
        speak("Úkol byl zpracován.","Task processed.")}</span>
      {decision.stage==="uncertain"&&<button type="button" onClick={()=>void recheck()}>
        {speak("Ověřit potvrzení","Check receipt")}</button>}
      {decision.stage==="undo-ready"&&decision.next&&<button type="button"
        onClick={undo}>{speak("Vrátit do Inboxu (Undo)","Return to Inbox (Undo)")}</button>}
      {(decision.stage==="conflict"||decision.stage==="cancelled"||decision.stage==="undone"||
        (decision.stage==="undo-ready"&&!decision.next))&&
        <button type="button" onClick={()=>{setDecision(null);reload();}}>
          {speak("Zavřít a obnovit","Close and refresh")}</button>}
    </div>}
    {c3bOutcome?.status==="committed"&&<div
      className="targetInboxDecision" data-testid="target-c3b-committed" role="status">
      <span>{speak("Návrh byl přijat a úkol zpracován.",
        "Suggestion accepted and task processed.")}</span>
      {c3bOutcome.next&&<button type="button" onClick={()=>void c3bUndo()}>
        {speak("Vrátit změny (Undo)","Undo changes")}</button>}
      <button type="button" onClick={()=>setC3bOutcome(null)}>
        {speak("Zavřít","Close")}</button>
    </div>}
    {page.items.length===0&&<p role="status">
      {speak("Žádné úkoly nečekají na zpracování.","No tasks await processing.")}</p>}
    <ul className="targetInboxList">
      {page.items.map(item=><li key={item.id} className="targetInboxRow">
        <div className="targetInboxRowText">{taskDetail&&detailIdOk(item.id)
          ?<button type="button" className="targetInboxDetailLink"
            data-detail-row={detailRowKey("task",item.id)}
            onClick={event=>openTargetDetail({kind:"task",id:item.id,view:"Inbox"},event.currentTarget)}
            aria-label={speak("Otevřít úkol: ","Open task: ")+item.title}>{item.title}</button>
          :<strong>{item.title}</strong>}
          {item.status==="completed"&&<span className="targetInboxCompleted">
            {speak("Dokončeno, čeká na zpracování","Completed, awaiting processing")}</span>}
          {item.canSuggest&&
            <TargetInboxC3b item={item} restoreGeneration={page.restoreGeneration}
              language={language} disabled={Boolean(unresolved)||Boolean(c3bOutcome)}
              onOutcome={onC3bOutcome} onRevoked={revoke}/>}
        </div>
        {item.canProcess&&<button type="button"
          disabled={inFlight.current||Boolean(unresolved)||
            (decision!==null&&decision.command.taskId===item.id&&
              decision.stage==="undo-ready")}
          aria-label={speak("Zpracovat úkol: ","Process task: ")+item.title}
          onClick={()=>process(item)}>{speak("Zpracovat","Process")}</button>}
        {!item.canProcess&&<span className="targetInboxReadOnly">
          {speak("Jen čtení","Read only")}</span>}
      </li>)}
    </ul>
    {page.nextCursor&&<button type="button" className="targetInboxMore"
      onClick={()=>void loadMore()}>{speak("Načíst další","Load more")}</button>}
  </section>;
}
/** Actor-scoped target badge; never reuse the legacy sidebarCounts. */
export function TargetInboxCount(){
  const {page}=useInbox(1);
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [recoveredGeneration,setRecoveredGeneration]=useState("");
  useEffect(()=>{
    if(runtime?.known()&&runtime.generation()===generation&&
        restoreInboxDecision(runtime,generation))setRecoveredGeneration(generation);
  },[runtime,generation]);
  const uncertain=useSyncExternalStore(subscribeInboxUncertain,inboxUncertainSnapshot,()=>"");
  return page&&recoveredGeneration===generation&&uncertain!==generation?<span className="navCount" data-testid="target-inbox-sidebar-count"
    aria-label={"Unprocessed: "+page.count}>{page.count}</span>:null;
}
