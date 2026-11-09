"use client";
/** R3-FE-4a: read-only authorized detail (task, project with its tasks, note)
 * INSIDE the main app, as the inspector on desktop and a full screen on phone
 * (it reuses the inspector shell classes). Loaded lazily by the app root only
 * when a detail flag is on, so with the flags off nothing here is fetched.
 *
 * Lifecycle (as R3-FE-2/3): a read exists only for a server-confirmed runtime
 * generation; the feature session is created by useTargetSession (keyed by
 * generation and target), so a generation change disposes it and drops the
 * content at once. Every mount reads from the server again (reload, Back,
 * Forward, deep link); nothing is cached beyond the open view, persisted or
 * logged. Hidden / pagehide / offline remove the content; 401 goes through the
 * refusal budget. Missing, foreign and revoked items show one calm sentence.
 * A reading-scope change does NOT close an open detail (the scope filters
 * lists only); closing returns to the list of the scope that is current then. */
import {useCallback,useEffect,useRef,useState} from "react";
import {useTargetSession} from "./target-data-provider";
import {TargetDataStatus} from "./target-data-status";
import {useTargetGate} from "./use-target-gate";
import {
  closeTargetDetail,detailRowKey,expectFocusReturn,focusPendingRow,openTargetDetail,
} from "./target-detail-state";
import {
  createTargetDetailSession,type TargetDetailContent,type TargetDetailFailure,
} from "../../lib/target-detail-session";
import {
  detailRouteKey,type TargetDetailGates,type TargetDetailRoute,
} from "../../lib/target-detail-route";
import {detailCopy,type DetailCopy,type DetailLanguage} from "../../lib/target-detail-copy";
import "./target-details.css";

type State=
  |{kind:"idle"}
  |{kind:"loading"}
  |{kind:"ready";content:TargetDetailContent;more:boolean}
  |{kind:"error";reason:TargetDetailFailure|"hidden"};

const humanDate=(day:string,locale:string)=>{
  try{
    return new Intl.DateTimeFormat(locale,{day:"numeric",month:"long",year:"numeric"})
      .format(new Date(day+"T12:00:00"));
  }catch{return day;}
};

function Shell({route,label,language,children,panelRef}:{
  route:TargetDetailRoute|null;label:string;language:DetailLanguage;
  children:React.ReactNode;panelRef:React.RefObject<HTMLElement|null>;
}){
  const copy=detailCopy[language];
  const close=useCallback(()=>closeTargetDetail(route),[route]);
  return <div className="backdrop inspectorBackdrop targetDetailBackdrop" onClick={close}>
    <aside ref={panelRef} tabIndex={-1} className="detail inspectorDetail targetDetail"
      data-testid="target-detail" data-detail-kind={route?.kind??"unavailable"}
      aria-label={label} onClick={event=>event.stopPropagation()}
      onKeyDown={event=>{
        if(event.key!=="Escape"||event.defaultPrevented)return;
        const target=event.target instanceof Element?event.target:null;
        if(target?.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]'))return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}>
      <button className="close inspectorClose" type="button" onClick={close}>
        <span className="inspectorCloseIcon"><span aria-hidden="true">×</span>
          <span className="inspectorCloseAccessible">{copy.close}</span></span>
        <span className="inspectorBackLabel">{copy.back}</span>
      </button>
      {children}
    </aside>
  </div>;
}

/** Calm answer for a malformed address or a kind that is switched off. */
function UnavailablePanel({language}:{language:DetailLanguage}){
  const copy=detailCopy[language];
  const ref=useRef<HTMLElement|null>(null);
  useEffect(()=>{ref.current?.focus({preventScroll:true});},[]);
  return <Shell route={null} label={copy.failures["not-available"]} language={language} panelRef={ref}>
    <p role="status" data-testid="target-detail-unavailable">{copy.failures["not-available"]}</p>
  </Shell>;
}

function Content({content,route,copy,gates,more,onMore}:{
  content:TargetDetailContent;route:TargetDetailRoute;copy:DetailCopy;gates:TargetDetailGates;
  more:boolean;onMore:()=>void;
}){
  const area=(kind:"private"|"shared")=>kind==="shared"?copy.areaShared:copy.areaPrivate;
  if(content.kind==="task"){
    const {task}=content;
    return <article className="targetDetailContent" data-area-kind={task.areaKind}>
      <p className="eyebrow">{copy.kindTask} · {area(task.areaKind)}</p>
      <h2>{task.title}</h2>
      <p>{task.status==="completed"?copy.statusCompleted:copy.statusOpen}</p>
      {task.dueOn&&<p>{copy.dueOn(humanDate(task.dueOn,copy.locale))}</p>}
      {task.assignedToMe&&<p>{copy.assignedToMe}</p>}
      {content.parentTitle!==null&&<p className="targetDetailParent">
        <span>{copy.parentProject}: </span>
        {route.view==="Projects"&&gates.project&&task.projectId!==null
          ?<button type="button" className="targetDetailLink"
              aria-label={copy.openParentProject(content.parentTitle)}
              onClick={event=>openTargetDetail({kind:"project",id:task.projectId as string,view:"Projects"},event.currentTarget)}>
              {content.parentTitle}</button>
          :<strong>{content.parentTitle}</strong>}
      </p>}
    </article>;
  }
  if(content.kind==="note"){
    const {note}=content;
    return <article className="targetDetailContent" data-area-kind={note.areaKind}>
      <p className="eyebrow">{copy.kindNote} · {area(note.areaKind)}</p>
      <h2>{note.title}</h2>
      {note.body.length===0
        ?<p className="targetDetailMuted">{copy.noteBodyEmpty}</p>
        :<div className="targetDetailNoteBody" data-testid="target-detail-note-body">{note.body}</div>}
    </article>;
  }
  const {page}=content;
  return <article className="targetDetailContent" data-area-kind={page.project.areaKind}>
    <p className="eyebrow">{copy.kindProject} · {area(page.project.areaKind)}</p>
    <h2>{page.project.title}</h2>
    <h3>{copy.tasksHeading}</h3>
    {page.tasks.length===0&&!page.hasMore
      ?<p className="targetDetailMuted">{copy.tasksEmpty}</p>
      :<ul className="targetDetailTasks">
        {page.tasks.map(task=><li key={task.id}>
          {gates.task
            ?<button type="button" className="targetDetailTaskRow"
                data-detail-row={detailRowKey("task",task.id)}
                aria-label={copy.taskOpen(task.title)}
                onClick={event=>openTargetDetail(
                  {kind:"task",id:task.id,view:"Projects",projectId:page.project.id},event.currentTarget)}>
                {task.title}</button>
            :<span className="targetDetailTaskText">{task.title}</span>}
        </li>)}
      </ul>}
    {page.hasMore&&<button type="button" disabled={more} onClick={onMore}>
      {more?copy.loadingMore:copy.loadMore}</button>}
  </article>;
}

function DetailBody({route,language,gates}:{
  route:TargetDetailRoute;language:DetailLanguage;gates:TargetDetailGates;
}){
  const copy=detailCopy[language];
  const {gate,onRefusal,retry}=useTargetGate();
  const session=useTargetSession(
    contextVersion=>createTargetDetailSession({kind:route.kind,id:route.id,contextVersion}),
    [route.kind,route.id]);
  const [state,setState]=useState<State>({kind:"idle"});
  const [nonce,setNonce]=useState(0);
  const epoch=useRef(0);
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const hiddenRef=useRef(false);
  const panelRef=useRef<HTMLElement|null>(null);
  const refusalRef=useRef(onRefusal);
  refusalRef.current=onRefusal;
  const ready=gate.kind==="ready";
  const kindLabel=route.kind==="task"?copy.kindTask:route.kind==="project"?copy.kindProject:copy.kindNote;

  useEffect(()=>{
    if(state.kind==="error"&&state.reason==="signed-out")refusalRef.current();
  },[state]);

  // Focus moves into the panel when it opens; closing returns it to the row.
  const key=detailRouteKey(route);
  useEffect(()=>{
    panelRef.current?.focus({preventScroll:true});
    return ()=>{expectFocusReturn(route);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key]);

  // A fresh server read for every open and every wake; never from a cache.
  useEffect(()=>{
    if(!session||!ready)return;
    const id=++epoch.current;
    if(document.visibilityState==="hidden"||!navigator.onLine){
      hiddenRef.current=true;
      setState({kind:"error",reason:navigator.onLine?"hidden":"offline"});
      return ()=>{epoch.current++;};
    }
    hiddenRef.current=false;
    setState({kind:"loading"});
    void session.load().then(result=>{
      if(epoch.current!==id)return;
      if(result.ok===true)setState({kind:"ready",content:result.content,more:false});
      else if(result.reason==="superseded")return;
      else setState({kind:"error",reason:result.reason==="not-ready"?"stale":result.reason});
    }).catch(()=>{if(epoch.current===id)setState({kind:"error",reason:"unavailable"});});
    return ()=>{epoch.current++;};
  },[session,ready,nonce]);

  // Privacy: content never stays on screen while hidden or offline.
  useEffect(()=>{
    const hide=(reason:"hidden"|"offline")=>{
      hiddenRef.current=true;
      epoch.current++;
      sessionRef.current?.suspend();
      setState({kind:"error",reason});
    };
    const wake=()=>{
      if(!hiddenRef.current||document.visibilityState==="hidden"||!navigator.onLine)return;
      hiddenRef.current=false;
      sessionRef.current?.resume();
      setNonce(value=>value+1);
    };
    const visibility=()=>document.visibilityState==="hidden"?hide("hidden"):wake();
    const offline=()=>hide("offline");
    const pagehide=()=>hide("hidden");
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)hiddenRef.current=true;wake();};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("offline",offline);
    window.addEventListener("online",wake);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("focus",wake);
    return ()=>{
      epoch.current++;
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",wake);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("focus",wake);
    };
  },[]);

  // Returning from a task to its project: focus the task row once rows exist.
  useEffect(()=>{if(state.kind==="ready")focusPendingRow();},[state]);

  const reload=useCallback(()=>{
    sessionRef.current?.resume();
    setNonce(value=>value+1);
  },[]);
  async function more(){
    if(state.kind!=="ready"||state.more||!session||
      document.visibilityState==="hidden"||!navigator.onLine)return;
    const current=state;
    const id=++epoch.current;
    setState({...current,more:true});
    const result=await session.loadMore();
    if(epoch.current!==id)return;
    if(result.ok===true)setState({kind:"ready",content:result.content,more:false});
    else if(result.reason==="superseded")return;
    else setState({kind:"error",reason:result.reason==="not-ready"?"stale":result.reason});
  }

  const content=state.kind==="ready"?state.content:null;
  const title=content?.kind==="task"?content.task.title:content?.kind==="note"?content.note.title
    :content?.kind==="project"?content.page.project.title:null;
  const label=title===null?copy.panelLabelLoading(kindLabel):copy.panelLabel(kindLabel,title);

  let gateView:React.ReactNode=null;
  if(gate.kind==="checking")
    gateView=<p role="status" data-testid="target-detail-checking">{copy.loading}</p>;
  else if(gate.kind==="feature_off")
    gateView=<TargetDataStatus error={{kind:"unavailable",action:"retry_later",message:copy.failures.unavailable}}
      language={language} onAction={retry}/>;
  else if(gate.kind==="unavailable")
    gateView=<TargetDataStatus failure="unavailable" language={language} onAction={retry}/>;
  else if(gate.kind==="signed_out"||gate.kind==="refused")
    gateView=<TargetDataStatus failure={gate.kind==="signed_out"?"signed-out":undefined}
      error={gate.kind==="refused"?{kind:"signed_out",action:"verify",message:copy.failures["signed-out"]}:undefined}
      language={language} onAction={retry}/>;

  return <Shell route={route} label={gateView?kindLabel:label} language={language} panelRef={panelRef}>
    {gateView}
    {!gateView&&<>
      <p role="status" className="targetDetailStatus">
        {state.kind==="loading"||state.kind==="idle"?copy.loading
          :state.kind==="error"&&state.reason==="hidden"?copy.hidden
          :state.kind==="ready"?copy.loaded:""}
      </p>
      {state.kind==="error"&&state.reason!=="hidden"&&
        <p role={state.reason==="not-available"?"status":"alert"} data-testid="target-detail-error"
          data-reason={state.reason}>{copy.failures[state.reason]}</p>}
      {state.kind==="error"&&state.reason!=="not-available"&&
        <button type="button" onClick={reload}>{copy.retry}</button>}
      {content&&state.kind==="ready"&&
        <Content content={content} route={route} copy={copy} gates={gates}
          more={state.more} onMore={()=>{void more();}}/>}
      {content&&<p className="targetDetailNote">{copy.readOnlyNote}</p>}
    </>}
  </Shell>;
}

export default function TargetDetailPanel({route,language="cs",gates}:{
  /** null: the address asked for something that cannot be opened. */
  route:TargetDetailRoute|null;language?:DetailLanguage;gates:TargetDetailGates;
}){
  if(route===null)return <UnavailablePanel language={language}/>;
  // Keyed by target: another item is a new session, never a reuse of old content.
  return <DetailBody key={detailRouteKey(route)} route={route} language={language} gates={gates}/>;
}
