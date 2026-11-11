"use client";
/** R3-FE-6: real private standalone TASK creation in the existing global
 * Quick Capture shell. No optimistic row, legacy fallback, cached Area or
 * locally persisted text; only an exact server confirmation means success. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {flushSync} from "react-dom";
import {handleOverlayKeys} from "./focus";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetWake} from "./use-target-revalidation";
import {loadPrivateNoteAreaChoices,type PrivateNoteAreaChoice} from
  "../../lib/target-private-note-area-client";
import {privateNoteCreatePreflight} from "../../lib/target-private-note-create-client";
import {validPrivateTaskAreaId,validPrivateTaskTitle,type PrivateTaskCreateCommand} from
  "../../lib/target-private-task-create-client";
import {privateTaskCreateMarker,trackedPrivateTaskCreate,
  runPrivateTaskCreate,checkTrackedPrivateTaskCreate} from
  "../../lib/target-private-task-create-coordinator";

type Areas={kind:"loading"|"unavailable"|"signed-out";generation:string}|
  {kind:"ready";generation:string;items:PrivateNoteAreaChoice[]};
type Phase="idle"|"checking"|"saving"|"uncertain"|"receipt"|"saved";
const text={
  cs:{title:"Nový soukromý úkol",select:"Cílová Oblast",choose:"Vyberte soukromou Oblast",
    loading:"Ověřuji soukromé Oblasti…",empty:"Nemáte dostupnou soukromou Oblast.",
    denied:"Oblasti nelze ověřit. Vytvoření úkolu není dovoleno.",
    signedOut:"Přístup se změnil. Nelze pokračovat.",retry:"Zkusit znovu",
    name:"Název úkolu",save:"Vytvořit úkol",checking:"Ověřuji oprávnění…",
    saving:"Ukládám…",close:"Zavřít",
    privacy:"Úkol bude vytvořen pouze ve výslovně vybrané soukromé Oblasti.",
    invalid:"Vyplňte platný název úkolu (max. 4096 bajtů).",
    access:"Oprávnění nebo dostupnost Oblasti se změnily.",
    uncertain:"Uložení není potvrzené. Nový pokus by mohl vytvořit duplicitu.",
    blocked:"Předchozí vytvoření úkolu není potvrzené. Další úkol nelze nyní vytvořit.",
    storage:"Úložiště záložky není dostupné; bezpečné vytvoření je zablokované.",
    lost:"Původní příkaz už není v paměti. Kvůli ochraně soukromí se jeho text neukládá; automatické ověření po reloadu není možné. Zápis zůstává zablokovaný.",
    receipt:"Ověřit původní zápis",notRecorded:"Server dosud nepotvrdil zápis. To nevylučuje pozdější dokončení; další příkaz je blokovaný.",
    receiptFailed:"Zápis nelze bezpečně potvrdit. Ověření opakujte po obnovení oprávnění.",
    success:"Vytvoření úkolu bylo potvrzeno."},
  en:{title:"New private task",select:"Destination Area",choose:"Choose a private Area",
    loading:"Verifying private Areas…",empty:"No writable private Area available.",
    denied:"Areas cannot be verified. Task creation is not permitted.",
    signedOut:"Access changed. Cannot continue.",retry:"Try again",
    name:"Task title",save:"Create task",checking:"Verifying access…",
    saving:"Saving…",close:"Close",
    privacy:"The task is created only in the explicitly selected private Area.",
    invalid:"Enter a valid task title (up to 4096 bytes).",
    access:"Area access or availability changed.",
    uncertain:"Creation is not confirmed. A new attempt could duplicate the task.",
    blocked:"A previous task create is unconfirmed; new creation is blocked.",
    storage:"Tab storage is unavailable; safe creation is blocked.",
    lost:"The original command is no longer in memory. Its text was not stored for privacy; recovery after reload is unavailable. New creation remains blocked.",
    receipt:"Check original create",notRecorded:"The server has not confirmed this create. It could still commit later; new creation is blocked.",
    receiptFailed:"The create could not be verified. Retry verification after access is restored.",
    success:"Task creation confirmed."},
} as const;

export default function TargetPrivateTaskAreaChooser({
  language="cs",onClose,onCreated,
}:{language?:"cs"|"en";onClose:()=>void;onCreated:()=>void}){
  const c=text[language],runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [nonce,setNonce]=useState(0);
  const [areas,setAreas]=useState<Areas>({kind:"loading",generation:""});
  const [chosen,setChosen]=useState("");
  const [name,setName]=useState("");
  const [draftGeneration,setDraftGeneration]=useState("");
  const [phase,setPhase]=useState<Phase>("idle");
  const [message,setMessage]=useState("");
  const [revision,setRevision]=useState(0);
  const previewRef=useRef<AbortController|null>(null);
  const mounted=useRef(true);
  const serial=useRef(0);
  const delivered=useRef(false),deferred=useRef(false);
  const closeRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{closeRef.current?.focus();},[]);
  useEffect(()=>()=>{mounted.current=false;serial.current++;previewRef.current?.abort();},[]);
  useEffect(()=>{
    setName("");setDraftGeneration(generation);setChosen("");
    setMessage("");setPhase("idle");delivered.current=false;deferred.current=false;
  },[generation]);
  function live(){
    return runtime?.known()===true&&runtime.generation()===generation&&
      document.visibilityState==="visible"&&navigator.onLine;
  }
  function complete(){
    if(delivered.current)return;
    if(!live()){deferred.current=true;return;}
    delivered.current=true;deferred.current=false;onCreated();
  }
  function hide(){
    previewRef.current?.abort();
    setChosen("");setName("");setDraftGeneration(generation);
    setAreas({kind:"unavailable",generation});
    if(phase==="checking")setPhase("idle");
    if(phase==="receipt")setPhase("uncertain");
  }
  useTargetWake({
    hide:()=>flushSync(hide),
    ready:()=>{
      if(live()){
        setNonce(v=>v+1);
        if(deferred.current&&privateTaskCreateMarker(generation).kind==="clear")complete();
      }else hide();
    },
    signedOut:()=>{hide();setAreas({kind:"signed-out",generation});},
  });
  useEffect(()=>{
    const show=(event:PageTransitionEvent)=>{if(event.persisted)flushSync(hide);};
    window.addEventListener("pageshow",show);
    return ()=>window.removeEventListener("pageshow",show);
  },[generation]);
  useEffect(()=>{
    const controller=new AbortController();
    let active=true;
    setAreas({kind:"loading",generation});setChosen("");
    if(!runtime?.known()||runtime.generation()!==generation||
      document.visibilityState!=="visible"||!navigator.onLine){
      setAreas({kind:"unavailable",generation});
      return ()=>{active=false;controller.abort();};
    }
    const unregister=runtime.register({
      dispose:()=>controller.abort(),suspend:()=>controller.abort(),
    });
    const timer=setTimeout(()=>controller.abort(),8000);
    void loadPrivateNoteAreaChoices(controller.signal).then(result=>{
      if(!active||controller.signal.aborted||!live())return;
      if(result.ok)setAreas({kind:"ready",generation,items:result.areas});
      else if(result.reason==="signed-out"){
        setAreas({kind:"signed-out",generation});void runtime.reportRefusal();
      }else setAreas({kind:"unavailable",generation});
    }).catch(()=>{if(active&&!controller.signal.aborted)setAreas({kind:"unavailable",generation});})
      .finally(()=>clearTimeout(timer));
    return ()=>{active=false;clearTimeout(timer);controller.abort();unregister();};
  },[runtime,generation,nonce]);
  const ready=live()&&areas.kind==="ready"&&areas.generation===generation;
  const items=ready&&areas.kind==="ready"?areas.items.filter(a=>validPrivateTaskAreaId(a.id)):[];
  const selected=items.find(item=>item.id===chosen)||null;
  const marker=privateTaskCreateMarker(generation);
  const tracked=runtime?trackedPrivateTaskCreate(runtime,generation):null;
  const blocked=marker.kind!=="clear";
  const writable=Boolean(ready&&selected&&!blocked&&phase==="idle");
  const title=draftGeneration===generation?name:"";
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!writable||!runtime||!selected||!live()||
      privateTaskCreateMarker(generation).kind!=="clear")return;
    if(!validPrivateTaskTitle(title)){setMessage(c.invalid);return;}
    const current=++serial.current,controller=new AbortController();
    previewRef.current?.abort();previewRef.current=controller;
    setPhase("checking");setMessage("");
    const timer=setTimeout(()=>controller.abort(),8000);
    // The note Area preview is a READ of owner-private write-capable Areas.
    // The separate task writer rechecks both identity and ACL at COMMIT.
    const preflight=await privateNoteCreatePreflight(selected.id,controller.signal);
    clearTimeout(timer);
    if(current!==serial.current||controller.signal.aborted||!live())return;
    if(!preflight.ok){
      setPhase("idle");setMessage(c.access);setNonce(v=>v+1);return;
    }
    const command:PrivateTaskCreateCommand={
      taskId:crypto.randomUUID(),commandId:crypto.randomUUID(),
      areaId:selected.id,restoreGeneration:preflight.restoreGeneration,title,
    };
    setPhase("saving");
    void runPrivateTaskCreate(runtime,generation,command).then(outcome=>{
      if(!mounted.current||runtime.generation()!==generation)return;
      setRevision(v=>v+1);
      if(outcome==="saved"&&privateTaskCreateMarker(generation).kind==="clear"){
        setName("");setPhase("saved");complete();return;
      }
      setPhase("uncertain");setMessage(c.uncertain);
    });
  }
  async function checkReceipt(){
    if(!runtime||!live()||!blocked||!tracked||
      tracked.phase==="saving"||phase==="receipt")return;
    const current=++serial.current,controller=new AbortController();
    previewRef.current?.abort();previewRef.current=controller;
    setPhase("receipt");setMessage("");
    const timer=setTimeout(()=>controller.abort(),8000);
    const result=await checkTrackedPrivateTaskCreate(runtime,generation,controller.signal);
    clearTimeout(timer);
    if(current!==serial.current||controller.signal.aborted||!live())return;
    setRevision(v=>v+1);
    if(result==="committed"&&privateTaskCreateMarker(generation).kind==="clear"){
      setName("");setPhase("saved");complete();return;
    }
    setPhase("uncertain");
    setMessage(result==="not_recorded"?c.notRecorded:c.receiptFailed);
  }
  void revision;
  return <div className="captureOverlay" onClick={onClose}>
    <div className="captureModal" role="dialog" aria-modal="true"
      aria-label={c.title} data-testid="target-private-task-capture"
      onClick={event=>event.stopPropagation()}
      onKeyDown={event=>handleOverlayKeys(event,onClose)}>
      <h2>{c.title}</h2>
      {!ready&&<p role="status">{areas.kind==="loading"||areas.generation!==generation
        ?c.loading:areas.kind==="signed-out"?c.signedOut:c.denied}</p>}
      {ready&&(items.length===0?<p role="status">{c.empty}</p>:
        <label>{c.select}
          <select value={selected?.id??""} data-testid="target-private-task-area"
            disabled={blocked||phase!=="idle"} onChange={event=>setChosen(event.target.value)}>
            <option value="">{c.choose}</option>
            {items.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>)}
      {blocked&&<section data-testid="target-private-task-unresolved">
        <p role="alert">{marker.kind==="unavailable"?c.storage:c.blocked}</p>
        {marker.kind==="blocked"&&!tracked&&<p role="note">{c.lost}</p>}
        {marker.kind==="blocked"&&tracked&&<button type="button"
          data-testid="target-private-task-receipt"
          disabled={!ready||tracked.phase==="saving"||phase==="receipt"}
          onClick={()=>{void checkReceipt();}}>{c.receipt}</button>}
      </section>}
      {ready&&selected&&!blocked&&<form data-testid="target-private-task-form"
        onSubmit={event=>{void create(event);}}>
        <label>{c.name}
          <input type="text" value={title} maxLength={4096}
            readOnly={phase!=="idle"}
            onChange={event=>{setDraftGeneration(generation);setName(event.target.value);}}/>
        </label>
        <p role="note">{c.privacy}</p>
        <button type="submit" data-testid="target-private-task-save"
          disabled={!writable}>{phase==="checking"?c.checking:
            phase==="saving"?c.saving:c.save}</button>
      </form>}
      {phase==="saved"&&<p role="status">{c.success}</p>}
      {message&&<p role="alert">{message}</p>}
      <div className="captureActions">
        {!ready&&<button type="button" onClick={()=>{
          if(!runtime)return;
          void runtime.refresh().then(result=>{
            if(result==="ok"&&live())setNonce(v=>v+1);
            else hide();
          });
        }}>{c.retry}</button>}
        <button type="button" ref={closeRef} onClick={onClose}>{c.close}</button>
      </div>
    </div>
  </div>;
}
