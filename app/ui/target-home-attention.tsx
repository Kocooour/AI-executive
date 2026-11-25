"use client";
/** E-1: private task candidates only. Mounted inside the verified Home reader;
 * no local persistence, no legacy fallback, no project inference. */
import {useCallback,useEffect,useRef,useState} from "react";
import {useTargetWake,useTargetTick} from "./use-target-revalidation";
import {useTargetRuntime} from "./target-data-provider";
import {openTargetDetail} from "./target-detail-state";
import {targetAppFetch} from "../../lib/target-app-fetch";
import {detailIdOk} from "../../lib/target-detail-route";
import {readHomeAttention,readMoreHomeAttention,changeHomeAttention,undoHomeAttention,HOME_ATTENTION_LIMIT}
  from "../../lib/target-home-attention-actions";
import type {AttentionPage,AttentionItem,AttentionCommand} from "../../lib/target-staging-attention-client";
import "./target-home-attention.css";

type Language="cs"|"en";
type State={kind:"loading"}|{kind:"error"}|{kind:"ready";page:AttentionPage};
const DAY=86_400_000;
const labels={
  cs:{heading:"Vyžaduje pozornost",why:"Proč?",snooze:"Odložit",dismiss:"Skrýt",
    undo:"Zpět",more:"Další upozornění",less:"Méně upozornění",retry:"Zkusit znovu",
    error:"Upozornění nelze bezpečně načíst.",conflict:"Změnu se nepodařilo bezpečně potvrdit. Zkontrolujte aktuální stav.",
    uncertain:"Výsledek změny není potvrzen. Zkontrolujte aktuální stav.",
    changed:"Upozornění bylo upraveno.",restored:"Upozornění bylo obnoveno.",
    day:"Za 24 hodin",week:"Za týden",custom:"Vlastní čas (čas zařízení)",confirm:"Potvrdit",
    cancel:"Zrušit",invalid:"Zvolte budoucí čas, nejvýše 30 dní od nynějška.",
    overdue:"Po termínu",soon:"Blíží se termín",passed:"Propadlé Kdy",sourceDue:"Zdroj: termín úkolu",
    sourceWhen:"Zdroj: osobní plán (Kdy)",evaluated:"Vyhodnoceno",loading:"Načítám upozornění…",open:"Otevřít úkol"},
  en:{heading:"Needs attention",why:"Why?",snooze:"Snooze",dismiss:"Dismiss",undo:"Undo",
    more:"More attention items",less:"Fewer attention items",retry:"Retry",
    error:"Attention items could not be loaded safely.",conflict:"The change could not be confirmed safely. Check the current state.",
    uncertain:"The outcome is unconfirmed. Check the current state.",
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
  const [undo,setUndo]=useState<AttentionCommand|null>(null);
  const [picker,setPicker]=useState<string|null>(null);
  const [custom,setCustom]=useState("");
  const heading=useRef<HTMLHeadingElement>(null);
  const actionRef=useRef<AbortController|null>(null);
  const readRef=useRef<AbortController|null>(null);
  const focusPending=useRef(false);
  const reload=useCallback(()=>{setState({kind:"loading"});setExpanded(false);
    setPicker(null);setRefresh(n=>n+1);},[]);
  const live=()=>Boolean(runtime?.known()&&runtime.generation()===generation&&
    document.visibilityState!=="hidden"&&navigator.onLine);
  const conceal=()=>{
    readRef.current?.abort();actionRef.current?.abort();actionRef.current=null;
    setHidden(true);setState({kind:"loading"});setUndo(null);setNotice("");
    setBusy(false);setPicker(null);setExpanded(false);setCustom("");
  };
  const {markHidden}=useTargetWake({
    hide:conceal,signedOut:conceal,
    ready(result){if(result==="unavailable"){conceal();markHidden();return;}
      setHidden(false);reload();},
  });
  useTargetTick(()=>{if(!actionRef.current){setUndo(null);reload();}});
  useEffect(()=>{
    if(hidden)return;
    if(document.visibilityState==="hidden"||!navigator.onLine){markHidden();conceal();return;}
    const controller=new AbortController();
    readRef.current=controller;
    setState({kind:"loading"});
    void readHomeAttention(controller.signal,targetAppFetch,language).then(result=>{
      if(controller.signal.aborted)return;
      if(result.status==="ok")setState({kind:"ready",page:result.page});
      else{setState({kind:"error"});setUndo(null);
        if(result.status==="unauthorized")onRefusal();}
    }).catch(()=>{if(!controller.signal.aborted)setState({kind:"error"});});
    return ()=>controller.abort();
  },[refresh,generation,hidden,markHidden,onRefusal,language]);
  useEffect(()=>()=>{readRef.current?.abort();actionRef.current?.abort();},[]);
  useEffect(()=>{
    if(state.kind==="ready"&&focusPending.current){focusPending.current=false;heading.current?.focus();}
  },[state]);
  const start=()=>{
    if(actionRef.current||!live()||hidden)return null;
    const controller=new AbortController();
    actionRef.current=controller;setBusy(true);setNotice("");
    return controller;
  };
  const finish=(controller:AbortController)=>{
    if(actionRef.current===controller){actionRef.current=null;setBusy(false);}
  };
  async function more(){
    if(state.kind!=="ready")return;
    const controller=start();if(!controller)return;
    try{
      const result=await readMoreHomeAttention(state.page,controller.signal);
      if(controller.signal.aborted||!live())return;
      if(result.status==="ok"){setState({kind:"ready",page:result.page});setExpanded(true);}
      else {setUndo(null);reload();if(result.status==="unauthorized")onRefusal();}
    }finally{finish(controller);}
  }
  async function hide(item:AttentionItem,action:"snooze"|"dismiss",until:number|null){
    if(state.kind!=="ready")return;
    if(action==="snooze"&&(until===null||!Number.isFinite(until)||until<=Date.now()||until>Date.now()+30*DAY)){
      setNotice(t.invalid);return;
    }
    const controller=start();if(!controller)return;
    setUndo(null);
    try{
      let committed:AttentionCommand|null=null;
      const result=await changeHomeAttention({item,attentionEpoch:state.page.attentionEpoch},
        action,until,controller.signal,targetAppFetch,command=>{committed=command;});
      if(controller.signal.aborted||!live())return;
      if(result.status==="ok"){setUndo(committed);setNotice(t.changed);}
      else{setNotice(result.status==="uncertain"?t.uncertain:t.conflict);
        if(result.status==="unauthorized")onRefusal();}
      setCustom("");focusPending.current=true;reload();
    }catch{if(!controller.signal.aborted){setNotice(t.uncertain);reload();}}
    finally{finish(controller);}
  }
  async function restore(){
    if(!undo)return;
    const controller=start();if(!controller)return;
    const original=undo;setUndo(null);
    try{
      const result=await undoHomeAttention(original,controller.signal);
      if(controller.signal.aborted||!live())return;
      setNotice(result.status==="ok"?t.restored:result.status==="uncertain"?t.uncertain:t.conflict);
      if(result.status==="unauthorized")onRefusal();
      focusPending.current=true;reload();
    }catch{if(!controller.signal.aborted){setNotice(t.uncertain);reload();}}
    finally{finish(controller);}
  }
  if(hidden)return null;
  if(state.kind==="loading")return <p role="status">{t.loading}</p>;
  if(state.kind==="error")return <section role="status"><p>{t.error}</p>
    <button type="button" onClick={reload}>{t.retry}</button></section>;
  const {page}=state;
  if(page.explanationLanguage!==language||!page.explanations)return <p role="status">{t.loading}</p>;
  if(!page.items.length&&!notice&&!undo)return null;
  const items=expanded?page.items:page.items.slice(0,HOME_ATTENTION_LIMIT);
  const explanations=new Map(page.explanations.map(x=>[x.attentionKey,x]));
  return <section className="targetOverviewSection targetHomeAttention" data-testid="target-home-attention"
    aria-label={t.heading}>
    <h2 tabIndex={-1} ref={heading}>{t.heading}</h2>
    <div role="status" aria-live="polite">{notice}</div>
    {undo&&<button type="button" disabled={busy} onClick={()=>void restore()}>{t.undo}</button>}
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
              onClick={()=>{setPicker(picker===item.attentionKey?null:item.attentionKey);setCustom("");}}>{t.snooze}</button>
            <button type="button" disabled={busy} onClick={()=>void hide(item,"dismiss",null)}>{t.dismiss}</button>
          </div>
          {picker===item.attentionKey&&<div className="targetHomeAttentionActions">
            <button type="button" disabled={busy} onClick={()=>void hide(item,"snooze",Date.now()+DAY)}>{t.day}</button>
            <button type="button" disabled={busy} onClick={()=>void hide(item,"snooze",Date.now()+7*DAY)}>{t.week}</button>
            <label>{t.custom}<input type="datetime-local" value={custom} disabled={busy}
              onChange={event=>setCustom(event.target.value)}/></label>
            <button type="button" disabled={busy||!custom} onClick={()=>void hide(item,"snooze",new Date(custom).getTime())}>{t.confirm}</button>
            <button type="button" disabled={busy} onClick={()=>setPicker(null)}>{t.cancel}</button>
          </div>}
        </div>
      </li>;
    })}</ul>
    {page.hasMore&&<button type="button" disabled={busy} onClick={()=>void more()}>{t.more}</button>}
    {expanded&&<button type="button" disabled={busy} onClick={()=>{setExpanded(false);reload();}}>{t.less}</button>}
  </section>;
}
