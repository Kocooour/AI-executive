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
import {inboxUncertainSnapshot,subscribeInboxUncertain} from "../../lib/target-data-invalidation";
import {refusalBudgetFor} from "../../lib/target-refusal-budget";
import {
  fetchTargetInbox,sendInboxCommand,verifyInboxCommand,
  type InboxClientCommand,type InboxClientPage,type InboxClientFailure,
} from "../../lib/target-inbox-client";
import type {TargetInboxItem} from "../../lib/target-inbox-client-types";
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
  const revoke=useCallback(()=>{
    abort.current?.abort();more.current?.abort();
    setHidden(true);
    if(runtime)markInboxRefused(runtime,generation);
    setState({kind:"error",key:"",reason:"signed-out"});
    if(runtime&&refusalBudgetFor(runtime).admit())
      void runtime.reportRefusal("session_revoked");
  },[runtime,generation]);
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
        // A first-page 409 (changed ACL/policy snapshot) or 404 (Inbox
        // disabled) revokes the authorization behind ALL Inbox surfaces.
        // The sidebar/mobile badge is a separate useInbox(1) consumer: it
        // must not continue showing an earlier count while this list fails.
        // A fresh verified session + a NEW authorized GET is needed to lift
        // this shared refusal fence; an old or late GET cannot lift it.
        if(runtime&&(
            result.reason==="signed-out"||result.reason==="stale"||
            result.reason==="feature-off")){
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
      const command=inboxDecisionSnapshot(runtime,generation);
      if(command&&["sending","verifying","uncertain"].includes(command.stage))
        setState({kind:"error",key,reason:"stale"});
      else{
        // The next online/visible wake must reverify the session before
        // restoring any Inbox count. A refusal is a security hide event.
        markHidden();revoke();
      }
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
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
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
  // Runtime generation rotation and explicit security clear retire the
  // tab-scoped command even while this view is unmounted.
  useEffect(()=>{
    if(runtime&&(gate==="signed_out"||gate==="refused"))
      clearInboxDecision(runtime,generation);
  },[runtime,generation,gate]);
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
    }else if(check.ok===true&&check.status==="not_recorded"){
      // Not-recorded is not proof that the old write has quiesced.
      setDecision({command,title,processId,stage:"uncertain",next:null});
    }else{
      setDecision({command,title,processId,
        stage:"uncertain",next:null});
      // A 409 can be read_stale_reload AFTER the original write committed.
      // It is not an authoritative negative receipt: never discard the UUID.
    }
  },[revoke,commandCurrent,setDecision]);
  async function submit(command:InboxClientCommand,title:string,processId:string){
    if(inFlight.current||!runtime?.known()||runtime.generation()!==generation)return;
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
      if(sent.ok===true||(sent.ok===false&&sent.reason==="uncertain")){
        // Never replace commandId or blind-retry an ambiguous Process/Undo.
        await confirm(command,title,processId);
      }else{
        setDecision({command,title,processId,stage:"conflict",next:null});
        reload();
      }
    }finally{inFlight.current=false;}
  }
  function process(item:TargetInboxItem){
    if(inFlight.current||decision&&["sending","verifying","uncertain"].includes(decision.stage)||
        !page||!item.canProcess||!item.expectedRevision)return;
    const command:InboxClientCommand={
      commandId:crypto.randomUUID(),taskId:item.id,mode:"process",
      undoOfCommandId:null,expectedRevision:item.expectedRevision,
      expectedTriageRevision:item.triageRevision,writeAreaId:item.effectiveAreaId,
      restoreGeneration:page.restoreGeneration,
    };
    void submit(command,item.title,command.commandId);
  }
  function undo(){
    if(inFlight.current||!decision||decision.stage!=="undo-ready"||!decision.next||
        !page)return;
    const command:InboxClientCommand={
      commandId:crypto.randomUUID(),taskId:decision.command.taskId,mode:"undo",
      undoOfCommandId:decision.processId,
      expectedRevision:decision.next.expectedRevision,
      expectedTriageRevision:decision.next.triageRevision,
      writeAreaId:decision.next.writeAreaId,
      restoreGeneration:decision.command.restoreGeneration,
    };
    void submit(command,decision.title,decision.processId);
  }
  async function recheck(){
    if(inFlight.current||!decision||decision.stage!=="uncertain")return;
    inFlight.current=true;
    try{await confirm(decision.command,decision.title,decision.processId);}
    finally{inFlight.current=false;}
  }
  // An unresolved command survives navigating away and back. In every phase,
  // hide rows/count and block fresh UUIDs until the original receipt is settled.
  const unresolved=decision&&["sending","verifying","uncertain"].includes(decision.stage);
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
    <p role={decision?.stage==="uncertain"?"alert":"status"}>{decision?.stage==="uncertain"
      ?speak("Výsledek posledního zápisu není potvrzen. Seznam a počet jsou skryté, dokud nelze získat aktuální stav.",
        "The latest write is uncertain. Rows and count remain hidden pending fresh verification.")
      :speak("Ověřuji původní příkaz. Seznam a počet jsou dočasně skryté.",
        "The original command is pending. Rows and count remain temporarily hidden.")}</p>
    {decision?.stage==="uncertain"&&<button type="button" onClick={()=>void recheck()}>
      {speak("Ověřit původní příkaz","Verify original command")}</button>}
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
        decision.stage==="conflict"?speak("Konflikt revize nebo oprávnění. Načtěte aktuální stav.","Revision or access conflict. Refresh the current state."):
        decision.stage==="denied"?speak("Přístup byl odebrán. Změna není potvrzena.","Access revoked. Change not confirmed."):
        decision.stage==="undone"?speak("Úkol byl vrácen do Inboxu.","Task returned to Inbox."):
        decision.stage==="undo-ready"&&!decision.next?speak(
          "Zpracování bylo potvrzeno. Po novější změně úkolu už Undo není dostupné.",
          "Processing was confirmed. Undo is unavailable after a newer task change."):
        speak("Úkol byl zpracován.","Task processed.")}</span>
      {decision.stage==="uncertain"&&<button type="button" onClick={()=>void recheck()}>
        {speak("Ověřit potvrzení","Check receipt")}</button>}
      {decision.stage==="undo-ready"&&decision.next&&<button type="button"
        onClick={undo}>{speak("Vrátit do Inboxu (Undo)","Return to Inbox (Undo)")}</button>}
      {(decision.stage==="conflict"||decision.stage==="undone"||
        (decision.stage==="undo-ready"&&!decision.next))&&
        <button type="button" onClick={()=>{setDecision(null);reload();}}>
          {speak("Zavřít a obnovit","Close and refresh")}</button>}
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
