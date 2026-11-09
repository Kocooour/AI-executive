"use client";
/** R3-FE-4b: one authorized note edit inside the target detail.
 * Drafts, preflight CAS and command UUID are memory-only and identity-bound.
 * Network ambiguity never generates a replacement command automatically. */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {useTargetGeneration} from "./target-data-provider";
import type {NotePreview} from "../../lib/target-staging-note-preview-client";
import {
  loadNoteEditPreview,saveNoteEdit,validNoteEditText,
  type NoteEditCommand,type NoteEditPreview,
} from "../../lib/target-staging-note-edit-client";
import type {DetailLanguage} from "../../lib/target-detail-copy";

type Draft={
  preview:NoteEditPreview;revision:number;title:string;body:string;
  command:NoteEditCommand|null;
  phase:"edit"|"saving"|"uncertain"|"conflict";
};
type Mode={kind:"idle"}|{kind:"checking"}|{kind:"denied"}|
  {kind:"draft";draft:Draft};
const words={
  cs:{
    edit:"Upravit poznámku",checking:"Ověřuji oprávnění k úpravě…",
    denied:"Úprava není dostupná pro tento přístup.",
    title:"Název",body:"Text poznámky",save:"Uložit změny",
    cancel:"Zahodit úpravy",saving:"Ukládám…",
    invalid:"Název musí být vyplněný a text v povolené délce.",
    uncertain:"Výsledek ukládání není jistý. Neměňte obsah a zopakujte přesně stejný příkaz.",
    retry:"Ověřit uložením znovu",conflict:"Poznámka nebo oprávnění se změnily. Koncept se neuložil.",
    offline:"Bez připojení nelze změny bezpečně uložit.",
    refresh:"Zahodit koncept a načíst aktuální obsah",
  },
  en:{
    edit:"Edit note",checking:"Checking edit access…",
    denied:"Editing is not available for this access.",
    title:"Title",body:"Note text",save:"Save changes",
    cancel:"Discard changes",saving:"Saving…",
    invalid:"Enter a title and keep the content within the allowed limits.",
    uncertain:"The save outcome is uncertain. Keep the content unchanged and retry the exact same command.",
    retry:"Retry the same command",conflict:"The note or access changed. Your draft was not saved.",
    offline:"Changes cannot be saved safely while offline.",
    refresh:"Discard draft and reload current content",
  },
};
export default function TargetNoteEditor({note,language,onCommitted}:{
  note:NotePreview;language:DetailLanguage;onCommitted:()=>void;
}){
  const copy=words[language];
  const generation=useTargetGeneration();
  const boundGeneration=useRef(generation);
  const alive=boundGeneration.current!==""&&generation===boundGeneration.current;
  const [mode,setMode]=useState<Mode>({kind:"idle"});
  const [message,setMessage]=useState("");
  const requestNumber=useRef(0);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>{requestNumber.current++;controller.current?.abort();},[]);
  useEffect(()=>{
    if(alive)return;
    requestNumber.current++;
    controller.current?.abort();
    setMode({kind:"idle"});
    setMessage("");
  },[alive]);
  async function begin(){
    if(!alive)return;
    if(!navigator.onLine){setMessage(copy.offline);return;}
    const seq=++requestNumber.current;
    controller.current?.abort();
    const signal=new AbortController();
    controller.current=signal;
    setMode({kind:"checking"});
    setMessage("");
    const result=await loadNoteEditPreview(note.id,signal.signal);
    if(seq!==requestNumber.current||signal.signal.aborted)return;
    if(result.ok){
      if(generation!==boundGeneration.current)return;
      setMode({kind:"draft",draft:{
        preview:result.preview,revision:note.revision,title:note.title,body:note.body,
        command:null,phase:"edit",
      }});
    }else{
      setMode(result.reason==="denied"?{kind:"denied"}:{kind:"idle"});
      setMessage(result.reason==="denied"?copy.denied:copy.offline);
    }
  }
  function discard(){
    requestNumber.current++;
    controller.current?.abort();
    setMode({kind:"idle"});
    setMessage("");
    onCommitted(); // fresh authorized read; never restore a discarded cached draft
  }
  async function commit(draft:Draft){
    if(!alive||draft.phase==="saving"||!navigator.onLine){
      setMessage(copy.offline);return;
    }
    if(note.revision!==draft.revision){
      setMode({kind:"draft",draft:{...draft,phase:"conflict"}});
      return;
    }
    if(draft.command===null&&!validNoteEditText(draft.title,draft.body)){
      setMessage(copy.invalid);return;
    }
    const command=draft.command??{
      ...draft.preview,commandId:crypto.randomUUID(),title:draft.title,body:draft.body,
    };
    const seq=++requestNumber.current;
    controller.current?.abort();
    const signal=new AbortController();
    controller.current=signal;
    setMode({kind:"draft",draft:{...draft,command,phase:"saving"}});
    setMessage("");
    const result=await saveNoteEdit(note.id,command,signal.signal);
    if(seq!==requestNumber.current||signal.signal.aborted||generation!==boundGeneration.current)return;
    if(result.outcome==="saved"){
      setMode({kind:"idle"});
      onCommitted(); // server-authorized refetch; never trust optimistic text
    }else if(result.outcome==="denied"){
      setMode({kind:"denied"});
      setMessage(copy.denied);
      onCommitted(); // removes revoked content on the next read
    }else{
      setMode({kind:"draft",draft:{
        ...draft,command,phase:result.outcome==="conflict"?"conflict":"uncertain",
      }});
    }
  }
  if(!alive)return null;
  if(mode.kind==="idle"||mode.kind==="checking"||mode.kind==="denied")
    return <div className="targetNoteEdit" data-testid="target-note-edit">
      {mode.kind==="idle"&&<button type="button" onClick={()=>{void begin();}}>{copy.edit}</button>}
      {mode.kind==="checking"&&<p role="status">{copy.checking}</p>}
      {mode.kind==="denied"&&<p role="status">{copy.denied}</p>}
      {message&&<p role="alert">{message}</p>}
    </div>;
  const d=mode.draft;
  const stale=note.revision!==d.revision;
  const conflict=d.phase==="conflict"||stale;
  const busy=d.phase==="saving";
  const uncertain=d.phase==="uncertain"&&!stale;
  const locked=busy||uncertain||conflict;
  return <form className="targetNoteEdit" data-testid="target-note-edit"
    onSubmit={(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!locked)void commit(d);}}>
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
      {uncertain&&<button type="button" onClick={()=>{void commit(d);}}>{copy.retry}</button>}
      {conflict&&<button type="button" onClick={discard}>{copy.refresh}</button>}
    </div>
  </form>;
}
