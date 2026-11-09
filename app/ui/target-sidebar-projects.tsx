"use client";
/** R3-FE-4a: in target mode the sidebar lists the project INDEX of the global
 * reading scope (owner decision 2026-11-09), never the legacy workspace
 * projects. Same session and lifecycle as the Projects list: a read exists
 * only for a server-confirmed generation and the current scope; a generation or
 * scope change drops every title at once; hidden / pagehide / offline hide
 * them; 401 goes through the refusal budget. Compact: first page only, with a
 * link to the full Projects list. Nothing is persisted or logged. */
import {useEffect,useRef,useState} from "react";
import {useTargetSession} from "./target-data-provider";
import {useTargetGate} from "./use-target-gate";
import {useTargetScope} from "./target-scope-state";
import {createKindIndexReadSession} from "../../lib/target-staging-kind-index-client";
import type {GlobalIndexPage} from "../../lib/target-staging-global-index-client";
import {detailCopy,type DetailLanguage} from "../../lib/target-detail-copy";
import {detailIdOk,detailRouteFromSearch} from "../../lib/target-detail-route";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {useTargetSearch} from "./target-detail-state";
import "./target-details.css";

type State=
  |{kind:"idle"}
  |{kind:"ready";page:GlobalIndexPage}
  |{kind:"error";reason:"hidden"|"failed"};

export default function TargetSidebarProjects({language="cs",openable,onOpen,onShowAll}:{
  language?:DetailLanguage;
  /** The project detail flag; without it rows stay text. */
  openable:boolean;
  onOpen:(projectId:string,opener:HTMLElement)=>void;
  onShowAll:()=>void;
}){
  const copy=detailCopy[language];
  const scope=useTargetScope();
  const search=useTargetSearch(true);
  const open=detailRouteFromSearch(search);
  const {gate,onRefusal}=useTargetGate();
  const session=useTargetSession(
    contextVersion=>createKindIndexReadSession("project",{scope,limit:50,contextVersion}),[scope]);
  const [state,setState]=useState<State>({kind:"idle"});
  const [nonce,setNonce]=useState(0);
  const epoch=useRef(0);
  const sessionRef=useRef(session);
  sessionRef.current=session;
  const stateRef=useRef(state);
  stateRef.current=state;
  const refusalRef=useRef(onRefusal);
  refusalRef.current=onRefusal;
  const ready=gate.kind==="ready";

  useEffect(()=>{
    if(!session||!ready)return;
    const id=++epoch.current;
    if(document.visibilityState==="hidden"||!navigator.onLine){
      wake.markHidden();
      setState({kind:"error",reason:"hidden"});
      return ()=>{epoch.current++;};
    }
    setState({kind:"idle"});
    void session.loadFirst().then(result=>{
      if(epoch.current!==id)return;
      if(result.ok===true)setState({kind:"ready",page:result.page});
      else if(result.reason==="superseded")return;
      else{
        if(result.reason==="signed-out")refusalRef.current();
        setState({kind:"error",reason:"failed"});
      }
    }).catch(()=>{if(epoch.current===id)setState({kind:"error",reason:"failed"});});
    return ()=>{epoch.current++;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[session,ready,nonce]);

  const wake=useTargetWake({
    hide:()=>{
      epoch.current++;
      sessionRef.current?.suspend();
      setState({kind:"error",reason:"hidden"});
    },
    ready:()=>{
      sessionRef.current?.resume();
      setNonce(value=>value+1);
    },
    failed:()=>setState({kind:"error",reason:"failed"}),
  });
  // Passive revalidation on the runtime tick: the first page is re-read; failure hides it.
  useTargetTick(()=>{
    const live=sessionRef.current;
    if(!live||stateRef.current.kind!=="ready")return;
    const id=++epoch.current;
    void live.loadFirst().then(result=>{
      if(epoch.current!==id)return;
      if(result.ok===true)setState({kind:"ready",page:result.page});
      else if(result.reason==="superseded")return;
      else{
        if(result.reason==="signed-out")refusalRef.current();
        setState({kind:"error",reason:"failed"});
      }
    }).catch(()=>{if(epoch.current===id)setState({kind:"error",reason:"failed"});});
  });

  // Titles are shown only for the CURRENT session and scope.
  const page=state.kind==="ready"&&state.page.scope===scope?state.page:null;
  const projects=page?page.items.filter(entry=>entry.kind==="project"):[];
  const openId=open?.kind==="project"?open.id:null;
  return <section className="sidebarProjects targetSidebarProjects" aria-label={copy.sidebarProjects}
    data-testid="target-sidebar-projects" data-scope={scope}>
    {projects.map(entry=>{
      const item=entry.item;
      return openable&&detailIdOk(item.id)
        ?<button type="button" key={item.id} data-sidebar-target-project={item.id}
            aria-current={openId===item.id?"page":undefined}
            className={openId===item.id?"active":undefined}
            title={item.title} aria-label={copy.sidebarProjectOpen(item.title)}
            onClick={event=>onOpen(item.id,event.currentTarget)}>
            <span className="targetSidebarProjectTitle">{item.title}</span>
          </button>
        :<span key={item.id} className="targetSidebarProjectRow" title={item.title}>{item.title}</span>;
    })}
    {page&&projects.length===0&&<small>{copy.sidebarEmpty}</small>}
    {page&&page.hasMore&&<button type="button" onClick={onShowAll}>{copy.sidebarAll}</button>}
    {state.kind==="error"&&<small role="status">
      {state.reason==="hidden"?copy.sidebarHidden:copy.sidebarUnavailable}</small>}
  </section>;
}
