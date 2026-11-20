"use client";
/** C-3a: authorized, fail-closed Inbox with Process/Undo receipt reconciliation. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {targetOverviewGate} from "../../lib/target-my-plan-embed";
import {emitTargetChange,subscribeTargetChange} from "../../lib/target-data-invalidation";
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
  const [refresh,setRefresh]=useState(0);
  const [hidden,setHidden]=useState(false);
  const [state,setState]=useState<State>({kind:"loading",key:""});
  const abort=useRef<AbortController|null>(null);
  const more=useRef<AbortController|null>(null);
  const reload=useCallback(()=>setRefresh(n=>n+1),[]);
  const gate=targetOverviewGate(runtime,generation,outcome);
  const key=generation+":"+limit+":"+refresh;
  useTargetTick(reload);
  useEffect(()=>subscribeTargetChange(reload),[reload]);
  const {markHidden}=useTargetWake({
    hide(){abort.current?.abort();more.current?.abort();setHidden(true);
      setState({kind:"error",key,reason:"unavailable"});},
    ready(){setHidden(false);reload();},
    signedOut(){abort.current?.abort();more.current?.abort();setHidden(true);
      setState({kind:"error",key,reason:"signed-out"});},
  });
  useEffect(()=>{
    if(gate.kind!=="ready"||hidden){
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
      if(result.ok){
        setState({kind:"ready",key,page:result.value});
      }else{
        setState({kind:"error",key,reason:result.reason});
        if(result.reason==="signed-out"&&runtime&&refusalBudgetFor(runtime).admit())
          void runtime.reportRefusal("session_revoked");
      }
    }).catch(()=>{if(!controller.signal.aborted)
      setState({kind:"error",key,reason:"unavailable"});});
    return ()=>{controller.abort();more.current?.abort();};
    // gate is a derived object, not a dependency: avoid unbounded request loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[gate.kind,generation,refresh,limit,hidden,runtime,markHidden]);
  const page=gate.kind==="ready"&&!hidden&&state.kind==="ready"&&state.key===key
    ?state.page:null;
  const loading=gate.kind==="checking"||
    (gate.kind==="ready"&&!hidden&&
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
    if(!result.ok||result.value.count!==first.count||
        result.value.restoreGeneration!==first.restoreGeneration||
        result.value.nextCursor===first.nextCursor||
        result.value.items.some(item=>first.items.some(old=>old.id===item.id))){
      setState({kind:"error",key,reason:result.ok?"stale":result.reason});
      return;
    }
    setState(before=>before.kind==="ready"&&before.key===key?{
      kind:"ready",key,page:{...before.page,
        items:[...before.page.items,...result.value.items],
        nextCursor:result.value.nextCursor},
    }:before);
  },[page,key,limit]);
  return {page,loading,signedOut,gate:gate.kind,reload,loadMore};
}
type Decision={
  command:InboxClientCommand;title:string;processId:string;
  stage:"sending"|"verifying"|"uncertain"|"undo-ready"|"conflict"|"denied"|"undone";
  next:{expectedRevision:string;triageRevision:number;writeAreaId:string}|null;
};
export default function TargetInbox({language="cs"}:{language?:Language;taskDetail?:boolean}){
  const {page,loading,signedOut,gate,reload,loadMore}=useInbox(50);
  const [decision,setDecision]=useState<Decision|null>(null);
  const inFlight=useRef(false);
  const generation=useTargetGeneration();
  const speak=(cs:string,en:string)=>language==="cs"?cs:en;
  // A new authenticated identity cannot inherit an old actor's Undo command.
  useEffect(()=>{setDecision(null);inFlight.current=false;},[generation]);
  useEffect(()=>{if(gate!=="ready")setDecision(null);},[gate]);
  const confirm=useCallback(async(command:InboxClientCommand,title:string,processId:string)=>{
    setDecision({command,title,processId,stage:"verifying",next:null});
    const check=await verifyInboxCommand(command);
    if(check.ok&&check.status==="committed"){
      emitTargetChange({kind:"task",id:command.taskId,change:"updated"});
      reload();
      setDecision({command,title,processId,
        stage:command.mode==="undo"?"undone":"undo-ready",next:check.next});
    }else if(check.ok&&check.status==="not_recorded"){
      setDecision({command,title,processId,stage:"uncertain",next:null});
    }else{
      setDecision({command,title,processId,
        stage:!check.ok&&(check.reason==="stale"||check.reason==="signed-out")
          ?"conflict":"uncertain",next:null});
      if(!check.ok&&check.reason==="stale")reload();
    }
  },[reload]);
  async function submit(command:InboxClientCommand,title:string,processId:string){
    if(inFlight.current)return;
    inFlight.current=true;
    setDecision({command,title,processId,stage:"sending",next:null});
    try{
      const sent=await sendInboxCommand(command);
      if(sent.ok){
        await confirm(command,title,processId);
      }else if(sent.reason==="uncertain"){
        // Never replace commandId or blind-retry after an ambiguous response.
        await confirm(command,title,processId);
      }else{
        setDecision({command,title,processId,
          stage:sent.reason==="signed-out"?"denied":"conflict",next:null});
        reload();
      }
    }finally{inFlight.current=false;}
  }
  function process(item:TargetInboxItem){
    if(inFlight.current||!page||!item.canProcess||!item.expectedRevision)return;
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
  if(!page)return <section aria-label={speak("Cílový Inbox","Target Inbox")}
    className="targetInbox" data-testid="target-inbox">
    <p role={loading?"status":"alert"}>{loading?speak("Ověřuji Inbox…","Checking Inbox…"):
      signedOut?speak("Přístup k Inboxu je nutné znovu ověřit.","Inbox access needs re-verification."):
      speak("Inbox nelze bezpečně načíst. Staré položky nejsou zobrazeny.",
        "Inbox cannot be safely loaded. No old rows are displayed.")}</p>
    {!loading&&<button type="button" onClick={reload}>{speak("Zkusit znovu","Retry")}</button>}
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
        speak("Úkol byl zpracován.","Task processed.")}</span>
      {decision.stage==="uncertain"&&<button type="button" onClick={()=>void recheck()}>
        {speak("Ověřit potvrzení","Check receipt")}</button>}
      {decision.stage==="undo-ready"&&decision.next&&<button type="button"
        onClick={undo}>{speak("Vrátit do Inboxu (Undo)","Return to Inbox (Undo)")}</button>}
      {(decision.stage==="conflict"||decision.stage==="undone")&&
        <button type="button" onClick={()=>{setDecision(null);reload();}}>
          {speak("Zavřít a obnovit","Close and refresh")}</button>}
    </div>}
    {page.items.length===0&&<p role="status">
      {speak("Žádné úkoly nečekají na zpracování.","No tasks await processing.")}</p>}
    <ul className="targetInboxList">
      {page.items.map(item=><li key={item.id} className="targetInboxRow">
        <div className="targetInboxRowText"><strong>{item.title}</strong>
          {item.status==="completed"&&<span className="targetInboxCompleted">
            {speak("Dokončeno, čeká na zpracování","Completed, awaiting processing")}</span>}
        </div>
        {item.canProcess&&<button type="button"
          disabled={inFlight.current||
            (decision!==null&&decision.command.taskId===item.id&&
              ["sending","verifying","uncertain","undo-ready"].includes(decision.stage))}
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
  return page?<span className="navCount" data-testid="target-inbox-sidebar-count"
    aria-label={"Unprocessed: "+page.count}>{page.count}</span>:null;
}
