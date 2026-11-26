"use client";
/** E-1: private task candidates only. Mounted inside the verified Home reader;
 * no local persistence, no legacy fallback, no project inference. */
import {useCallback,useEffect,useRef,useState} from "react";
import {useTargetWake,useTargetTick} from "./use-target-revalidation";
import {useTargetRuntime} from "./target-data-provider";
import {openTargetDetail} from "./target-detail-state";
import {targetAppFetch} from "../../lib/target-app-fetch";
import {subscribeTargetChange} from "../../lib/target-data-invalidation";
import {detailIdOk} from "../../lib/target-detail-route";
import {readHomeAttention,readMoreHomeAttention,changeHomeAttention,undoHomeAttention,HOME_ATTENTION_LIMIT,type HomeAttentionUndo}
  from "../../lib/target-home-attention-actions";
import type {AttentionPage,AttentionItem} from "../../lib/target-staging-attention-client";
import "./target-home-attention.css";

type Language="cs"|"en";
type State={kind:"loading"}|{kind:"error"}|{kind:"ready";page:AttentionPage};
type DisplayUndo={witness:HomeAttentionUndo;title:string;action:"snooze"|"dismiss"};
const DAY=86_400_000;
function localMinute(ms:number):string{
  const d=new Date(ms),pad=(n:number)=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+
    "T"+pad(d.getHours())+":"+pad(d.getMinutes());
}
function tomorrowMorning():number{
  const d=new Date();d.setDate(d.getDate()+1);d.setHours(8,0,0,0);return d.getTime();
}
const labels={
  cs:{heading:"Vyžaduje pozornost",why:"Proč?",snooze:"Odložit",dismiss:"Skrýt",
    undo:"Zpět",more:"Další upozornění",less:"Méně upozornění",retry:"Zkusit znovu",
    error:"Upozornění nelze bezpečně načíst.",conflict:"Změnu se nepodařilo bezpečně potvrdit. Zkontrolujte aktuální stav.",
    uncertain:"Výsledek změny není potvrzen. Zkontrolujte aktuální stav.",
    unavailable:"Nepodařilo se spojit, zkuste to znovu.",undoSnooze:"Zpět: odložení úkolu ",undoDismiss:"Zpět: skrytí úkolu ",tomorrow:"Zítra 8:00",
    changed:"Upozornění bylo upraveno.",restored:"Upozornění bylo obnoveno.",
    day:"Za 24 hodin",week:"Za týden",custom:"Vlastní čas (čas zařízení)",confirm:"Potvrdit",
    cancel:"Zrušit",invalid:"Zvolte budoucí čas, nejvýše 30 dní od nynějška.",
    overdue:"Po termínu",soon:"Blíží se termín",passed:"Propadlé Kdy",sourceDue:"Zdroj: termín úkolu",
    sourceWhen:"Zdroj: osobní plán (Kdy)",evaluated:"Vyhodnoceno",loading:"Načítám upozornění…",open:"Otevřít úkol"},
  en:{heading:"Needs attention",why:"Why?",snooze:"Snooze",dismiss:"Dismiss",undo:"Undo",
    more:"More attention items",less:"Fewer attention items",retry:"Retry",
    error:"Attention items could not be loaded safely.",conflict:"The change could not be confirmed safely. Check the current state.",
    uncertain:"The outcome is unconfirmed. Check the current state.",
    unavailable:"Could not connect. Try again.",undoSnooze:"Undo snoozing task ",undoDismiss:"Undo dismissing task ",tomorrow:"Tomorrow at 8:00",
    changed:"Attention item updated.",restored:"Attention item restored.",
    day:"In 24 hours",week:"In a week",custom:"Custom time (device time)",confirm:"Confirm",
    cancel:"Cancel",invalid:"Choose a future time within 30 days.",
    overdue:"Overdue",soon:"Due soon",passed:"Planned day passed",sourceDue:"Source: task deadline",
    sourceWhen:"Source: personal plan (When)",evaluated:"Evaluated",loading:"Loading attention items…",open:"Open task"},
} as const;

export function TargetHomeAttention({language,openable,onRefusal,generation}:{
  language:Language;openable:boolean;onRefusal:()=>void;generation:string;
}){
  const t=labels[language],runtime=useTargetRuntime();
  const [state,setState]=useState<State>({kind:"loading"});
  const [hidden,setHidden]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [expanded,setExpanded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  // Feedback is transient; an empty attention section must disappear even
  // after the final mutation. Undo has its own independent lifetime.
  useEffect(()=>{
    if(!notice)return;
    const timer=window.setTimeout(()=>setNotice(""),8_000);
    return ()=>window.clearTimeout(timer);
  },[notice]);
  const [undo,setUndo]=useState<DisplayUndo|null>(null);
  const [picker,setPicker]=useState<string|null>(null);
  const [custom,setCustom]=useState("");
  const heading=useRef<HTMLHeadingElement>(null);
  const sectionRef=useRef<HTMLElement>(null),feedbackRef=useRef<HTMLParagraphElement>(null);
  const undoRef=useRef<HTMLButtonElement>(null),retryRef=useRef<HTMLButtonElement>(null);
  const focusedBeforeSwap=useRef<Element|null>(null);
  const actionRef=useRef<AbortController|null>(null);
  const readRef=useRef<AbortController|null>(null);
  const focusPending=useRef(false);
  const refreshPending=useRef(false);
  const pickerRef=useRef<string|null>(null);
  const displayed=useRef({state,expanded});
  displayed.current={state,expanded};
  // A refresh counter is not a loading-state transition. Keep the verified
  // snapshot and keyed DOM until the fresh read completes.
  const reload=useCallback(()=>{
    readRef.current?.abort();
    setRefresh(n=>n+1);
  },[]);
  const closePicker=useCallback(()=>{
    pickerRef.current=null;setPicker(null);setCustom("");
    if(refreshPending.current&&!actionRef.current){
      refreshPending.current=false;reload();
    }
  },[reload]);
  const openPicker=(key:string)=>{
    if(pickerRef.current===key){closePicker();return;}
    pickerRef.current=key;setPicker(key);setCustom("");
    if(readRef.current){refreshPending.current=true;readRef.current.abort();}
  };
  const live=()=>Boolean(runtime?.known()&&runtime.generation()===generation&&
    document.visibilityState!=="hidden"&&navigator.onLine);
  const conceal=()=>{
    readRef.current?.abort();actionRef.current?.abort();actionRef.current=null;
    refreshPending.current=false;focusPending.current=false;focusedBeforeSwap.current=null;pickerRef.current=null;
    setHidden(true);setState({kind:"loading"});setUndo(null);setNotice("");
    setBusy(false);setPicker(null);setExpanded(false);setCustom("");
  };
  const {markHidden}=useTargetWake({
    hide:conceal,signedOut:conceal,
    ready(result){if(result==="unavailable"){conceal();markHidden();return;}
      setHidden(false);reload();},
  });
  // Routine verified polls and data invalidation never cancel a write or
  // discard its confirmed Undo. Defer read until the command/receipt settles.
  const revalidate=useCallback(()=>{
    if(actionRef.current||pickerRef.current!==null){
      // A verified same-actor tick is not a privacy boundary. Preserve the
      // editor and action witness, coalesce a fresh read when they settle.
      refreshPending.current=true;return;
    }
    reload();
  },[reload]);
  useTargetTick(revalidate);
  useEffect(()=>subscribeTargetChange(revalidate),[revalidate]);
  useEffect(()=>{
    if(hidden)return;
    if(document.visibilityState==="hidden"||!navigator.onLine){markHidden();conceal();return;}
    if(actionRef.current||pickerRef.current!==null){refreshPending.current=true;return;}
    const controller=new AbortController();
    readRef.current=controller;
    const before=displayed.current;
    const count=before.expanded&&before.state.kind==="ready"?before.state.page.items.length:HOME_ATTENTION_LIMIT;
    const fail=(unauthorized=false)=>{
      if(controller.signal.aborted)return;
      const active=document.activeElement;
      if(active&&sectionRef.current?.contains(active))focusedBeforeSwap.current=active;
      pickerRef.current=null;setPicker(null);setCustom("");setExpanded(false);
      setState({kind:"error"});setUndo(null);
      if(unauthorized)onRefusal();
    };
    void (async()=>{
      let result=await readHomeAttention(controller.signal,targetAppFetch,language);
      // Rebuild the expanded extent from one fresh pinned cursor chain;
      // never combine new first-page data with a stale appended page.
      while(!controller.signal.aborted&&result.status==="ok"&&
        result.page.hasMore&&result.page.items.length<count){
        result=await readMoreHomeAttention(result.page,controller.signal);
      }
      if(controller.signal.aborted)return;
      if(result.status!=="ok"){fail(result.status==="unauthorized");return;}
      const page=result.page,active=document.activeElement;
      if(active&&sectionRef.current?.contains(active))focusedBeforeSwap.current=active;
      setState({kind:"ready",page});
      setUndo(old=>old&&old.witness.expectedHideEpoch!==page.attentionEpoch?null:old);
    })().catch(()=>fail()).finally(()=>{
      if(readRef.current===controller)readRef.current=null;
    });
    return ()=>{controller.abort();if(readRef.current===controller)readRef.current=null;};
  },[refresh,generation,hidden,markHidden,onRefusal,language]);
  useEffect(()=>()=>{readRef.current?.abort();actionRef.current?.abort();},[]);
  useEffect(()=>{
    if(state.kind==="loading")return;
    const previous=focusedBeforeSwap.current;focusedBeforeSwap.current=null;
    const active=document.activeElement;
    const lost=previous!==null&&active===document.body;
    // A keyed row can move without being destroyed; browsers may still
    // blur the moved node. Restore that exact element, not its heading.
    if(!focusPending.current&&lost&&previous instanceof HTMLElement&&previous.isConnected){
      previous.focus();return;
    }
    if(focusPending.current||lost){
      focusPending.current=false;
      // Do not steal focus from an unrelated control reached meanwhile.
      if(lost||active===document.body||sectionRef.current?.contains(active)){
        const empty=state.kind==="ready"&&!state.page.items.length;
        (empty&&undoRef.current?undoRef.current:heading.current||retryRef.current||feedbackRef.current)?.focus();
      }
    }
  },[state]);
  const start=()=>{
    if(actionRef.current||!live()||hidden)return null;
    const controller=new AbortController();
    if(readRef.current){refreshPending.current=true;readRef.current.abort();}
    actionRef.current=controller;setBusy(true);setNotice("");
    return controller;
  };
  const finish=(controller:AbortController)=>{
    if(actionRef.current===controller){actionRef.current=null;setBusy(false);
      if(refreshPending.current&&pickerRef.current===null){refreshPending.current=false;reload();}
    }
  };
  async function more(){
    if(state.kind!=="ready")return;
    const controller=start();if(!controller)return;
    try{
      const result=await readMoreHomeAttention(state.page,controller.signal);
      if(controller.signal.aborted||!live())return;
      if(result.status==="ok"){setState({kind:"ready",page:result.page});setExpanded(true);}
      else{setUndo(null);setState({kind:"error"});setExpanded(false);
        if(result.status==="unauthorized")onRefusal();}
    }catch{if(!controller.signal.aborted){setState({kind:"error"});setUndo(null);setExpanded(false);}}
    finally{finish(controller);}
  }
  async function hide(item:AttentionItem,action:"snooze"|"dismiss",until:number|null){
    if(state.kind!=="ready")return;
    if(action==="snooze"&&(until===null||!Number.isFinite(until)||until<=Date.now()||until>Date.now()+30*DAY)){
      setNotice(t.invalid);return;
    }
    const controller=start();if(!controller)return;
    setUndo(null);
    try{
      let committed:HomeAttentionUndo|null=null;
      const result=await changeHomeAttention({item,attentionEpoch:state.page.attentionEpoch},
        action,until,controller.signal,targetAppFetch,command=>{committed=command;});
      if(controller.signal.aborted||!live())return;
      if(result.status==="ok"){setUndo(committed?{witness:committed,title:item.title,action}:null);setNotice(t.changed);}
      else{setNotice(result.status==="uncertain"?t.uncertain:result.status==="unavailable"?t.unavailable:t.conflict);
        if(result.status==="unauthorized")onRefusal();}
      closePicker();focusPending.current=true;refreshPending.current=true;
    }catch{if(!controller.signal.aborted){closePicker();setNotice(t.uncertain);refreshPending.current=true;}}
    finally{finish(controller);}
  }
  async function restore(){
    if(!undo)return;
    const controller=start();if(!controller)return;
    const original=undo.witness;setUndo(null);
    try{
      const result=await undoHomeAttention(original,controller.signal);
      if(controller.signal.aborted||!live())return;
      setNotice(result.status==="ok"?t.restored:result.status==="uncertain"?t.uncertain:result.status==="unavailable"?t.unavailable:t.conflict);
      if(result.status==="unauthorized")onRefusal();
      focusPending.current=true;refreshPending.current=true;
    }catch{if(!controller.signal.aborted){setNotice(t.uncertain);refreshPending.current=true;}}
    finally{finish(controller);}
  }
  if(hidden)return null;
  // Mount the live region before any mutation, independent of rows and
  // transient loading/error states. Empty feedback adds no Home padding.
  const feedback=<p ref={feedbackRef} className="targetHomeAttentionFeedback" role="status"
    aria-live="polite" aria-atomic="true" tabIndex={-1}>{notice}</p>;
  const panel=()=>{
  if(state.kind==="loading")return <p role="status">{t.loading}</p>;
  if(state.kind==="error")return <section role="status"><p>{t.error}</p>
    <button ref={retryRef} type="button" onClick={reload}>{t.retry}</button></section>;
  const {page}=state;
  if(page.explanationLanguage!==language||!page.explanations)return <p role="status">{t.loading}</p>;
  if(!page.items.length&&!undo)return null;
  const items=expanded?page.items:page.items.slice(0,HOME_ATTENTION_LIMIT);
  const explanations=new Map(page.explanations.map(x=>[x.attentionKey,x]));
  return <section ref={sectionRef} className="targetOverviewSection targetHomeAttention" data-testid="target-home-attention"
    aria-label={t.heading}>
    <h2 tabIndex={-1} ref={heading}>{t.heading}</h2>
    {undo&&<button ref={undoRef} type="button" disabled={busy||picker!==null}
      aria-label={(undo.action==="snooze"?t.undoSnooze:t.undoDismiss)+undo.title}
      onClick={()=>void restore()}>{t.undo}</button>}
    <ul>{items.map(item=>{
      const explanation=explanations.get(item.attentionKey)!;
      return <li className="targetOverviewRow" key={item.attentionKey}
        data-testid="target-home-attention-item" data-rule={item.ruleId}>
        <span className="stagingMyPlanSquare targetHomeAttentionMarker" aria-hidden="true"/>
        <div className="targetOverviewRowBody">
          {openable&&detailIdOk(item.taskId)
            ?<button type="button" className="stagingMyPlanOpen" data-detail-row={"task:"+item.taskId}
              aria-label={t.open+" "+item.title}
              onClick={event=>openTargetDetail({kind:"task",id:item.taskId,view:"Home"},event.currentTarget)}>
                <strong>{item.title}</strong></button>
            :<strong>{item.title}</strong>}
          <p className="targetHomeAttentionReason">{explanation.reason}</p>
          <details className="targetOverviewWhy"><summary>{t.why}</summary>
            <p>{explanation.why}</p>
          </details>
          <div className="targetHomeAttentionActions">
            <button type="button" disabled={busy} aria-expanded={picker===item.attentionKey}
              onClick={()=>openPicker(item.attentionKey)}>{t.snooze}</button>
            <button type="button" disabled={busy} onClick={()=>void hide(item,"dismiss",null)}>{t.dismiss}</button>
          </div>
          {picker===item.attentionKey&&<div className="targetHomeAttentionActions">
            <button type="button" disabled={busy} onClick={()=>void hide(item,"snooze",tomorrowMorning())}>{t.tomorrow}</button>
            <button type="button" disabled={busy} onClick={()=>void hide(item,"snooze",Date.now()+DAY)}>{t.day}</button>
            <button type="button" disabled={busy} onClick={()=>void hide(item,"snooze",Date.now()+7*DAY)}>{t.week}</button>
            <label>{t.custom}<input type="datetime-local" value={custom} disabled={busy}
              min={localMinute(Math.floor(Date.now()/60_000)*60_000+60_000)} max={localMinute(Date.now()+30*DAY)}
              onChange={event=>setCustom(event.target.value)}/></label>
            <button type="button" disabled={busy||!custom} onClick={()=>void hide(item,"snooze",new Date(custom).getTime())}>{t.confirm}</button>
            <button type="button" disabled={busy} onClick={event=>{const row=event.currentTarget.closest("li");closePicker();
              row?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();}}>{t.cancel}</button>
          </div>}
        </div>
      </li>;
    })}</ul>
    {page.hasMore&&<button type="button" disabled={busy||picker!==null} onClick={()=>void more()}>{t.more}</button>}
    {expanded&&<button type="button" disabled={busy||picker!==null} onClick={()=>{setExpanded(false);reload();}}>{t.less}</button>}
  </section>;
  };
  return <>{feedback}{panel()}</>;
}
