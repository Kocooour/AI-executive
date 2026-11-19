"use client";
/** C-2: target-only Home and Upcoming; no legacy task store or cached rows. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {useTargetScope} from "./target-scope-state";
import {TargetDataStatus} from "./target-data-status";
import {openTargetDetail} from "./target-detail-state";
import {detailIdOk} from "../../lib/target-detail-route";
import {targetMyPlanGate} from "../../lib/target-my-plan-embed";
import {refusalBudgetFor} from "../../lib/target-refusal-budget";
import {subscribePrivateTaskCreate} from "../../lib/target-private-task-create-coordinator";
import {emitTargetChange,subscribeTargetChange} from "../../lib/target-data-invalidation";
import {localMyPlanDate,type MyPlanSliceFilter} from "../../lib/target-staging-my-plan-client";
import {
  c2AddDays,c2SevenDayGroups,fetchC2Day,fetchC2HomeSummary,
  type C2DayPage,type C2Summary,type C2Task,type C2Failure,
} from "../../lib/target-upcoming-home-client";
import "../target-staging/my-plan/preview/preview.css";
import "./target-overview.css";

type Language="cs"|"en";
type Kind="home"|"upcoming";
type Ready={
  status:"ready";key:string;today:C2DayPage|null;future:C2DayPage;summary:C2Summary|null;
};
type ViewState={status:"loading";key?:string}|{status:"error";key:string;reason:C2Failure}|Ready;
const local=(language:Language)=>language==="cs"?"cs-CZ":"en-GB";
const dayLabel=(day:string,language:Language)=>new Intl.DateTimeFormat(local(language),{
  weekday:"long",day:"numeric",month:"long",
}).format(new Date(day+"T12:00:00"));
const dateLabel=(day:string,language:Language)=>new Intl.DateTimeFormat(local(language),{
  day:"numeric",month:"numeric",year:"numeric",
}).format(new Date(day+"T12:00:00"));
const isSignedOut=(reason:C2Failure)=>reason==="signed-out";
function Why({task,language}:{task:C2Task;language:Language}){
  return <details className="targetOverviewWhy">
    <summary>{language==="cs"?"Proč?":"Why?"}</summary>
    <p>{language==="cs"?"Zobrazeno podle cílových dat, ke kterým máte přístup.":"Shown from target records you can access."}</p>
    {task.whenOn&&<p>{language==="cs"?"Osobní plán (When): ":"Personal plan (When): "}{dateLabel(task.whenOn,language)}</p>}
    {task.dueOn&&<p>{language==="cs"?"Termín: ":"Due date: "}{dateLabel(task.dueOn,language)}</p>}
    <p>{language==="cs"
      ?"Položka je přiřazena k nejbližšímu z těchto dat. Nemá automaticky označení naléhavosti."
      :"The earliest of these dates selects the day. This is not an urgency warning."}</p>
  </details>;
}
function Row({task,language,view,openable}:{task:C2Task;language:Language;
  view:"Home"|"Upcoming";openable:boolean}){
  return <li className="targetOverviewRow">
    <span className="stagingMyPlanSquare" aria-hidden="true"/>
    <div className="targetOverviewRowBody">
      {openable&&detailIdOk(task.taskId)
        ?<button type="button" className="stagingMyPlanOpen"
          data-detail-row={"task:"+task.taskId}
          aria-label={(language==="cs"?"Otevřít úkol ":"Open task ")+task.title}
          onClick={event=>openTargetDetail({kind:"task",id:task.taskId,view},event.currentTarget)}>
          <strong>{task.title}</strong></button>
        :<strong>{task.title}</strong>}
      <Why task={task} language={language}/>
    </div>
  </li>;
}
function TargetOverviewRead({kind,language,generation,onRefusal,openable}:{
  kind:Kind;language:Language;generation:string;onRefusal:()=>void;openable:boolean;
}){
  const scope=useTargetScope();
  const filter:MyPlanSliceFilter=scope;
  const summaryScope:C2Summary["scope"]=scope==="all"?"my-plan":scope;
  const [today,setToday]=useState(localMyPlanDate);
  const [refresh,setRefresh]=useState(0);
  const [privacyHidden,setPrivacyHidden]=useState(false);
  // A scope, actor generation, date or refresh change hides old rows DURING render,
  // before the effect cancels/reissues its bound server request.
  const viewKey=[generation,kind,filter,today,refresh].join(":");
  const [state,setState]=useState<ViewState>({status:"loading"});
  const [moreBusy,setMoreBusy]=useState(false);
  const readAbort=useRef<AbortController|null>(null);
  const moreAbort=useRef<AbortController|null>(null);
  const reload=useCallback(()=>setRefresh(n=>n+1),[]);
  // A session poll is also an ACL witness: membership revocation does not
  // necessarily rotate the authenticated actor generation.
  useTargetTick(reload);
  // This overview owns its request controllers instead of a feature session.
  // Cancel them and remove titles on hide/offline/pagehide; wake only after
  // the runtime has freshly verified the authenticated session.
  const {markHidden}=useTargetWake({
    hide(reason){
      readAbort.current?.abort();moreAbort.current?.abort();
      setPrivacyHidden(true);
      setMoreBusy(false);
      setState({status:"error",key:viewKey,
        reason:reason==="offline"?"offline":"stale"});
    },
    ready(){
      setToday(localMyPlanDate());
      setPrivacyHidden(false);
      reload();
    },
    signedOut(){
      readAbort.current?.abort();moreAbort.current?.abort();
      setPrivacyHidden(true);
      setMoreBusy(false);
      setState({status:"error",key:viewKey,reason:"signed-out"});
    },
  });
  useEffect(()=>{
    const update=()=>{const now=localMyPlanDate();setToday(d=>d===now?d:now);};
    const interval=window.setInterval(update,60_000);
    document.addEventListener("visibilitychange",update);
    window.addEventListener("pageshow",update);
    return ()=>{window.clearInterval(interval);
      document.removeEventListener("visibilitychange",update);
      window.removeEventListener("pageshow",update);};
  },[]);
  useEffect(()=>subscribeTargetChange(reload),[reload]);
  useEffect(()=>{
    // Initial mount may already be hidden/offline without a transition event.
    // Mark the wake machine so online/visible triggers fresh verification.
    if(privacyHidden||document.visibilityState==="hidden"||!navigator.onLine){
      if(document.visibilityState==="hidden"||!navigator.onLine)markHidden();
      readAbort.current?.abort();moreAbort.current?.abort();
      setState({status:"error",key:viewKey,
        reason:!navigator.onLine?"offline":"stale"});
      return;
    }
    const end=c2AddDays(today,7);
    if(!end){setState({status:"error",key:viewKey,reason:"invalid-response"});return;}
    const controller=new AbortController();
    readAbort.current?.abort();moreAbort.current?.abort();
    readAbort.current=controller;
    setState({status:"loading",key:viewKey});
    setMoreBusy(false);
    const future=fetchC2Day({window:"upcoming",evaluationDate:today,
      throughDate:end,areaFilter:filter,limit:kind==="home"?5:100,signal:controller.signal});
    const all=kind==="home"
      ?Promise.all([future,fetchC2Day({window:"today",evaluationDate:today,
        throughDate:null,areaFilter:filter,limit:5,signal:controller.signal}),
        fetchC2HomeSummary(summaryScope,controller.signal)])
      :Promise.all([future]);
    void all.then(results=>{
      if(controller.signal.aborted)return;
      const failure=results.find(result=>!result.ok);
      if(failure&&!failure.ok){
        setState({status:"error",key:viewKey,reason:failure.reason});
        if(isSignedOut(failure.reason))onRefusal();
        return;
      }
      const upcoming=results[0];
      if(!upcoming?.ok){setState({status:"error",key:viewKey,reason:"invalid-response"});return;}
      const current=kind==="home"?results[1]:null;
      const totals=kind==="home"?results[2]:null;
      if((current&&!current.ok)||(totals&&!totals.ok)){
        setState({status:"error",key:viewKey,reason:"invalid-response"});return;
      }
      setState({status:"ready",key:viewKey,future:upcoming.value as C2DayPage,
        today:current&&current.ok?current.value as C2DayPage:null,
        summary:totals&&totals.ok?totals.value as C2Summary:null});
    }).catch(()=>{if(!controller.signal.aborted)setState({status:"error",key:viewKey,reason:"unavailable"});});
    return ()=>{controller.abort();moreAbort.current?.abort();};
  },[today,filter,summaryScope,kind,refresh,generation,onRefusal,privacyHidden,markHidden]);
  async function loadMore(){
    if(privacyHidden||document.visibilityState==="hidden"||!navigator.onLine||
      state.status!=="ready"||state.key!==viewKey||!state.future.hasMore||!state.future.nextCursor||moreBusy)return;
    const cursor=state.future.nextCursor;
    const end=c2AddDays(today,7);
    if(!end)return;
    const controller=new AbortController();
    moreAbort.current?.abort();moreAbort.current=controller;
    setMoreBusy(true);
    const result=await fetchC2Day({window:"upcoming",evaluationDate:today,
      throughDate:end,areaFilter:filter,limit:100,cursor,signal:controller.signal});
    if(controller.signal.aborted)return;
    setMoreBusy(false);
    if(result.ok===false){
      setState({status:"error",key:viewKey,reason:result.reason});
      if(isSignedOut(result.reason))onRefusal();
      return;
    }
    const previous=new Set(state.future.tasks.map(t=>t.taskId));
    if(result.value.tasks.some(task=>previous.has(task.taskId))||
      (result.value.tasks[0]&&state.future.tasks.length>0&&
        result.value.tasks[0].attentionOn<state.future.tasks[state.future.tasks.length-1].attentionOn)||
      result.value.nextCursor===cursor){
      setState({status:"error",key:viewKey,reason:"stale"});return;
    }
    setState({...state,future:{...result.value,tasks:[...state.future.tasks,...result.value.tasks]}});
  }
  const message=(language==="cs"
    ?{loading:"Načítám aktuální data…",empty:"Na příštích sedm dní nejsou žádné naplánované úkoly.",
      noToday:"Pro dnešek ani dřívější dny nejsou žádné úkoly.",
      error:"Aktuální údaje nelze bezpečně načíst.",retry:"Zkusit znovu",
      more:"Načíst další úkoly",moreBusy:"Načítám…"}
    :{loading:"Loading current records…",empty:"Nothing planned for the next seven days.",
      noToday:"No tasks for today or earlier.",error:"Current records could not be loaded safely.",
      retry:"Retry",more:"Load more tasks",moreBusy:"Loading…"});
  if(state.status==="loading"||(!privacyHidden&&state.key!==viewKey))return <div data-testid="target-overview-loading" role="status">{message.loading}</div>;
  if(privacyHidden||state.status==="error")return <div data-testid="target-overview-error" role="status">
    <p>{message.error}</p><TargetDataStatus failure={state.status==="error"&&state.reason==="signed-out"?"signed-out":"unavailable"}
      language={language} onAction={reload}/>
    <button type="button" onClick={reload}>{message.retry}</button>
  </div>;
  const groups=c2SevenDayGroups(state.future.tasks,today);
  return <section className="targetOverview" data-testid={kind==="home"?"target-home":"target-upcoming"}
    data-target-source="authorized">
    {kind==="home"&&state.summary&&<>
      <p className="targetOverviewSubtle">{language==="cs"
        ?"Souhrn vašich aktuálně dostupných cílových dat. Počty znamenají celkový počet, ne naléhavost."
        :"Summary of target records currently accessible to you. Counts are totals, not urgency."}</p>
      <div className="targetOverviewTotals">
        <div><strong>{state.summary.counts.tasks}{state.summary.truncated.tasks?"+":""}</strong>
          <span>{language==="cs"?"úkolů celkem":"tasks in total"}</span></div>
        <div><strong>{state.summary.counts.projects}{state.summary.truncated.projects?"+":""}</strong>
          <span>{language==="cs"?"projektů celkem":"projects in total"}</span></div>
      </div>
      <section className="targetOverviewSection">
        <h2>{language==="cs"?"Dnes a dříve":"Today and earlier"}</h2>
        {state.today?.tasks.length
          ?<ul>{state.today.tasks.map(task=><Row key={task.taskId} task={task}
              language={language} view="Home" openable={openable}/>)}</ul>
          :<p>{message.noToday}</p>}
      </section>
    </>}
    <section className="targetOverviewSection">
      <h2>{language==="cs"?"Následujících 7 dní":"Next 7 days"}</h2>
      {state.future.tasks.length===0
        ?<p className="targetOverviewSubtle">{message.empty}</p>
        :groups.filter(group=>group.tasks.length>0).map(group=>
          <section key={group.day} className="targetOverviewDay" data-target-day={group.day}
            aria-label={dayLabel(group.day,language)}>
            <h3>{dayLabel(group.day,language)}</h3>
            <ul>{group.tasks.map(task=><Row key={task.taskId} task={task}
              language={language} view={kind==="home"?"Home":"Upcoming"} openable={openable}/>)}</ul>
          </section>)}
      {kind==="upcoming"&&state.future.hasMore&&<button type="button"
        disabled={moreBusy} onClick={()=>void loadMore()}>
        {moreBusy?message.moreBusy:message.more}
      </button>}
      {kind==="home"&&state.future.hasMore&&<p className="targetOverviewSubtle">
        {language==="cs"?"Zobrazeno prvních pět položek pro období. Další najdete v Nadcházejících."
          :"Showing the first five items in this period. Open Upcoming for the rest."}
      </p>}
    </section>
  </section>;
}
export default function TargetOverview({kind,language="cs",taskDetail=false}:{
  kind:Kind;language?:Language;taskDetail?:boolean;
}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const subscribe=useMemo(
    ()=>(notify:()=>void)=>runtime?runtime.subscribeOutcome(notify):()=>{},[runtime]);
  const outcome=useSyncExternalStore(
    subscribe,()=>runtime?runtime.lastOutcome():null,()=>null);
  const [blocked,setBlocked]=useState(false);
  const ownBump=useRef(false);
  useEffect(()=>{if(ownBump.current){ownBump.current=false;return;}setBlocked(false);},[generation]);
  const refusal=useCallback(()=>{
    if(!runtime)return;
    if(!refusalBudgetFor(runtime).admit()){setBlocked(true);return;}
    ownBump.current=true;
    void runtime.reportRefusal("session_revoked");
  },[runtime]);
  const retry=useCallback(()=>{
    refusalBudgetFor(runtime).reset();setBlocked(false);void runtime?.refresh();
  },[runtime]);
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
    return subscribePrivateTaskCreate(runtime,generation,change=>{
      if(change.confirmedTaskId)
        emitTargetChange({kind:"task",id:change.confirmedTaskId,change:"updated"});
    });
  },[runtime,generation]);
  const gate=targetMyPlanGate(runtime,generation,outcome,blocked);
  if(gate.kind!=="ready")return <div data-testid="target-overview-gate">
    {gate.kind==="checking"
      ?<p role="status">{language==="cs"?"Ověřuji přístup…":"Checking access…"}</p>
      :<TargetDataStatus language={language}
        failure={gate.kind==="signed_out"||gate.kind==="refused"?"signed-out":"unavailable"}
        onAction={retry}/>}
  </div>;
  return <TargetOverviewRead key={kind+":"+gate.generation} kind={kind}
    language={language} generation={gate.generation} openable={taskDetail} onRefusal={refusal}/>;
}
