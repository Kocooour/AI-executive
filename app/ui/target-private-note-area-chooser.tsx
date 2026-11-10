"use client";
/** R3-CAPTURE-1: genuine live private writable Area read in the main Notes
 * capture surface. Selection is a hint, not authorization to send a write.
 * No create POST or private draft is ever dispatched or persisted here. */
import {useEffect,useRef,useState} from "react";
import {handleOverlayKeys} from "./focus";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick} from "./use-target-revalidation";
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
  language="cs",onClose,
}:{language?:"cs"|"en";onClose:()=>void}){
  const c=copy[language];
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [nonce,setNonce]=useState(0);
  const [state,setState]=useState<State>({kind:"loading",generation:""});
  const [chosen,setChosen]=useState("");
  const closeRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{closeRef.current?.focus();},[]);
  useTargetTick(()=>setNonce(v=>v+1));
  useEffect(()=>{
    const controller=new AbortController();
    let mounted=true;
    setChosen("");
    setState({kind:"loading",generation});
    if(!runtime||!runtime.known()||runtime.generation()!==generation){
      return ()=>{mounted=false;controller.abort();};
    }
    const unregister=runtime.register({
      dispose:()=>controller.abort(),
      suspend:()=>controller.abort(),
    });
    const available=()=>document.visibilityState==="visible"&&navigator.onLine;
    if(!available()){
      setState({kind:"unavailable",generation});
    }else{
      void loadPrivateNoteAreaChoices(controller.signal).then(result=>{
        if(!mounted||controller.signal.aborted||!runtime.known()||
          runtime.generation()!==generation||!available())return;
        if(result.ok)setState({kind:"ready",generation,areas:result.areas});
        else if(result.reason==="signed-out"){
          setState({kind:"signed-out",generation});
          void runtime.reportRefusal();
        }else setState({kind:"unavailable",generation});
      }).catch(()=>{if(mounted&&!controller.signal.aborted)
        setState({kind:"unavailable",generation});});
    }
    const onWake=()=>{
      setState({kind:"unavailable",generation});
      setChosen("");
      if(document.visibilityState==="visible"&&navigator.onLine)
        setNonce(v=>v+1);
    };
    document.addEventListener("visibilitychange",onWake);
    window.addEventListener("offline",onWake);
    window.addEventListener("online",onWake);
    return ()=>{
      mounted=false;controller.abort();unregister();
      document.removeEventListener("visibilitychange",onWake);
      window.removeEventListener("offline",onWake);
      window.removeEventListener("online",onWake);
    };
  },[runtime,generation,nonce]);
  // Never display an old actor's private titles, even for one render after
  // auth generation changes. Explicit selection has no fallback.
  const ready=runtime?.known()&&state.kind==="ready"&&
    state.generation===generation&&runtime.generation()===generation;
  const areas=ready?state.areas:[];
  const selection=areas.find(a=>a.id===chosen)||null;
  const error=state.kind==="signed-out"?c.signedOut:c.failed;
  return <div className="captureOverlay" onClick={onClose}>
    <div className="captureModal" role="dialog" aria-modal="true"
      aria-label={c.title} data-testid="target-private-note-areas"
      onClick={e=>e.stopPropagation()}
      onKeyDown={e=>handleOverlayKeys(e,onClose)}>
      <h2>{c.title}</h2>
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
      <p role="note">{c.unfinished}</p>
      <div className="captureActions">
        {!ready&&<button type="button" onClick={()=>setNonce(v=>v+1)}>{c.reload}</button>}
        <button ref={closeRef} type="button" onClick={onClose}>{c.close}</button>
      </div>
    </div>
  </div>;
}
