"use client";
/** R3 A/3: in-memory inline create for private projects and child tasks.
 * No optimistic record, hidden persistence or client Area override for children.
 * Both use the same tab-wide uncertain-command barrier. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {flushSync} from "react-dom";
import {useTargetRuntime,useTargetGeneration} from "./target-data-provider";
import {useTargetWake} from "./use-target-revalidation";
import type {PrivateNoteAreaChoice} from "../../lib/target-private-note-area-client";
import {loadStructureCreateTargets} from "../../lib/target-private-structure-targets-client";
import {openTargetDetail} from "./target-detail-state";
import {validPrivateTaskAreaId,validPrivateTaskTitle} from "../../lib/target-private-task-create-client";
import {structureCreateMarker,runStructureCreate,verifyStructureCreate,
  cancelStructureCreate,trackedStructureCreate}
  from "../../lib/target-private-structure-create-coordinator";
import type {StructureKind,StructureCreateCommand}
  from "../../lib/target-private-structure-create-client";

type Props={
  kind:StructureKind;language?:"cs"|"en";projectId?:string;areaId?:string;
  onCommitted:(id:string)=>void;
};
type Catalog={status:"loading"|"unavailable"|"signed-out"|"ready";
  generation:string;restoreGeneration:string;areas:PrivateNoteAreaChoice[]};
const words={
  cs:{project:"Nový soukromý projekt",task:"Přidat úkol",cancel:"Zavřít",
    title:"Název",area:"Soukromá Oblast",choose:"Vyberte Oblast",submit:"Vytvořit",
    loading:"Načítám soukromé Oblasti…",unavailable:"Oblasti nelze ověřit.",
    empty:"Žádná zapisovatelná soukromá Oblast.",denied:"Přístup se změnil.",
    invalid:"Vyplňte platný název (max. 4096 bajtů).",
    checking:"Ověřuji oprávnění…",saving:"Ukládám…",success:"Vytvoření potvrzeno.",
    blocked:"Předchozí vytvoření není ověřeno. Nový zápis je zablokovaný.",
    storage:"Úložiště záložky není dostupné. Vytváření je bezpečně zablokováno.",
    uncertain:"Výsledek vytvoření není jistý. Neposílejte příkaz znovu.",
    verify:"Ověřit původní vytvoření",notRecorded:"Zápis zatím nelze potvrdit. Může se ještě dokončit.",
    verifyFailed:"Potvrzení není dostupné; další zápis zůstává zablokován.",
    retry:"Znovu načíst",openProject:"Otevřít vytvořený projekt",
    openTask:"Otevřít vytvořený úkol",cancelUnresolved:"Bezpečně zrušit nevyřízené vytvoření",
    cancelled:"Původní příkaz je bezpečně ukončen.",cancelFailed:"Zrušení se nepodařilo; nový zápis zůstává zablokován."},
  en:{project:"New private project",task:"Add task",cancel:"Close",
    title:"Title",area:"Private Area",choose:"Choose Area",submit:"Create",
    loading:"Loading private Areas…",unavailable:"Areas could not be verified.",
    empty:"No writable private Area.",denied:"Access changed.",
    invalid:"Enter a valid title (up to 4096 bytes).",
    checking:"Checking permissions…",saving:"Saving…",success:"Creation confirmed.",
    blocked:"A previous create is unresolved. New writes are blocked.",
    storage:"Tab storage unavailable. Creation is safely blocked.",
    uncertain:"Create outcome is uncertain. Do not send a new command.",
    verify:"Verify original create",notRecorded:"The write is not confirmed; it may still commit.",
    verifyFailed:"Confirmation unavailable; new writes remain blocked.",
    retry:"Reload Areas",openProject:"Open created project",openTask:"Open created task",
    cancelUnresolved:"Safely cancel unresolved create",cancelled:"Original command safely settled.",
    cancelFailed:"Cancellation unavailable; new writes remain blocked."},
} as const;
export default function TargetPrivateStructureCreate({
  kind,language="cs",projectId,areaId,onCommitted,
}:Props){
  const c=words[language];
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [expanded,setExpanded]=useState(false);
  const [name,setName]=useState("");
  const [selected,setSelected]=useState("");
  const [catalog,setCatalog]=useState<Catalog>({status:"loading",generation:"",restoreGeneration:"",areas:[]});
  const [nonce,setNonce]=useState(0);
  const [phase,setPhase]=useState<"idle"|"checking"|"saving"|"verifying"|"uncertain">("idle");
  const [message,setMessage]=useState("");
  const [savedId,setSavedId]=useState("");
  const [revision,setRevision]=useState(0);
  const controller=useRef<AbortController|null>(null);
  const serial=useRef(0),pending=useRef(false),mounted=useRef(true);
  const hide=()=>{
    serial.current++;controller.current?.abort();
    setName("");setSelected("");setSavedId("");setExpanded(false);
    setCatalog({status:"unavailable",generation,restoreGeneration:"",areas:[]});
    // The opaque unresolved marker survives hide; private draft does not.
    pending.current=false;setPhase("idle");setMessage("");
  };
  useEffect(()=>{
    mounted.current=true;
    return ()=>{mounted.current=false;serial.current++;controller.current?.abort();};
  },[]);
  useEffect(()=>{
    serial.current++;controller.current?.abort();pending.current=false;
    setName("");setSelected("");setSavedId("");setExpanded(false);
    setMessage("");setPhase("idle");setCatalog({status:"loading",generation,restoreGeneration:"",areas:[]});
  },[generation,kind,projectId,areaId]);
  function live(){
    return runtime?.known()===true&&runtime.generation()===generation&&
      document.visibilityState==="visible"&&navigator.onLine;
  }
  useTargetWake({
    hide:()=>flushSync(hide),
    ready:()=>{if(live())setNonce(x=>x+1);else hide();},
    signedOut:()=>hide(),
  });
  useEffect(()=>{
    if(!expanded)return;
    const signal=new AbortController();let active=true;
    setCatalog({status:"loading",generation,restoreGeneration:"",areas:[]});setSelected("");
    if(!live()){setCatalog({status:"unavailable",generation,restoreGeneration:"",areas:[]});return;}
    const unregister=runtime!.register({dispose:()=>signal.abort(),suspend:()=>signal.abort()});
    const timer=setTimeout(()=>signal.abort(),8000);
    void loadStructureCreateTargets(signal.signal).then(result=>{
      if(!active||signal.signal.aborted||!live())return;
      if(result.ok===true)setCatalog({status:"ready",generation,
        restoreGeneration:result.restoreGeneration,areas:result.areas});
      else{
        setCatalog({status:result.reason==="signed-out"?"signed-out":"unavailable",generation,restoreGeneration:"",areas:[]});
        if(result.reason==="signed-out")void runtime!.reportRefusal();
      }
    }).catch(()=>{if(active)setCatalog({status:"unavailable",generation,restoreGeneration:"",areas:[]});})
      .finally(()=>clearTimeout(timer));
    return ()=>{active=false;clearTimeout(timer);signal.abort();unregister();};
  },[kind,expanded,runtime,generation,nonce]);
  const marker=structureCreateMarker();
  const blocked=marker.status!=="clear";
  const areas=catalog.status==="ready"&&catalog.generation===generation
    ?catalog.areas.filter(a=>validPrivateTaskAreaId(a.id)):[];
  const chosen=areas.find(a=>a.id===selected);
  const available=kind==="project"?!!chosen:
    typeof projectId==="string"&&!!projectId&&validPrivateTaskAreaId(areaId)&&
    catalog.status==="ready"&&catalog.areas.some(a=>a.id===areaId);
  const canSave=expanded&&live()&&!blocked&&!pending.current&&phase==="idle"&&available;
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!canSave||!runtime||!validPrivateTaskTitle(name)||!live()){
      if(!validPrivateTaskTitle(name))setMessage(c.invalid);
      return;
    }
    const chosenArea=kind==="project"?chosen?.id:areaId;
    if(!chosenArea||catalog.status!=="ready"||!catalog.restoreGeneration||
      structureCreateMarker().status!=="clear")return;
    pending.current=true;
    setMessage("");setSavedId("");
    const id=crypto.randomUUID(),commandId=crypto.randomUUID();
    const command:StructureCreateCommand=kind==="project"
      ?{projectId:id,commandId,areaId:chosenArea,restoreGeneration:catalog.restoreGeneration,title:name}
      :{taskId:id,commandId,projectId:projectId!,restoreGeneration:catalog.restoreGeneration,title:name};
    setPhase("saving");
    // A dispatched write is owned by the runtime and may settle after this form unmounts.
    void runStructureCreate(runtime,generation,kind,command).then(result=>{
      if(!mounted.current||runtime.generation()!==generation)return;
      pending.current=false;
      setRevision(n=>n+1);
      if(result==="saved"&&structureCreateMarker().status==="clear"){
        setName("");setPhase("idle");setMessage(c.success);setSavedId(id);
        onCommitted(id);
      }else{setPhase("uncertain");setMessage(c.uncertain);}
    });
  }
  async function cancelUnresolved(){
    if(!runtime||!live()||marker.status!=="blocked"||
      marker.marker.generation!==generation||pending.current||
      trackedStructureCreate(runtime)==="saving")return;
    pending.current=true;
    const ticket=++serial.current,signal=new AbortController();
    controller.current?.abort();controller.current=signal;
    setPhase("verifying");setMessage("");
    const timer=setTimeout(()=>signal.abort(),8000);
    const result=await cancelStructureCreate(runtime,generation,signal.signal);
    clearTimeout(timer);
    if(ticket!==serial.current||!mounted.current||!live())return;
    pending.current=false;setRevision(n=>n+1);
    if((result==="cancelled"||result==="settled")&&
      structureCreateMarker().status==="clear"){
      setPhase("idle");setName("");setSavedId("");setMessage(c.cancelled);
      if(kind==="project")setNonce(n=>n+1);
    }else{setPhase("uncertain");setMessage(c.cancelFailed);}
  }
  async function verify(){
    if(!runtime||!live()||marker.status!=="blocked"||pending.current||
      trackedStructureCreate(runtime)==="saving")return;
    pending.current=true;
    const ticket=++serial.current,signal=new AbortController();
    controller.current?.abort();controller.current=signal;
    setPhase("verifying");setMessage("");
    const timer=setTimeout(()=>signal.abort(),8000);
    const result=await verifyStructureCreate(runtime,generation,signal.signal);
    clearTimeout(timer);
    if(ticket!==serial.current||!mounted.current||!live())return;
    pending.current=false;setRevision(n=>n+1);
    if(typeof result==="object"&&result.status==="committed"&&
      structureCreateMarker().status==="clear"){
      setName("");setPhase("idle");setSavedId(result.id);setMessage(c.success);
      if(marker.marker.kind===kind)onCommitted(result.id);
    }else{setPhase("uncertain");setMessage(result==="not_recorded"?c.notRecorded:c.verifyFailed);}
  }
  void revision;
  return <section className="targetStructureCreate" data-testid={kind==="project"?"target-project-create":"target-project-task-create"}>
    {!expanded&&<button type="button" onClick={()=>setExpanded(true)}
      data-testid={kind==="project"?"target-project-create-open":"target-project-task-create-open"}>
      {kind==="project"?c.project:c.task}</button>}
    {expanded&&<>
      <h3>{kind==="project"?c.project:c.task}</h3>
      {kind==="project"&&(catalog.status==="ready"
        ?(areas.length===0?<p role="status">{c.empty}</p>:
          <label>{c.area}<select data-testid="target-project-create-area" value={chosen?.id??""}
            disabled={blocked||phase!=="idle"} onChange={event=>setSelected(event.target.value)}>
            <option value="">{c.choose}</option>
            {areas.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}
          </select></label>)
        :<p role="status">{catalog.status==="loading"?c.loading:c.unavailable}</p>)}
      {blocked&&<div data-testid="target-structure-unresolved">
        <p role="alert">{marker.status==="unavailable"?c.storage:c.blocked}</p>
        {marker.status==="blocked"&&<button type="button"
          disabled={!live()||phase==="verifying"||phase==="saving"||
            trackedStructureCreate(runtime!)==="saving"}
          data-testid="target-structure-verify" onClick={()=>{void verify();}}>{c.verify}</button>}
        {marker.status==="blocked"&&<button type="button"
          disabled={!live()||marker.marker.generation!==generation||pending.current||
            phase==="verifying"||phase==="saving"||trackedStructureCreate(runtime!)==="saving"}
          data-testid="target-structure-cancel" onClick={()=>{void cancelUnresolved();}}>
          {c.cancelUnresolved}</button>}
      </div>}
      {!blocked&&<form onSubmit={event=>{void create(event);}}
        data-testid={kind==="project"?"target-project-create-form":"target-project-task-create-form"}>
        <label>{c.title}<input value={name} maxLength={4096}
          readOnly={phase!=="idle"} onChange={event=>setName(event.target.value)} /></label>
        <button type="submit" disabled={!canSave}
          data-testid={kind==="project"?"target-project-create-save":"target-project-task-create-save"}>
          {phase==="checking"?c.checking:phase==="saving"?c.saving:c.submit}</button>
      </form>}
      {message&&<p role={message===c.success||message===c.cancelled?"status":"alert"}>{message}</p>}
      {savedId&&<button type="button" data-testid={kind==="project"?"target-project-created-open":"target-project-task-created-open"}
        onClick={event=>openTargetDetail(kind==="project"
          ?{kind:"project",id:savedId,view:"Projects"}
          :{kind:"task",id:savedId,view:"Projects",projectId:projectId!},event.currentTarget)}>
        {kind==="project"?c.openProject:c.openTask}</button>}
      <button type="button" onClick={()=>{
        if(phase==="saving"||phase==="verifying"||phase==="checking")return;
        setName("");setSelected("");setExpanded(false);setMessage("");
      }} disabled={phase==="saving"||phase==="verifying"||phase==="checking"}>{c.cancel}</button>
      {kind==="project"&&catalog.status==="unavailable"&&
        <button type="button" onClick={()=>setNonce(n=>n+1)}>{c.retry}</button>}
    </>}
  </section>;
}
