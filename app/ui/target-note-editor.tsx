"use client";
/** R3-FE-4b: authorized, CAS-protected note editing. An already-sent PATCH
 * belongs to the runtime/generation-scoped recovery coordinator, NOT to this
 * disposable inspector. No local storage, background sync, or optimistic text. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {readStagingNotePreview,type NotePreview} from "../../lib/target-staging-note-preview-client";
import {queuedTargetFetch} from "../../lib/target-read-queue";
import {
  loadNoteEditPreview,validNoteEditText,
  type NoteEditCommand,type NoteEditPreview,
} from "../../lib/target-staging-note-edit-client";
import {
  forgetTrackedNoteEdit,runTrackedNoteEdit,subscribeTrackedNoteEdit,trackedNoteEdit,
  type TrackedNoteEditPhase,
} from "../../lib/target-note-edit-recovery";
import type {DetailLanguage} from "../../lib/target-detail-copy";

// Shared R3-FE-4a server read budget also applies to edit preflight.
const editReadFetch=queuedTargetFetch();
type Draft={
  preview:NoteEditPreview;revision:number;title:string;body:string;
  command:NoteEditCommand|null;
  phase:"edit"|"saving"|"uncertain"|"conflict";
};
type Mode={kind:"idle"}|{kind:"checking"}|{kind:"denied"}|
  {kind:"recovery"}|{kind:"draft";draft:Draft};
const words={
  cs:{
    edit:"Upravit poznámku",checking:"Ověřuji oprávnění k úpravě…",
    denied:"Úprava není dostupná pro tento přístup.",
    recover:"Obnovit stav posledního ukládání",
    recovering:"Předchozí ukládání není potvrzené. Ověřte přístup a pokračujte stejným příkazem.",
    title:"Název",body:"Text poznámky",save:"Uložit změny",
    cancel:"Zahodit úpravy",saving:"Ukládám…",
    invalid:"Název musí být vyplněný a text v povolené délce.",
    uncertain:"Výsledek ukládání není jistý. Obsah neměňte; zopakujte přesně stejný příkaz.",
    retry:"Ověřit uložením znovu",conflict:"Poznámka nebo oprávnění se změnily. Koncept se neuložil.",
    offline:"Bez připojení nelze změny bezpečně uložit.",
    refresh:"Zahodit koncept a načíst aktuální obsah",
  },
  en:{
    edit:"Edit note",checking:"Checking edit access…",
    denied:"Editing is not available for this access.",
    recover:"Recover previous save",
    recovering:"A previous save remains unconfirmed. Verify access before retrying the exact command.",
    title:"Title",body:"Note text",save:"Save changes",
    cancel:"Discard changes",saving:"Saving…",
    invalid:"Enter a title and keep the content within the allowed limits.",
    uncertain:"The save outcome is uncertain. Keep the content unchanged and retry the exact same command.",
    retry:"Retry the same command",conflict:"The note or access changed. Your draft was not saved.",
    offline:"Changes cannot be saved safely while offline.",
    refresh:"Discard draft and reload current content",
  },
};
function editorPhase(phase:TrackedNoteEditPhase):Draft["phase"]{
  return phase==="saving"?"saving":phase==="uncertain"?"uncertain":"conflict";
}
export default function TargetNoteEditor({note,language,onCommitted,onAccessRefused}:{
  note:NotePreview;language:DetailLanguage;
  onCommitted:()=>void;onAccessRefused:()=>void;
}){
  const copy=words[language];
  const generation=useTargetGeneration();
  const runtime=useTargetRuntime();
  const boundGeneration=useRef(generation);
  const alive=boundGeneration.current!==""&&generation===boundGeneration.current;
  const stillBound=()=>runtime?.known()===true&&
    runtime.generation()===boundGeneration.current&&
    document.visibilityState!=="hidden"&&navigator.onLine;
  const [mode,setMode]=useState<Mode>({kind:"idle"});
  const [message,setMessage]=useState("");
  const requestNumber=useRef(0);
  // This controller is for GET preflight only; PATCH is owned by the recovery
  // coordinator and intentionally does NOT abort when the detail unmounts.
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>{requestNumber.current++;controller.current?.abort();},[]);
  useEffect(()=>{
    if(alive)return;
    requestNumber.current++;
    controller.current?.abort();
    setMode({kind:"idle"});
    setMessage("");
  },[alive]);

  function refuse(){
    if(runtime)forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
    requestNumber.current++;
    controller.current?.abort();
    setMode({kind:"denied"});
    setMessage(copy.denied);
    // Parent clears note title/body synchronously, then obtains a new
    // authorized read. This also handles writer -> viewer downgrades.
    onAccessRefused();
  }
  // The result of a PATCH is delivered even when the initiating editor has
  // been unmounted. A subsequent authorized detail can recover the exact
  // command. No new UUID is generated for an unresolved write.
  useEffect(()=>{
    if(!runtime||!alive)return;
    const sync=()=>{
      const tracked=trackedNoteEdit(runtime,boundGeneration.current,note.id);
      if(!tracked)return;
      if(tracked.phase==="saved"){
        forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
        requestNumber.current++;
        controller.current?.abort();
        setMode({kind:"idle"});
        onCommitted();
      }else if(tracked.phase==="denied"){
        refuse();
      }else{
        // Do not reveal saved draft text until edit access has been checked
        // after a fresh mount. Only an already-authorized editor is updated.
        setMode(previous=>previous.kind==="draft"&&
          previous.draft.command?.commandId===tracked.command.commandId
            ?{kind:"draft",draft:{...previous.draft,phase:editorPhase(tracked.phase)}}
            :previous);
      }
    };
    const unsubscribe=subscribeTrackedNoteEdit(runtime,boundGeneration.current,note.id,sync);
    const existing=trackedNoteEdit(runtime,boundGeneration.current,note.id);
    if(existing){
      if(existing.phase==="saved"){
        forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
      }else if(existing.phase==="denied"){
        refuse();
      }else{
        setMode({kind:"recovery"});
        // Verification is started after mount; it never blindly exposes an
        // in-memory draft from an identity that is no longer a writer.
        void recover();
      }
    }
    return unsubscribe;
    // Runtime/generation/ID define this recovery boundary, not note revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[runtime,generation,note.id,alive]);

  async function recover(){
    if(!runtime||!alive)return;
    if(!stillBound()){setMode({kind:"recovery"});setMessage(copy.offline);return;}
    const tracked=trackedNoteEdit(runtime,boundGeneration.current,note.id);
    if(!tracked){setMode({kind:"idle"});return;}
    if(tracked.phase==="saved"){
      forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
      onCommitted();
      return;
    }
    if(tracked.phase==="denied"){refuse();return;}
    const seq=++requestNumber.current;
    controller.current?.abort();
    const signal=new AbortController();
    controller.current=signal;
    setMode({kind:"checking"});
    setMessage("");
    const result=await loadNoteEditPreview(note.id,signal.signal,editReadFetch);
    if(seq!==requestNumber.current||signal.signal.aborted||!stillBound())return;
    if(result.ok===false){
      if(result.reason==="denied"){refuse();return;}
      setMode({kind:"recovery"});setMessage(copy.recovering);return;
    }
    // The original command's generation/Area must still be live. The current
    // expectedRevision may differ after a committed write and must NOT replace
    // the original retry token.
    if(result.preview.writeAreaId!==tracked.command.writeAreaId||
       result.preview.restoreGeneration.toLowerCase()!==
         tracked.command.restoreGeneration.toLowerCase()){
      refuse();
      return;
    }
    const latest=trackedNoteEdit(runtime,boundGeneration.current,note.id);
    if(!latest||latest.command.commandId!==tracked.command.commandId)return;
    if(latest.phase==="saved"){
      forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
      onCommitted();
    }else if(latest.phase==="denied"){
      refuse();
    }else{
      setMode({kind:"draft",draft:{
        preview:result.preview,revision:note.revision,
        title:latest.command.title,body:latest.command.body,
        command:latest.command,phase:editorPhase(latest.phase),
      }});
    }
  }
  async function begin(){
    if(!runtime||!alive)return;
    if(trackedNoteEdit(runtime,boundGeneration.current,note.id)){
      void recover();return;
    }
    if(!stillBound()){setMessage(copy.offline);return;}
    const seq=++requestNumber.current;
    controller.current?.abort();
    const signal=new AbortController();
    controller.current=signal;
    setMode({kind:"checking"});
    setMessage("");
    const result=await loadNoteEditPreview(note.id,signal.signal,editReadFetch);
    if(seq!==requestNumber.current||signal.signal.aborted||!stillBound())return;
    if(result.ok===true){
      // Never edit against a stale note snapshot from a prior read.
      const fresh=await readStagingNotePreview(note.id,signal.signal,editReadFetch);
      if(seq!==requestNumber.current||signal.signal.aborted||!stillBound())return;
      if(!fresh.ok||fresh.note.revision!==note.revision||
          fresh.note.title!==note.title||fresh.note.body!==note.body||
          fresh.note.areaId!==result.preview.writeAreaId){
        setMode({kind:"idle"});
        setMessage(copy.conflict);
        onCommitted();
        return;
      }
      setMode({kind:"draft",draft:{
        preview:result.preview,revision:note.revision,title:note.title,body:note.body,
        command:null,phase:"edit",
      }});
    }else if(result.reason==="denied"){
      refuse();
    }else{
      setMode({kind:"idle"});
      setMessage(copy.offline);
    }
  }
  function discard(){
    if(runtime){
      const tracked=trackedNoteEdit(runtime,boundGeneration.current,note.id);
      if(tracked?.phase==="saving"||tracked?.phase==="uncertain")return;
      forgetTrackedNoteEdit(runtime,boundGeneration.current,note.id);
    }
    requestNumber.current++;
    controller.current?.abort();
    setMode({kind:"idle"});
    setMessage("");
    onCommitted(); // fresh authorized read; no cached content restoration
  }
  function commit(draft:Draft){
    if(!runtime||!alive||!stillBound()||draft.phase==="saving"){
      setMessage(copy.offline);return;
    }
    const retry=draft.command!==null;
    if(!retry&&note.revision!==draft.revision){
      setMode({kind:"draft",draft:{...draft,phase:"conflict"}});
      return;
    }
    if(!retry&&draft.title===note.title&&draft.body===note.body){
      setMode({kind:"idle"});return;
    }
    if(!retry&&!validNoteEditText(draft.title,draft.body)){
      setMessage(copy.invalid);return;
    }
    // An uncertain command MUST replay unchanged even when a passive
    // authorized re-read now sees the revision after its own commit.
    const command=draft.command??{
      ...draft.preview,commandId:crypto.randomUUID(),title:draft.title,body:draft.body,
    };
    setMode({kind:"draft",draft:{...draft,command,phase:"saving"}});
    setMessage("");
    // Deliberately not awaited or aborted on unmount. The coordinator retains
    // this exact command until it can be reconciled after authorized re-entry.
    void runTrackedNoteEdit(runtime,boundGeneration.current,note.id,command);
  }

  if(!alive)return null;
  if(mode.kind==="idle"||mode.kind==="checking"||mode.kind==="denied"||
      mode.kind==="recovery")
    return <div className="targetNoteEdit" data-testid="target-note-edit">
      {mode.kind==="idle"&&<button type="button" onClick={()=>{void begin();}}>{copy.edit}</button>}
      {mode.kind==="checking"&&<p role="status">{copy.checking}</p>}
      {mode.kind==="denied"&&<p role="status">{copy.denied}</p>}
      {mode.kind==="recovery"&&<>
        <p role="status">{copy.recovering}</p>
        <button type="button" onClick={()=>{void recover();}}>{copy.recover}</button>
      </>}
      {message&&<p role="alert">{message}</p>}
    </div>;
  const d=mode.draft;
  // The old revision is not a blocker to confirmation of the exact already
  // submitted command. The server checks its durable idempotency receipt.
  const stale=d.command===null&&note.revision!==d.revision;
  const conflict=d.phase==="conflict"||stale;
  const busy=d.phase==="saving";
  const uncertain=d.phase==="uncertain";
  const locked=busy||uncertain||conflict;
  return <form className="targetNoteEdit" data-testid="target-note-edit"
    onSubmit={(event:FormEvent<HTMLFormElement>)=>{
      event.preventDefault();if(!locked)commit(d);
    }}>
    <label>{copy.title}
      <input type="text" value={d.title} readOnly={locked}
        onChange={event=>setMode({kind:"draft",draft:{...d,title:event.target.value,command:null}})}
        maxLength={4096}/>
    </label>
    <label>{copy.body}
      <textarea rows={6} value={d.body} readOnly={locked}
        onChange={event=>setMode({kind:"draft",draft:{...d,body:event.target.value,command:null}})}/>
    </label>
    {message&&<p role="alert">{message}</p>}
    {busy&&<p role="status">{copy.saving}</p>}
    {conflict&&<p role="alert">{copy.conflict}</p>}
    {uncertain&&<p role="alert">{copy.uncertain}</p>}
    <div className="targetNoteEditActions">
      {!locked&&<>
        <button type="submit">{copy.save}</button>
        <button type="button" onClick={discard}>{copy.cancel}</button>
      </>}
      {uncertain&&<button type="button" onClick={()=>commit(d)}>{copy.retry}</button>}
      {conflict&&<button type="button" onClick={discard}>{copy.refresh}</button>}
    </div>
  </form>;
}
