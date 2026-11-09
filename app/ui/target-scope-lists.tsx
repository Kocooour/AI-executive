"use client";
/** R3-FE-3: read-only Projects / Notes lists of the main app in target mode.
 * Rows are exactly what the server global index returned for the selected
 * scope (Vše / Osobní / Sdílené) from the dedicated project-index / note-index
 * endpoint of this view's kind: no client-side kind picking, filtering or
 * counting, only presentation (titles grouped by Area).
 *
 * Lifecycle (as R3-FE-2): a read exists only for a server-confirmed runtime
 * generation; the feature session is created by useTargetSession (keyed by
 * generation and scope), so a generation or scope change disposes it and drops
 * every row at once. Hidden / pagehide / offline hide the titles; a 401 goes
 * through the refusal budget. Nothing is persisted and nothing is logged. */
import {useCallback,useEffect,useRef,useState} from "react";
import {useTargetSession} from "./target-data-provider";
import {TargetDataStatus} from "./target-data-status";
import {useTargetGate} from "./use-target-gate";
import {useTargetScope} from "./target-scope-state";
import {createKindIndexReadSession} from "../../lib/target-staging-kind-index-client";
import type {GlobalIndexFailure,GlobalIndexItem,GlobalIndexPage} from "../../lib/target-staging-global-index-client";
import {
  consumeGlobalIndexWake,initialGlobalIndexWakeGate,invalidateGlobalIndexWakeGate,
} from "../../lib/target-staging-global-index-lifecycle";
import {groupIndexRowsByArea} from "../../lib/target-scope-rows";
import {scopesCopy,type ScopesLanguage} from "../../lib/target-scopes-copy";
import "./target-scopes.css";

type Session=NonNullable<ReturnType<typeof useScopeSession>>;
type State=
  |{kind:"idle"}
  |{kind:"loading";session:Session}
  |{kind:"ready";session:Session;page:GlobalIndexPage;more:boolean}
  |{kind:"error";reason:GlobalIndexFailure|"hidden"};

// Typing helper only: the hook is called through useTargetSession below.
function useScopeSession(kind:"project"|"note",scope:"all"|"personal"|"shared"){
  return useTargetSession(contextVersion=>createKindIndexReadSession(kind,{scope,contextVersion}),[kind,scope]);
}

export default function TargetScopeLists({kind,language="cs"}:{
  kind:"project"|"note";language?:ScopesLanguage;
}){
  const copy=scopesCopy[language];
  const scope=useTargetScope();
  const {gate,onRefusal,retry}=useTargetGate();
  const session=useScopeSession(kind,scope);
  const [state,setState]=useState<State>({kind:"idle"});
  const [nonce,setNonce]=useState(0);
  const epoch=useRef(0);
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const statusRef=useRef<HTMLParagraphElement>(null);
  const wakeGate=useRef(initialGlobalIndexWakeGate());
  const refusalRef=useRef(onRefusal);
  refusalRef.current=onRefusal;
  const ready=gate.kind==="ready";

  useEffect(()=>{
    if(state.kind==="error"&&state.reason==="signed-out")refusalRef.current();
  },[state]);

  // First page of the selected scope; reruns for a new session (scope or
  // generation change) and for an explicit reload / wake.
  useEffect(()=>{
    if(!session||!ready)return;
    const id=++epoch.current;
    if(document.visibilityState==="hidden"||!navigator.onLine){
      setState({kind:"error",reason:navigator.onLine?"hidden":"offline"});
      return ()=>{epoch.current++;};
    }
    setState({kind:"loading",session});
    void session.loadFirst().then(result=>{
      if(epoch.current!==id)return;
      if(result.ok===true)setState({kind:"ready",session,page:result.page,more:false});
      else if(result.reason==="superseded")return;
      else setState({kind:"error",reason:result.reason==="busy"||result.reason==="not-ready"?"stale":result.reason});
    }).catch(()=>{if(epoch.current===id)setState({kind:"error",reason:"unavailable"});});
    return ()=>{epoch.current++;};
  },[session,ready,nonce]);

  // Privacy: titles never stay on screen while the tab is hidden or offline.
  useEffect(()=>{
    wakeGate.current=consumeGlobalIndexWake(wakeGate.current,Date.now(),true).gate;
    const hide=(reason:"hidden"|"offline"="hidden")=>{
      wakeGate.current=invalidateGlobalIndexWakeGate(wakeGate.current);
      epoch.current++;
      sessionRef.current?.suspend();
      setState({kind:"error",reason});
    };
    const wake=(force=false)=>{
      if(document.visibilityState==="hidden"||!navigator.onLine)return;
      const choice=consumeGlobalIndexWake(wakeGate.current,Date.now(),force);
      wakeGate.current=choice.gate;
      if(!choice.reload)return;
      sessionRef.current?.resume();
      setNonce(value=>value+1);
    };
    const visibility=()=>document.visibilityState==="hidden"?hide():wake();
    const offline=()=>hide("offline");
    const online=()=>wake(true);
    const pagehide=()=>hide();
    const pageshow=(event:PageTransitionEvent)=>wake(event.persisted);
    const focus=()=>wake();
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("offline",offline);
    window.addEventListener("online",online);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("focus",focus);
    return ()=>{
      epoch.current++;
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",online);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("focus",focus);
    };
  },[]);

  const reload=useCallback(()=>{
    sessionRef.current?.resume();
    setNonce(value=>value+1);
  },[]);
  async function more(){
    if(state.kind!=="ready"||state.more||!state.page.hasMore||state.session!==session||
      document.visibilityState==="hidden"||!navigator.onLine)return;
    const current=state;
    const id=++epoch.current;
    setState({...current,more:true});
    const result=await current.session.loadMore();
    if(epoch.current!==id)return;
    if(result.ok===true)setState({kind:"ready",session:current.session,page:result.page,more:false});
    else if(result.reason==="superseded")return;
    else setState({kind:"error",reason:result.reason==="busy"||result.reason==="not-ready"?"stale":result.reason});
  }

  if(gate.kind==="checking")
    return <div className="targetScopeGate" data-testid="target-scope-checking">
      <p role="status">{copy.gateChecking}</p>
    </div>;
  if(gate.kind==="feature_off")
    return <div className="targetScopeGate" data-testid="target-scope-feature-off">
      <TargetDataStatus error={{kind:"unavailable",action:"retry_later",message:copy.gateFeatureOff}}
        language={language} onAction={retry}/>
    </div>;
  if(gate.kind==="unavailable")
    return <div className="targetScopeGate" data-testid="target-scope-unavailable">
      <TargetDataStatus failure="unavailable" language={language} onAction={retry}/>
    </div>;
  if(gate.kind==="signed_out"||gate.kind==="refused")
    return <div className="targetScopeGate" data-testid={gate.kind==="refused"?"target-scope-refused":"target-scope-signed-out"}>
      <TargetDataStatus error={gate.kind==="refused"?{kind:"signed_out",action:"verify",
        message:copy.gateRefused}:undefined}
        language={language} failure={gate.kind==="signed_out"?"signed-out":undefined}
        onAction={retry}/>
    </div>;

  // Rows are shown only for the CURRENT session and scope: right after a scope
  // change the previous scope's rows are already gone from this render.
  const page=state.kind==="ready"&&state.session===session&&state.page.scope===scope?state.page:null;
  const rows:GlobalIndexItem[]=page?page.items:[];
  const groups=groupIndexRowsByArea(rows);
  return <section className="targetScopeList" data-testid="target-scope-list"
    data-scope={scope} data-kind={kind}
    aria-label={kind==="project"?copy.projectsRegion:copy.notesRegion}>
    <p ref={statusRef} role="status" tabIndex={-1} className="targetScopeStatus">
      {state.kind==="error"?copy.hidden
        :state.kind==="ready"&&state.more?copy.loadingMore
        :page?copy.loaded:copy.loading}
    </p>
    {state.kind==="error"&&state.reason!=="hidden"&&<p role="alert">{copy.reasons[state.reason]}</p>}
    {state.kind==="error"&&<button type="button" onClick={reload}>{copy.reload}</button>}
    {page&&(rows.length===0&&!page.hasMore
      ?<p>{kind==="project"?copy.projectsEmpty:copy.notesEmpty}</p>
      :groups.map(group=><ul key={group.areaId} className="targetScopeGroup"
        data-area-kind={group.areaKind}
        aria-label={group.areaKind==="private"?copy.groupPersonal:copy.groupShared}>
        {group.items.map(entry=><li key={entry.item.id} className="targetScopeRow">{entry.item.title}</li>)}
      </ul>))}
    {page&&page.hasMore&&state.kind==="ready"&&<button type="button" disabled={state.more}
      onClick={()=>{statusRef.current?.focus();void more();}}>
      {state.more?copy.loadingMore:copy.loadMore}</button>}
    {page&&<p className="targetScopeNote">{kind==="note"?copy.notesTitleOnlyNote:copy.readOnlyNote}</p>}
  </section>;
}
