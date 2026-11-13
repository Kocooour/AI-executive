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
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {wakeRetryDelay} from "../../lib/target-wake";
import {queuedTargetFetch} from "../../lib/target-read-queue";
import {emitTargetChange} from "../../lib/target-data-invalidation";
import {clearMainTitleSearchReturn} from "../../lib/target-main-title-search-ui";

// Shared one-at-a-time read queue: the server answers 503 beyond two concurrent reads.
const readFetch=queuedTargetFetch();

// A generic 404 covers missing and revoked content. When a detail opened from
// Search gets that answer, its previously authorized Search result must not
// survive a same-tab Close/Back and become visible or focusable again.
// Clear synchronously on the denied read, not on an incidental blur or poll.
function invalidateSearchOnDetailDenial(reason:TargetDetailFailure):TargetDetailFailure{
  if(reason==="not-available")clearMainTitleSearchReturn();
  return reason;
}
import {closeTargetDetail,detailRowKey,focusPendingRow,openTargetDetail} from "./target-detail-state";
import {
  createTargetDetailSession,type TargetDetailContent,type TargetDetailFailure,
} from "../../lib/target-detail-session";
import {
  detailIdOk,detailRouteKey,type TargetDetailGates,type TargetDetailRoute,
} from "../../lib/target-detail-route";
import {detailCopy,type DetailCopy,type DetailLanguage} from "../../lib/target-detail-copy";
import type {TargetUiEdits} from "../../lib/target-ui-config";
import {NoteEdits,TaskEdits,kindHasEdits,useDetailEdits,type DetailEditApi} from "./target-detail-edit";
import TargetNoteEditor from "./target-note-editor";
import TargetProjectTitleEditor from "./target-project-title-editor";
import TargetPrivateStructureCreate from "./target-private-project-create";
import {TARGET_PROJECT_TITLE_UPDATED} from "../../lib/target-project-title-edit-ui-gate";
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

const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function Shell({route,label,language,children,panelRef,onPrivateCapture}:{
  route:TargetDetailRoute|null;label:string;language:DetailLanguage;
  children:React.ReactNode;panelRef:React.RefObject<HTMLElement|null>;
  onPrivateCapture?:()=>void;
}){
  const copy=detailCopy[language];
  const close=useCallback(()=>closeTargetDetail(route),[route]);
  // Document level while the panel is open (also after clicking elsewhere, e.g. the
  // scope radio): Esc closes it and Tab / focus stay inside the panel.
  useEffect(()=>{
    const panel=panelRef.current;
    if(!panel)return;
    const onKey=(event:KeyboardEvent)=>{
      if(event.defaultPrevented)return;
      if(event.key==="Escape"){
        const target=event.target instanceof Element?event.target:null;
        if(target?.closest("input, textarea, select"))return;
        // Another modal (confirm, assistant, ...) owns Esc first.
        if(document.querySelector('[aria-modal="true"]:not([data-testid="target-detail"])'))return;
        event.preventDefault();
        close();
        return;
      }
      if(event.key!=="Tab")return;
      const items=Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(element=>element.getClientRects().length>0);
      if(items.length===0){event.preventDefault();panel.focus();return;}
      const first=items[0],last=items[items.length-1],active=document.activeElement;
      if(!panel.contains(active)){event.preventDefault();first.focus();}
      else if(event.shiftKey&&(active===first||active===panel)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&active===last){event.preventDefault();first.focus();}
    };
    const onFocusIn=(event:FocusEvent)=>{
      const target=event.target;
      if(!(target instanceof Node)||panel.contains(target))return;
      if(target instanceof Element&&target.closest('[aria-modal="true"]'))return;
      panel.focus({preventScroll:true});
    };
    document.addEventListener("keydown",onKey);
    document.addEventListener("focusin",onFocusIn);
    return ()=>{
      document.removeEventListener("keydown",onKey);
      document.removeEventListener("focusin",onFocusIn);
    };
  },[close,panelRef]);
  return <div className="backdrop inspectorBackdrop targetDetailBackdrop" onClick={close}>
    <aside ref={panelRef} tabIndex={-1} className="detail inspectorDetail targetDetail"
      role="dialog" aria-modal="true"
      data-testid="target-detail" data-detail-kind={route?.kind??"unavailable"}
      aria-label={label} onClick={event=>event.stopPropagation()}>
      <button className="close inspectorClose" type="button" onClick={close}>
        <span className="inspectorCloseIcon"><span aria-hidden="true">×</span>
          <span className="inspectorCloseAccessible">{copy.close}</span></span>
        <span className="inspectorBackLabel">{copy.back}</span>
      </button>
      {onPrivateCapture&&<button type="button" data-testid="target-detail-capture"
        onClick={onPrivateCapture}>
        ＋ {language==="cs"?"Nová soukromá poznámka":"New private note"}
      </button>}
      {children}
    </aside>
  </div>;
}

/** Calm answer for a malformed address or a kind that is switched off. */
function UnavailablePanel({language,onPrivateCapture}:{language:DetailLanguage;onPrivateCapture?:()=>void}){
  const copy=detailCopy[language];
  const ref=useRef<HTMLElement|null>(null);
  useEffect(()=>{ref.current?.focus({preventScroll:true});},[]);
  return <Shell route={null} label={copy.failures["not-available"]} language={language} panelRef={ref} onPrivateCapture={onPrivateCapture}>
    <p role="status" data-testid="target-detail-unavailable">{copy.failures["not-available"]}</p>
  </Shell>;
}

function Content({content,route,copy,gates,more,onMore,edit,noteEdit,projectEdit,createTask,onCommitted,onAccessRefused,language}:{
  content:TargetDetailContent;route:TargetDetailRoute;copy:DetailCopy;gates:TargetDetailGates;
  more:boolean;onMore:()=>void;edit:DetailEditApi|null;
  noteEdit:boolean;projectEdit:boolean;createTask:boolean;onCommitted:()=>void;onAccessRefused:()=>void;language:DetailLanguage;
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
        {route.view==="Projects"&&gates.project&&task.projectId!==null&&detailIdOk(task.projectId)
          ?<button type="button" className="targetDetailLink"
              aria-label={copy.openParentProject(content.parentTitle)}
              onClick={event=>openTargetDetail({kind:"project",id:task.projectId as string,view:"Projects"},event.currentTarget)}>
              {content.parentTitle}</button>
          :<strong>{content.parentTitle}</strong>}
      </p>}
      {edit&&<TaskEdits api={edit} task={task} expectedRevision={content.expectedRevision??null}/>}
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
      {/* One recovery-safe PATCH editor for every enabled note-edit profile. In
          4b the other controller remains responsible for note deletion only. */}
      {edit&&<NoteEdits api={edit} note={note} managedNoteEdit={noteEdit||edit.flags.noteEdit}/>}
      {(noteEdit||Boolean(edit?.flags.noteEdit))&&!edit?.deleted&&
        <TargetNoteEditor note={note} language={language}
          onCommitted={()=>{
            // The recovery-safe editor does not use the 4b controller, so its
            // successful PATCH must still invalidate note lists and the sidebar.
            emitTargetChange({kind:"note",id:note.id,change:"updated"});
            onCommitted();
          }} onAccessRefused={onAccessRefused}/>}
    </article>;
  }
  const {page}=content;
  return <article className="targetDetailContent" data-area-kind={page.project.areaKind}>
    <p className="eyebrow">{copy.kindProject} · {area(page.project.areaKind)}</p>
    <h2>{page.project.title}</h2>
    {projectEdit&&<TargetProjectTitleEditor project={page.project} language={language}
      onCommitted={onCommitted}
      onAccessRefused={()=>{window.dispatchEvent(new Event(TARGET_PROJECT_TITLE_UPDATED));onAccessRefused();}}/>}
    <h3>{copy.tasksHeading}</h3>
    {createTask&&gates.task&&page.project.areaKind==="private"&&
      <TargetPrivateStructureCreate kind="project-task" language={language}
        projectId={page.project.id} areaId={page.project.areaId}
        onCommitted={()=>onCommitted()}/>}
    {page.tasks.length===0&&!page.hasMore
      ?<p className="targetDetailMuted">{copy.tasksEmpty}</p>
      :<ul className="targetDetailTasks">
        {page.tasks.map(task=><li key={task.id}>
          {gates.task&&detailIdOk(task.id)
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

function DetailBody({route,language,gates,edits,noteEdit,projectEdit,createTask,onPrivateCapture}:{
  route:TargetDetailRoute;language:DetailLanguage;gates:TargetDetailGates;edits?:TargetUiEdits;noteEdit:boolean;projectEdit:boolean;createTask:boolean;
  onPrivateCapture?:()=>void;
}){
  const copy=detailCopy[language];
  const {gate,onRefusal,retry}=useTargetGate();
  const session=useTargetSession(
    contextVersion=>createTargetDetailSession({kind:route.kind,id:route.id,contextVersion},readFetch),
    [route.kind,route.id]);
  const [state,setState]=useState<State>({kind:"idle"});
  const [nonce,setNonce]=useState(0);
  const epoch=useRef(0);
  // A confirmed irreversible delete invalidates any GET already in flight.
  const deletedRef=useRef(false);
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const stateRef=useRef(state);
  stateRef.current=state;
  const panelRef=useRef<HTMLElement|null>(null);
  const refusalRef=useRef(onRefusal);
  refusalRef.current=onRefusal;
  const ready=gate.kind==="ready";
  const kindLabel=route.kind==="task"?copy.kindTask:route.kind==="project"?copy.kindProject:copy.kindNote;

  useEffect(()=>{
    if(state.kind==="error"&&(state.reason==="signed-out"||state.reason==="session-expired"))
      refusalRef.current(state.reason==="session-expired"?"session_expired":"session_revoked");
  },[state]);

  // Focus moves into the panel when it opens. (Closing returns it to the row; the
  // app root decides that from the address, so going deeper never steals it back.)
  const key=detailRouteKey(route);
  useEffect(()=>{panelRef.current?.focus({preventScroll:true});},[key]);

  // A read that fails because the network is not ready yet, or the server is momentarily busy
  // (503), is retried automatically with a bounded back-off before "Try again" is the only way on.
  const retryAttempt=useRef(0);
  const retryTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(retryTimer.current!==null)clearTimeout(retryTimer.current);},[]);
  const wake=useTargetWake({
    hide:reason=>{
      epoch.current++;
      sessionRef.current?.suspend();
      setState({kind:"error",reason});
    },
    ready:()=>{
      retryAttempt.current=0;
      sessionRef.current?.resume();
      setNonce(value=>value+1);
    },
    signedOut:()=>setState({kind:"error",reason:"signed-out"}),
  });

  // A fresh server read for every open and every wake; never from a cache.
  useEffect(()=>{
    if(!session||!ready)return;
    const id=++epoch.current;
    if(document.visibilityState==="hidden"||!navigator.onLine){
      wake.markHidden();
      setState({kind:"error",reason:navigator.onLine?"hidden":"offline"});
      return ()=>{epoch.current++;};
    }
    setState({kind:"loading"});
    void session.load().then(result=>{
      if(epoch.current!==id)return;
      if(result.ok===true){
        retryAttempt.current=0;
        setState({kind:"ready",content:result.content,more:false});
      }else if(result.reason==="superseded")return;
      else{
        const reason=invalidateSearchOnDetailDenial(
          result.reason==="not-ready"?"stale":result.reason);
        setState({kind:"error",reason});
        const delay=wakeRetryDelay(reason,retryAttempt.current);
        if(delay!==null){
          retryAttempt.current++;
          retryTimer.current=setTimeout(()=>{
            retryTimer.current=null;
            if(epoch.current!==id||document.visibilityState==="hidden"||!navigator.onLine)return;
            sessionRef.current?.resume();
            setNonce(value=>value+1);
          },delay);
        }
      }
    }).catch(()=>{if(epoch.current===id)setState({kind:"error",reason:"unavailable"});});
    return ()=>{epoch.current++;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session,ready,nonce]);

  // Passive revalidation (runtime tick, ~60 s, visible + online only): membership loss
  // does not change the auth generation, so an open detail re-reads. The shown
  // content is replaced only by the complete new result; any failure removes it
  // (a 404 becomes the calm not-available state).
  const editRef=useRef<DetailEditApi|null>(null);
  const revalidate=useCallback(()=>{
    const current=stateRef.current;
    const live=sessionRef.current;
    if(current.kind!=="ready"||current.more||!live)return;
    // A deleted item is gone: never re-read it (that would replace the confirmation by a 404).
    if(deletedRef.current||editRef.current?.deleted)return;
    const id=++epoch.current;
    const wanted=current.content.kind==="project"?current.content.page.tasks.length:0;
    void (async()=>{
      let result=await live.load();
      // Keep the user's position: re-walk as many pages as were loaded before.
      for(let guard=0;guard<20&&result.ok===true&&result.content.kind==="project"&&
        result.content.page.hasMore&&result.content.page.tasks.length<wanted;guard++)
        result=await live.loadMore();
      if(epoch.current!==id||deletedRef.current)return;
      if(result.ok===true)setState({kind:"ready",content:result.content,more:false});
      else if(result.reason==="superseded")return;
      else setState({kind:"error",reason:invalidateSearchOnDetailDenial(
        result.reason==="not-ready"?"stale":result.reason)});
    })().catch(()=>{if(epoch.current===id&&!deletedRef.current)setState({kind:"error",reason:"unavailable"});});
  },[]);
  useTargetTick(revalidate);

  // Returning from a task to its project: focus the task row once rows exist.
  useEffect(()=>{if(state.kind==="ready")focusPendingRow();},[state]);

  const reload=useCallback(()=>{
    retryAttempt.current=0;
    sessionRef.current?.resume();
    setNonce(value=>value+1);
  },[]);
  // A denied edit GET/PATCH may signal a revoked Area membership. Hide the
  // entire previously authorized note immediately, not only its edit button.
  // A new server read can still show a viewer-authorized note after a role
  // downgrade. Supersede all earlier reads so no stale content reappears.
  const invalidateAndReload=useCallback(()=>{
    epoch.current++;
    sessionRef.current?.suspend();
    setState({kind:"loading"});
    retryAttempt.current=0;
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
  // The accessible name follows what is shown: title, loading, or the sentence of the error/hidden state.
  const label=title!==null?copy.panelLabel(kindLabel,title)
    :state.kind==="error"?(state.reason==="hidden"?copy.hidden:copy.failures[state.reason==="session-expired"?"signed-out":state.reason])
    :copy.panelLabelLoading(kindLabel);

  const edit=useDetailEdits({
    route,language,edits,content,sessionKey:session,
    removed:state.kind==="error"?state.reason:null,
    readFetch,onRefusal,revalidate,
    onDeleted:()=>{deletedRef.current=true;epoch.current++;},
    onClose:()=>closeTargetDetail(route),
  });
  editRef.current=edit;

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

  return <Shell route={route} label={gateView?kindLabel:label} language={language} panelRef={panelRef} onPrivateCapture={onPrivateCapture}>
    {gateView}
    {!gateView&&<>
      <p role="status" className="targetDetailStatus">
        {state.kind==="loading"||state.kind==="idle"?copy.loading
          :state.kind==="error"&&state.reason==="hidden"?copy.hidden
          :state.kind==="ready"?copy.loaded:""}
      </p>
      {state.kind==="error"&&state.reason!=="hidden"&&
        <p role={state.reason==="not-available"?"status":"alert"} data-testid="target-detail-error"
          data-reason={state.reason}>{copy.failures[state.reason==="session-expired"?"signed-out":state.reason]}</p>}
      {state.kind==="error"&&state.reason!=="not-available"&&
        <button type="button" onClick={reload}>{copy.retry}</button>}
      {content&&state.kind==="ready"&&
        <Content content={content} route={route} copy={copy} gates={gates}
          more={state.more} onMore={()=>{void more();}} edit={edit}
          noteEdit={noteEdit} projectEdit={projectEdit} createTask={createTask} onCommitted={reload} onAccessRefused={invalidateAndReload}
          language={language}/>}
      {content&&!(noteEdit&&content.kind==="note")&&!(projectEdit&&content.kind==="project")&&!(edit&&kindHasEdits(content.kind,edits))&&
        !(createTask&&content.kind==="project"&&content.page.project.areaKind==="private")&&
        <p className="targetDetailNote">{copy.readOnlyNote}</p>}
    </>}
  </Shell>;
}

export default function TargetDetailPanel({route,language="cs",gates,edits,noteEdit=false,projectEdit=false,createTask=false,onPrivateCapture}:{
  /** null: the address asked for something that cannot be opened. */
  route:TargetDetailRoute|null;language?:DetailLanguage;gates:TargetDetailGates;
  /** R3-FE-4b: which edits exist at all (server-derived flags); absent = read-only as in 4a. */
  edits?:TargetUiEdits;noteEdit?:boolean;projectEdit?:boolean;createTask?:boolean;
  onPrivateCapture?:()=>void;
}){
  if(route===null)return <UnavailablePanel language={language} onPrivateCapture={onPrivateCapture}/>;
  // Keyed by target: another item is a new session, never a reuse of old content.
  return <DetailBody key={detailRouteKey(route)} route={route} language={language} gates={gates} edits={edits} noteEdit={noteEdit&&gates.note} projectEdit={projectEdit&&gates.project} createTask={createTask&&gates.project&&gates.task} onPrivateCapture={onPrivateCapture}/>;
}
