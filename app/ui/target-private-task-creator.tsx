"use client";
/** R3 task Quick Capture, intentionally disabled without explicit target flags.
 * The Area list is a read hint; selected destination is reauthorized at POST.
 * Drafts never enter local/session storage or the legacy database. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {flushSync} from "react-dom";
import {handleOverlayKeys} from "./focus";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {loadPrivateNoteAreaChoices,type PrivateNoteAreaChoice}
  from "../../lib/target-private-note-area-client";
import {privateNoteCreatePreflight} from "../../lib/target-private-note-create-client";
import {validPrivateTaskCreateCommand,type PrivateTaskCreateCommand}
  from "../../lib/target-private-task-create-client";
import {privateTaskCreateMarker} from "../../lib/target-private-task-create-reload";
import {runPrivateTaskCreate,checkPrivateTaskCreate,trackedPrivateTaskCreate,
  subscribePrivateTaskCreate} from "../../lib/target-private-task-create-coordinator";

type AreaState={kind:"loading"|"unavailable"|"signed-out";generation:string}|
  {kind:"ready";generation:string;areas:PrivateNoteAreaChoice[]};
type Phase="idle"|"preflight"|"saving"|"uncertain"|"checking"|"saved";
export default function TargetPrivateTaskCreator({
  language="cs",onClose,onCreated,onSwitchToNote,
}:{language?:"cs"|"en";onClose:()=>void;onCreated:()=>void;onSwitchToNote:()=>void}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [state,setState]=useState<AreaState>({kind:"loading",generation:""});
  const [reload,setReload]=useState(0);
  const [selected,setSelected]=useState("");
  const [title,setTitle]=useState("");
  const [phase,setPhase]=useState<Phase>("idle");
  const [notice,setNotice]=useState("");
  const [revision,setRevision]=useState(0);
  const pendingRead=useRef<AbortController|null>(null);
  const sequence=useRef(0);
  const closeRef=useRef<HTMLButtonElement>(null);
  const mounted=useRef(true);
  const cs=language==="cs";
  useEffect(()=>{closeRef.current?.focus();},[]);
  useEffect(()=>()=>{
    mounted.current=false;sequence.current++;pendingRead.current?.abort();
  },[]);
  useEffect(()=>{
    setTitle("");setSelected("");setPhase("idle");setNotice("");
  },[generation]);
  const hide=()=>{
    pendingRead.current?.abort();
    setSelected("");setTitle("");
    setState({kind:"unavailable",generation});
    if(phase==="preflight")setPhase("idle");
    if(phase==="checking")setPhase("uncertain");
  };
  useTargetTick(()=>setReload(v=>v+1));
  useTargetWake({
    hide:()=>flushSync(hide),
    ready:()=>{
      if(runtime?.known()&&runtime.lastOutcome()==="ok"&&
        runtime.generation()===generation)setReload(v=>v+1);
      else hide();
    },
    signedOut:()=>{
      setTitle("");setSelected("");setState({kind:"signed-out",generation});
    },
  });
  useEffect(()=>{
    const pageShow=(event:PageTransitionEvent)=>{
      if(event.persisted)flushSync(hide);
    };
    window.addEventListener("pageshow",pageShow);
    return ()=>window.removeEventListener("pageshow",pageShow);
  });
  useEffect(()=>{
    if(!runtime)return;
    return subscribePrivateTaskCreate(runtime,generation,()=>setRevision(n=>n+1));
  },[runtime,generation,phase]);
  useEffect(()=>{
    const controller=new AbortController();
    let active=true;
    let timer:ReturnType<typeof setTimeout>|null=null;
    setSelected("");setState({kind:"loading",generation});
    if(!runtime?.known()||runtime.generation()!==generation)
      return ()=>{active=false;controller.abort();};
    const invalidate=()=>{
      controller.abort();
      if(timer!==null)clearTimeout(timer);
      if(active)hide();
    };
    const unreg=runtime.register({dispose:invalidate,suspend:invalidate});
    if(document.visibilityState!=="visible"||!navigator.onLine)
      setState({kind:"unavailable",generation});
    else{
      timer=setTimeout(()=>{controller.abort();if(active)hide();},8000);
      void loadPrivateNoteAreaChoices(controller.signal).then(res=>{
        if(timer!==null)clearTimeout(timer);
        if(!active||controller.signal.aborted||!runtime.known()||
          runtime.generation()!==generation||document.visibilityState!=="visible"||
          !navigator.onLine)return;
        if(res.ok)setState({kind:"ready",generation,areas:res.areas});
        else if(res.reason==="signed-out"){
          setState({kind:"signed-out",generation});void runtime.reportRefusal();
        }else setState({kind:"unavailable",generation});
      }).catch(()=>{if(active&&!controller.signal.aborted)hide();});
    }
    return ()=>{active=false;controller.abort();if(timer!==null)clearTimeout(timer);unreg();};
  },[runtime,generation,reload]);
  const ready=Boolean(runtime?.known()&&runtime.generation()===generation&&
    state.kind==="ready"&&state.generation===generation&&
    document.visibilityState==="visible"&&navigator.onLine);
  const areas=ready&&state.kind==="ready"?state.areas:[];
  const choice=areas.find(a=>a.id===selected);
  const marker=privateTaskCreateMarker(generation);
  const blocked=marker.kind!=="clear";
  const tracked=runtime?trackedPrivateTaskCreate(runtime,generation):null;
  const canSend=Boolean(choice&&ready&&!blocked&&phase==="idle");
  const live=()=>mounted.current&&runtime?.known()&&runtime.generation()===generation&&
    document.visibilityState==="visible"&&navigator.onLine;
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!canSend||!choice||!runtime||!live())return;
    const input=title.trim();
    if(input!==title||input.length===0||!input.isWellFormed()||
      new TextEncoder().encode(input).length>4096||
      /[\u0000-\u001f\u007f]/u.test(input)){
      setNotice(cs?"Zadejte platný název bez krajních mezer.":"Enter a valid title without outer spaces.");
      return;
    }
    const seq=++sequence.current;
    pendingRead.current?.abort();
    const controller=new AbortController();pendingRead.current=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    setPhase("preflight");setNotice("");
    // This shared read-only preflight is available only if the note create
    // Area gates are also enabled, as checked by the task UI feature gate.
    const preview=await privateNoteCreatePreflight(choice.id,controller.signal);
    clearTimeout(timer);
    if(seq!==sequence.current||controller.signal.aborted||!live())return;
    if(!preview.ok){
      setPhase("idle");setNotice(cs?"Oblast nelze znovu ověřit.":"The Area could not be verified.");
      setReload(v=>v+1);return;
    }
    const command:PrivateTaskCreateCommand={
      taskId:crypto.randomUUID(),commandId:crypto.randomUUID(),areaId:choice.id,
      restoreGeneration:preview.restoreGeneration,title:input,
    };
    if(!validPrivateTaskCreateCommand(command))return;
    setPhase("saving");
    // The runtime owns this POST even after modal close or hidden-tab abort.
    void runPrivateTaskCreate(runtime,generation,command).then(outcome=>{
      if(!mounted.current||runtime.generation()!==generation)return;
      if(outcome==="saved"){
        setTitle("");setPhase("saved");onCreated();
      }else{
        setPhase("uncertain");
        setNotice(cs?"Zápis není potvrzen. Nový úkol nevytvářejte; ověřte původní příkaz.":
          "Creation is unconfirmed. Do not issue a new task; verify the original command.");
      }
    });
  }
  async function verify(){
    if(!runtime||!live()||phase==="checking")return;
    const seq=++sequence.current;
    const controller=new AbortController();
    pendingRead.current?.abort();pendingRead.current=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    setPhase("checking");setNotice("");
    const outcome=await checkPrivateTaskCreate(runtime,generation,controller.signal);
    clearTimeout(timer);
    if(seq!==sequence.current||controller.signal.aborted||!live())return;
    if(outcome==="committed"){
      setTitle("");setPhase("saved");onCreated();
    }else{
      setPhase("uncertain");
      setNotice(outcome==="not_recorded"
        ?(cs?"Server zatím zápis nepotvrdil; nový příkaz zůstává zablokovaný.":
          "No receipt yet; the original request may still commit.")
        :(cs?"Výsledek nelze bezpečně potvrdit. Neodesílejte nový úkol.":
          "The result cannot be verified. Do not create a replacement task."));
    }
  }
  void revision; // Rerender when a runtime-owned POST settles.
  return <div className="captureOverlay" onClick={onClose}>
    <div className="captureModal" role="dialog" aria-modal="true"
      aria-label={cs?"Nový soukromý úkol":"New private task"}
      data-testid="target-private-task-create" onClick={e=>e.stopPropagation()}
      onKeyDown={e=>handleOverlayKeys(e,onClose)}>
      <h2>{cs?"Nový soukromý úkol":"New private task"}</h2>
      <button type="button" onClick={onSwitchToNote} data-testid="target-capture-switch-note">
        {cs?"Místo toho poznámku":"Create a note instead"}
      </button>
      {!ready&&<p role="status">{state.kind==="signed-out"
        ?(cs?"Přístup se změnil.":"Access changed.")
        :(cs?"Ověřuji dostupné soukromé Oblasti…":"Verifying private Areas…")}</p>}
      {ready&&(areas.length===0?<p role="status">{cs
        ?"Nemáte dostupnou soukromou Oblast.":"No writable private Area."}</p>:
        <label>{cs?"Cílová Oblast":"Destination Area"}
          <select value={choice?.id??""} onChange={e=>setSelected(e.target.value)}
            data-testid="target-task-create-area">
            <option value="">{cs?"Vyberte soukromou Oblast":"Choose private Area"}</option>
            {areas.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </label>)}
      {blocked&&<section data-testid="target-task-create-unresolved">
        <p role="alert">{marker.kind==="unavailable"
          ?(cs?"Bezpečné úložiště relace není dostupné. Zápis je vypnutý.":
            "Secure tab storage unavailable. Creation disabled.")
          :(cs?"Předchozí vytvoření úkolu není potvrzené.":
            "Previous task creation is unresolved.")}</p>
        {marker.kind==="blocked"&&<button type="button"
          disabled={!ready||!tracked||tracked.phase==="saving"||phase==="checking"}
          data-testid="target-task-create-receipt" onClick={()=>{void verify();}}>
          {cs?"Ověřit vytvoření":"Verify creation"}
        </button>}
        {marker.kind==="blocked"&&!tracked&&<p role="note">{cs
          ?"Původní soukromý příkaz po obnovení stránky není k dispozici. Z bezpečnostních důvodů nelze vytvořit další úkol; je nutné samostatné ověřené obnovení."
          :"The original private payload is unavailable after reload. Further creation remains blocked pending verified recovery."}</p>}
      </section>}
      {ready&&choice&&!blocked&&<form data-testid="target-task-create-form"
        onSubmit={event=>{void create(event);}}>
        <label>{cs?"Název úkolu":"Task title"}
          <input value={title} maxLength={4096} readOnly={phase!=="idle"}
            onChange={e=>setTitle(e.target.value)}/>
        </label>
        <p role="note">{cs?"Uloží se jen do výslovně vybrané soukromé Oblasti.":
          "Only the explicitly selected private Area receives this task."}</p>
        <button type="submit" disabled={!canSend} data-testid="target-task-create-save">
          {phase==="preflight"?(cs?"Ověřuji…":"Checking…"):
            phase==="saving"?(cs?"Ukládám…":"Saving…"):
              (cs?"Vytvořit úkol":"Create task")}
        </button>
      </form>}
      {phase==="saved"&&<p role="status">{cs?"Úkol vytvořen.":"Task created."}</p>}
      {notice&&<p role="alert">{notice}</p>}
      <div className="captureActions">
        {!ready&&<button type="button" onClick={()=>{
          if(!runtime)return;
          void runtime.refresh().then(result=>{
            if(result==="ok"&&runtime.known()&&runtime.generation()===generation)
              setReload(v=>v+1);
            else hide();
          });
        }}>{cs?"Zkusit znovu":"Try again"}</button>}
        <button type="button" ref={closeRef} onClick={onClose}>
          {cs?"Zavřít":"Close"}
        </button>
      </div>
    </div>
  </div>;
}
