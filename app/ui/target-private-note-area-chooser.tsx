"use client";
/** R3-CAPTURE-1: genuine live private writable Area read in the main Notes
 * capture surface. Selection is a hint, not authorization to send a write.
 * No create POST or private draft is ever dispatched or persisted here. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {flushSync} from "react-dom";
import {handleOverlayKeys} from "./focus";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {validNoteEditText} from "../../lib/target-staging-note-edit-client";
import {privateNoteCreateMarker,confirmRecoveredPrivateNoteCreate} from "../../lib/target-note-create-reload";
import {privateNoteCreatePreflight,recoverPrivateNoteCreate,type PrivateNoteCreateCommand}
  from "../../lib/target-private-note-create-client";
import {runPrivateNoteCreate,releaseTrackedPrivateNoteCreate,
  subscribePrivateNoteCreate} from "../../lib/target-private-note-create-coordinator";
import {loadPrivateNoteAreaChoices,type PrivateNoteAreaChoice} from
  "../../lib/target-private-note-area-client";

type State=
  |{kind:"loading"|"unavailable"|"signed-out";generation:string}
  |{kind:"ready";generation:string;areas:PrivateNoteAreaChoice[]};
const copy={
  cs:{title:"Nová soukromá poznámka",close:"Zavřít",checking:"Ověřuji dostupné Oblasti…",
    select:"Cílová Oblast",choose:"Vyberte soukromou Oblast",
    empty:"Nemáte dostupnou soukromou Oblast pro vytvoření poznámky.",
    failed:"Dostupné Oblasti nelze ověřit. Vytvoření poznámky není dovoleno.",
    signedOut:"Přístup se změnil. Oblasti nelze zobrazit.",
    reload:"Zkusit znovu",selected:"Vybraná Oblast",
    unfinished:"Vytváření poznámek v cílovém režimu zatím není aktivní. Výběr Oblasti je jen bezpečný náhled; nic se neukládá."},
  en:{title:"New private note",close:"Close",checking:"Verifying available Areas…",
    select:"Destination Area",choose:"Choose a private Area",
    empty:"No writable private Area is currently available.",
    failed:"Areas cannot be verified. Note creation is not allowed.",
    signedOut:"Access has changed. Areas cannot be shown.",
    reload:"Try again",selected:"Selected Area",
    unfinished:"Target note creation is not active yet. This Area selection is a safe preview; nothing is saved."},
} as const;

export default function TargetPrivateNoteAreaChooser({
  language="cs",onClose,createEnabled=false,onCreated=()=>{},onSwitchToTask,
}:{language?:"cs"|"en";onClose:()=>void;createEnabled?:boolean;onCreated?:()=>void;onSwitchToTask?:()=>void}){
  const c=copy[language];
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [nonce,setNonce]=useState(0);
  const [state,setState]=useState<State>({kind:"loading",generation:""});
  const [chosen,setChosen]=useState("");
  const [title,setTitle]=useState("");
  const [body,setBody]=useState("");
  const [writePhase,setWritePhase]=useState<"idle"|"preflight"|"saving"|"uncertain"|"receipt"|"saved">("idle");
  const [writeMessage,setWriteMessage]=useState("");
  const [trackedRevision,setTrackedRevision]=useState(0);
  const beforePost=useRef<AbortController|null>(null);
  const mounted=useRef(true);
  const writeSerial=useRef(0);
  const closeRef=useRef<HTMLButtonElement>(null);
  // The runtime can confirm a CREATE while the tab is frozen or hidden.
  // Defer navigation until a visible, verified session; deliver once only.
  const completionPending=useRef(false);
  const completionDelivered=useRef(false);
  function notifyCreated(){
    if(completionDelivered.current)return;
    if(document.visibilityState!=="visible"||!navigator.onLine){
      completionPending.current=true;
      return;
    }
    if(!runtime?.known()||runtime.generation()!==generation)return;
    completionPending.current=false;
    completionDelivered.current=true;
    onCreated();
  }
  useEffect(()=>{closeRef.current?.focus();},[]);
  useEffect(()=>()=>{
    mounted.current=false;
    writeSerial.current++;
    beforePost.current?.abort(); // PREVIEW only; the runtime owns POST
  },[]);
  useEffect(()=>{
    // Never carry private draft across authenticated generations.
    setTitle("");setBody("");setWritePhase("idle");setWriteMessage("");
    completionPending.current=false;
    completionDelivered.current=false;
  },[generation]);
  useEffect(()=>{
    if(!createEnabled||!runtime)return;
    const onResult=()=>{
      setTrackedRevision(v=>v+1);
      if(privateNoteCreateMarker(generation).kind==="clear")notifyCreated();
    };
    return subscribePrivateNoteCreate(runtime,generation,onResult);
  },[createEnabled,runtime,generation,writePhase]);
  useTargetTick(()=>setNonce(v=>v+1));
  const hidePrivate=()=>{
    // Only short-lived read preflight/receipt requests belong to this modal;
    // the already-dispatched CREATE belongs to the runtime coordinator.
    beforePost.current?.abort();
    setChosen("");
    setState({kind:"unavailable",generation});
    // A BFCache/offline/private-view hide cannot keep a draft around to
    // resurface under a different freshly selected Area.
    setTitle("");setBody("");
    if(writePhase==="preflight")setWritePhase("idle");
    if(writePhase==="receipt")setWritePhase("uncertain");
  };
  // Never display a cached private Area while a tab is hidden, offline, or
  // being frozen into BFCache. Flush synchronously at pagehide: waiting for
  // React's next task could let the browser snapshot sensitive old DOM.
  // Wake reads are allowed only AFTER a fresh runtime session verification.
  useTargetWake({
    hide:()=>flushSync(hidePrivate),
    ready:()=>{
      if(runtime?.known()&&runtime.lastOutcome()==="ok"&&
        runtime.generation()===generation){
        setNonce(v=>v+1);
        if(completionPending.current)notifyCreated();
      }else hidePrivate();
    },
    signedOut:()=>{
      setChosen("");
      setState({kind:"signed-out",generation});
    },
  });
  // Defend even when a browser restores a BFCache snapshot without firing
  // visibilitychange (or a matching pagehide handler on this component).
  useEffect(()=>{
    const onPageShow=(event:PageTransitionEvent)=>{
      if(event.persisted)flushSync(hidePrivate);
    };
    window.addEventListener("pageshow",onPageShow);
    return ()=>window.removeEventListener("pageshow",onPageShow);
  },[generation]);
  useEffect(()=>{
    const controller=new AbortController();
    let mounted=true;
    let timeout:ReturnType<typeof setTimeout>|null=null;
    setChosen("");
    setState({kind:"loading",generation});
    if(!runtime||!runtime.known()||runtime.generation()!==generation){
      return ()=>{mounted=false;controller.abort();};
    }
    const invalidate=()=>{
      controller.abort();
      if(timeout!==null)clearTimeout(timeout);
      if(mounted)hidePrivate();
    };
    const unregister=runtime.register({
      dispose:invalidate,
      suspend:invalidate,
    });
    const available=()=>document.visibilityState==="visible"&&navigator.onLine;
    if(controller.signal.aborted||!available()){
      setState({kind:"unavailable",generation});
    }else{
      timeout=setTimeout(()=>{
        controller.abort();
        if(mounted)setState({kind:"unavailable",generation});
      },8000);
      void loadPrivateNoteAreaChoices(controller.signal).then(result=>{
        if(timeout!==null)clearTimeout(timeout);
        if(!mounted||controller.signal.aborted||!runtime.known()||
          runtime.generation()!==generation||!available())return;
        if(result.ok)setState({kind:"ready",generation,areas:result.areas});
        else if(result.ok===false&&result.reason==="signed-out"){
          setState({kind:"signed-out",generation});
          void runtime.reportRefusal();
        }else setState({kind:"unavailable",generation});
      }).catch(()=>{
        if(timeout!==null)clearTimeout(timeout);
        if(mounted&&!controller.signal.aborted)
          setState({kind:"unavailable",generation});
      });
    }
    return ()=>{
      mounted=false;
      if(timeout!==null)clearTimeout(timeout);
      controller.abort();unregister();
    };
  },[runtime,generation,nonce]);
  // Never display an old actor's private titles, even for one render after
  // auth generation changes. Explicit selection has no fallback.
  const ready=runtime?.known()&&state.kind==="ready"&&
    state.generation===generation&&runtime.generation()===generation&&
    document.visibilityState==="visible"&&navigator.onLine;
  const areas=ready?state.areas:[];
  const selection=areas.find(a=>a.id===chosen)||null;
  const error=state.kind==="signed-out"?c.signedOut:c.failed;
  // A reload retains only a UUID+auth generation; every new write is blocked
  // until the server positively confirms that exact original CREATE.
  const marker=createEnabled?privateNoteCreateMarker(generation):{kind:"clear" as const};
  const blocked=marker.kind!=="clear";
  const writable=Boolean(createEnabled&&ready&&selection&&!blocked&&
    writePhase==="idle");
  const stillLive=()=>mounted.current&&runtime?.known()&&
    runtime.generation()===generation&&
    document.visibilityState==="visible"&&navigator.onLine;
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!writable||!runtime||!selection||!stillLive())return;
    if(!validNoteEditText(title,body)){
      setWriteMessage(language==="cs"?"Vyplňte název; text je příliš dlouhý nebo neplatný.":"Enter a title and valid note text.");
      return;
    }
    if(privateNoteCreateMarker(generation).kind!=="clear")return;
    const seq=++writeSerial.current;
    const controller=new AbortController();
    beforePost.current?.abort();
    beforePost.current=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    setWritePhase("preflight");setWriteMessage("");
    const preview=await privateNoteCreatePreflight(selection.id,controller.signal);
    clearTimeout(timer);
    if(seq!==writeSerial.current||controller.signal.aborted||!stillLive())return;
    if(!preview.ok){
      setWritePhase("idle");
      setWriteMessage(language==="cs"?"Oprávnění nebo dostupnost Oblasti se změnily.":"Area access could not be verified.");
      setNonce(v=>v+1);
      return;
    }
    // Explicit selected destination + independent, live write preflight.
    // The server rechecks ACL/restore atomically at the actual INSERT.
    const command:PrivateNoteCreateCommand={
      noteId:crypto.randomUUID(),commandId:crypto.randomUUID(),
      areaId:selection.id,restoreGeneration:preview.restoreGeneration,
      title,body,
    };
    setWritePhase("saving");
    // Post/unmount/timeout is owned by the runtime coordinator. We never
    // dispatch another command with a fresh UUID for an uncertain result.
    void runPrivateNoteCreate(runtime,generation,command).then(outcome=>{
      if(!mounted.current||runtime.generation()!==generation)return;
      if(outcome==="saved"){
        setWritePhase("saved");setTitle("");setBody("");
        notifyCreated();
        return;
      }
      setWritePhase("uncertain");
      setWriteMessage(language==="cs"
        ?"Uložení není potvrzené. Nevytvářejte další příkaz; ověřte výsledek."
        :"The create is unconfirmed. Do not send a new command; check the receipt.");
    });
  }
  async function checkReceipt(){
    if(!createEnabled||!runtime||!stillLive()||writePhase==="receipt")return;
    const current=privateNoteCreateMarker(generation);
    if(current.kind!=="blocked"){
      setWriteMessage(language==="cs"?"Není dostupný platný příkaz k ověření.":"No valid command to confirm.");
      return;
    }
    const seq=++writeSerial.current;
    const controller=new AbortController();
    beforePost.current?.abort();
    beforePost.current=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    setWritePhase("receipt");setWriteMessage("");
    const receipt=await recoverPrivateNoteCreate(current.commandId,controller.signal);
    clearTimeout(timer);
    if(seq!==writeSerial.current||controller.signal.aborted||!stillLive())return;
    if(receipt==="committed"&&
      confirmRecoveredPrivateNoteCreate(generation,current.commandId)){
      releaseTrackedPrivateNoteCreate(runtime,generation,current.commandId);
      setTitle("");setBody("");setWritePhase("saved");notifyCreated();
      return;
    }
    setWritePhase("uncertain");
    setWriteMessage(receipt==="not_recorded"
      ?(language==="cs"?"Server zápis zatím nepotvrdil. Nový příkaz je stále zablokovaný.":"The server has not confirmed the create. A new command remains blocked.")
      :(language==="cs"?"Zápis nelze potvrdit. Zkuste ověření později.":"The create cannot be confirmed. Check again later."));
  }
  void trackedRevision; // render after an unmounted POST settles
  return <div className="captureOverlay" onClick={onClose}>
    <div className="captureModal" role="dialog" aria-modal="true"
      aria-label={c.title} data-testid="target-private-note-areas"
      onClick={e=>e.stopPropagation()}
      onKeyDown={e=>handleOverlayKeys(e,onClose)}>
      <h2>{c.title}</h2>
      {onSwitchToTask&&<button type="button" data-testid="target-capture-switch-task"
        onClick={onSwitchToTask}>{language==="cs"?"Místo toho úkol":"Create a task instead"}</button>}
      {!ready&&(state.kind==="loading"||state.generation!==generation)
        ?<p role="status">{c.checking}</p>
        :null}
      {!ready&&state.kind!=="loading"&&state.generation===generation&&
        <p role="status">{error}</p>}
      {ready&&(areas.length===0
        ?<p role="status">{c.empty}</p>
        :<label>{c.select}
          <select value={selection?.id??""} data-testid="target-private-area-select"
            onChange={e=>setChosen(e.target.value)}>
            <option value="">{c.choose}</option>
            {areas.map(area=><option key={area.id} value={area.id}>{area.title}</option>)}
          </select>
        </label>)}
      {selection&&<p data-testid="target-private-area-selected">{c.selected}: {selection.title}</p>}
      {!createEnabled&&<p role="note">{c.unfinished}</p>}
      {createEnabled&&blocked&&<section data-testid="target-private-create-unresolved">
        <p role="alert">{marker.kind==="unavailable"
          ?(language==="cs"?"Úložiště záložky není dostupné. Nelze bezpečně zapisovat.":"Tab storage unavailable; write disabled.")
          :(language==="cs"?"Předchozí vytvoření poznámky není potvrzené. Nové zápisy jsou zablokované.":"Previous note creation is unconfirmed; new writes are blocked.")}</p>
        {marker.kind==="blocked"&&<button type="button" disabled={!ready||writePhase==="receipt"}
          data-testid="target-private-create-receipt" onClick={()=>{void checkReceipt();}}>
          {language==="cs"?"Ověřit předchozí vytvoření":"Confirm previous creation"}
        </button>}
      </section>}
      {createEnabled&&ready&&selection&&!blocked&&
        <form data-testid="target-private-create-form" onSubmit={event=>{void create(event);}}>
          <label>{language==="cs"?"Název":"Title"}
            <input type="text" value={title} maxLength={4096}
              readOnly={writePhase!=="idle"} onChange={e=>setTitle(e.target.value)}/>
          </label>
          <label>{language==="cs"?"Text poznámky":"Note text"}
            <textarea rows={5} value={body} readOnly={writePhase!=="idle"}
              onChange={e=>setBody(e.target.value)}/>
          </label>
          <p role="note">{language==="cs"
            ?"Uloží se pouze do výslovně vybrané soukromé Oblasti."
            :"Saves only to the explicitly selected private Area."}</p>
          <button type="submit" disabled={!writable} data-testid="target-private-create-save">
            {writePhase==="preflight"
              ?(language==="cs"?"Ověřuji…":"Checking…")
              :writePhase==="saving"
                ?(language==="cs"?"Ukládám…":"Saving…")
                :(language==="cs"?"Vytvořit soukromou poznámku":"Create private note")}
          </button>
        </form>}
      {createEnabled&&writePhase==="saved"&&<p role="status">
        {language==="cs"?"Vytvoření potvrzeno.":"Creation confirmed."}
      </p>}
      {createEnabled&&writeMessage&&<p role="alert">{writeMessage}</p>}
      <div className="captureActions">
        {!ready&&<button type="button" onClick={()=>{
          // An explicit retry is also forbidden to bypass the wake/session gate.
          if(!runtime)return;
          void runtime.refresh().then(result=>{
            if(result==="ok"&&runtime.known()&&runtime.generation()===generation)
              setNonce(v=>v+1);
            else hidePrivate();
          });
        }}>{c.reload}</button>}
        <button ref={closeRef} type="button" onClick={onClose}>{c.close}</button>
      </div>
    </div>
  </div>;
}
