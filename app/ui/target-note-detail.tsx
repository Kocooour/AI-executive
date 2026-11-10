"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {readStagingNotePreview,type NotePreview,type NotePreviewFailure} from "../../lib/target-staging-note-preview-client";
import {patchNoteEdit,preflightNoteEdit,statusNoteEdit,type EditCommand,type EditFailure} from "../../lib/target-note-edit-client";
import {useTargetGeneration} from "./target-data-provider";
import {pendingNoteCommand,holdNoteCommand,clearNoteCommand} from "../../lib/target-note-pending-command";
import type {UrlScope} from "../../lib/view-url";
import type {ScopesLanguage} from "../../lib/target-scopes-copy";

type Failure=NotePreviewFailure|EditFailure;
type State={kind:"loading"}|{kind:"error";reason:Failure}|{kind:"ready";note:NotePreview}|
  {kind:"editing";note:NotePreview;title:string;body:string;invalid?:boolean;failure?:Failure}|
  {kind:"saving"}|{kind:"uncertain"}|{kind:"saved"};
const labels={
  cs:{back:"Zpět na poznámky",loading:"Ověřuji aktuální přístup…",unavailable:"Poznámka nebo přístup nejsou dostupné.",
    retry:"Znovu ověřit",edit:"Upravit",save:"Uložit",cancel:"Zrušit",title:"Název",body:"Obsah",
    saving:"Ukládám a ověřuji výsledek…",uncertain:"Výsledek uložení není jistý. Před další úpravou ověřte stav příkazu.",
    check:"Ověřit výsledek",notRecorded:"Zápis zatím nebyl potvrzen. Ověřte jeho stav znovu; nový zápis se nespouští.",
    saved:"Uloženo. Načtěte aktuální autorizovaný obsah.",savedRead:"Načíst obsah",offline:"Připojení není dostupné. Obsah byl skryt.",
    private:"Osobní oblast",shared:"Sdílená oblast",viewOnly:"V tomto režimu lze poznámku pouze číst."},
  en:{back:"Back to notes",loading:"Checking current access…",unavailable:"The note or access is unavailable.",
    retry:"Check again",edit:"Edit",save:"Save",cancel:"Cancel",title:"Title",body:"Content",
    saving:"Saving and checking the result…",uncertain:"The save result is uncertain. Check the command before editing again.",
    check:"Check result",notRecorded:"The write has not been confirmed. Check its status again; no new write is sent.",
    saved:"Saved. Load the current authorized content.",savedRead:"Load content",offline:"Connection unavailable. Content was hidden.",
    private:"Personal area",shared:"Shared area",viewOnly:"This note is read only here."},
};
const foreground=()=>document.visibilityState!=="hidden"&&navigator.onLine;
export default function TargetNoteDetail({noteId,scope,language="cs",editEnabled,onBack,onRefusal}:{
  noteId:string;scope:UrlScope;language?:ScopesLanguage;editEnabled:boolean;
  onBack:()=>void;onRefusal:()=>void;
}){
  const copy=labels[language];
  const generation=useTargetGeneration();
  const [state,setState]=useState<State>({kind:"loading"});
  const backRef=useRef<HTMLButtonElement>(null);
  const epoch=useRef(0);
  const readController=useRef<AbortController|null>(null);
  const draft=useRef<Extract<State,{kind:"editing"}>|null>(null);
  const stateRef=useRef(state);stateRef.current=state;
  const refusal=useRef(onRefusal);refusal.current=onRefusal;
  useEffect(()=>{backRef.current?.focus();},[noteId]);
  const load=useCallback(async()=>{
    const id=++epoch.current;
    readController.current?.abort();
    const controller=new AbortController();readController.current=controller;
    setState({kind:"loading"});
    if(!foreground()){setState({kind:"error",reason:"offline"});return;}
    const result=await readStagingNotePreview(noteId,controller.signal);
    if(epoch.current!==id||!foreground())return;
    readController.current=null;
    if(result.ok===false){
      if(result.reason==="signed-out")refusal.current();
      setState({kind:"error",reason:result.reason});return;
    }
    if(scope!=="all"&&result.note.areaKind!==(scope==="personal"?"private":"shared")){
      setState({kind:"error",reason:"not-found"});return;
    }
    setState({kind:"ready",note:result.note});
  },[noteId,scope]);
  useEffect(()=>{
    if(!generation){setState({kind:"error",reason:"stale"});return;}
    if(pendingNoteCommand(generation)){setState({kind:"uncertain"});return;}
    void load();
    return ()=>{epoch.current++;readController.current?.abort();};
  },[generation,load]);
  useEffect(()=>{
    const conceal=()=>{
      epoch.current++;readController.current?.abort();
      draft.current=null;
      setState(pendingNoteCommand(generation)?{kind:"uncertain"}:{kind:"error",reason:navigator.onLine?"stale":"offline"});
    };
    const visibility=()=>{if(document.visibilityState==="hidden")conceal();};
    const bfcache=(event:PageTransitionEvent)=>{if(event.persisted)conceal();};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("pagehide",conceal);
    window.addEventListener("offline",conceal);
    window.addEventListener("pageshow",bfcache);
    return ()=>{
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("pagehide",conceal);
      window.removeEventListener("offline",conceal);
      window.removeEventListener("pageshow",bfcache);
    };
  },[generation]);
  async function save(){
    const current=stateRef.current;
    if(current.kind!=="editing"||!foreground()||pendingNoteCommand(generation))return;
    const title=current.title.trim(),body=current.body;
    if(!title||new TextEncoder().encode(title).length>4096||new TextEncoder().encode(body).length>128*1024){
      setState({...current,invalid:true});return;
    }
    const id=++epoch.current;
    draft.current=current;
    setState({kind:"saving"});
    const controller=new AbortController();
    const proof=await preflightNoteEdit(noteId,controller.signal);
    if(id!==epoch.current||!foreground())return;
    if(proof.ok===false){
      if(proof.reason==="signed-out")refusal.current();
      if(proof.reason==="unavailable"||proof.reason==="rate-limited"||proof.reason==="invalid-response")
        setState({...current,failure:proof.reason});
      else {draft.current=null;setState({kind:"error",reason:proof.reason});}
      return;
    }
    // The preflight may be newer than the content the user edited. Re-read
    // after it so a fresh proof cannot overwrite unseen changes.
    const checked=await readStagingNotePreview(noteId,controller.signal);
    if(id!==epoch.current||!foreground())return;
    if(checked.ok===false){
      if(checked.reason==="signed-out")refusal.current();
      setState({kind:"error",reason:checked.reason});return;
    }
    if(checked.note.revision!==current.note.revision||
      checked.note.areaId!==current.note.areaId||
      checked.note.areaKind!==current.note.areaKind||
      checked.note.title!==current.note.title||checked.note.body!==current.note.body){
      setState({kind:"error",reason:"stale"});return;
    }
    // The preflight is a capability check, never a grant; PATCH repeats ACL,
    // revision, Area and restore checks under the server write transaction.
    if(proof.value.writeAreaId!==current.note.areaId){setState({kind:"error",reason:"stale"});return;}
    const command:EditCommand={...proof.value,commandId:crypto.randomUUID(),title,body};
    if(!holdNoteCommand(generation,noteId,command)){setState({kind:"uncertain"});return;}
    draft.current=null;
    const result=await patchNoteEdit(noteId,command,controller.signal);
    if(id!==epoch.current||!foreground())return;
    if(result.ok===true){clearNoteCommand(generation,command.commandId);setState({kind:"saved"});return;}
    if(result.reason==="signed-out")refusal.current();
    setState({kind:"uncertain"});
  }
  async function check(){
    const pending=pendingNoteCommand(generation);
    if(!pending||!foreground())return;
    const id=++epoch.current;
    setState({kind:"saving"});
    const result=await statusNoteEdit(pending.noteId,pending.command,new AbortController().signal);
    if(id!==epoch.current||!foreground())return;
    if(result.ok&&result.value==="committed"){
      clearNoteCommand(generation,pending.command.commandId);
      if(pending.noteId===noteId)setState({kind:"saved"});
      else void load();
      return;
    }
    if(result.ok===false&&result.reason==="signed-out")refusal.current();
    setState({kind:"uncertain"});
  }
  const note=state.kind==="ready"||state.kind==="editing"?state.note:null;
  return <section className="targetNoteDetail" data-testid="target-note-detail" aria-label={language==="cs"?"Detail poznámky":"Note detail"}>
    <button ref={backRef} type="button" onClick={onBack}>{copy.back}</button>
    {state.kind==="loading"&&<p role="status">{copy.loading}</p>}
    {state.kind==="error"&&<><p role="alert">{state.reason==="offline"?copy.offline:copy.unavailable}</p>
      <button type="button" onClick={()=>void load()}>{copy.retry}</button></>}
    {state.kind==="saving"&&<p role="status">{copy.saving}</p>}
    {state.kind==="uncertain"&&<><p role="alert">{copy.uncertain} {copy.notRecorded}</p>
      <button type="button" onClick={()=>void check()}>{copy.check}</button></>}
    {state.kind==="saved"&&<><p role="status">{copy.saved}</p>
      <button type="button" onClick={()=>void load()}>{copy.savedRead}</button></>}
    {note&&<article data-area-kind={note.areaKind}>
      <p>{note.areaKind==="private"?copy.private:copy.shared}</p>
      {state.kind==="editing"?<form onSubmit={event=>{event.preventDefault();void save();}}>
        <label>{copy.title}<input required maxLength={4096} value={state.title}
          onChange={event=>setState({...state,title:event.target.value,invalid:false})}/></label>
        <label>{copy.body}<textarea value={state.body}
          onChange={event=>setState({...state,body:event.target.value,invalid:false})}/></label>
        {state.invalid&&<p role="alert">{language==="cs"?"Název nebo obsah přesahuje povolenou délku.":"The title or content exceeds the allowed length."}</p>}
        {state.failure&&<p role="alert">{copy.unavailable}</p>}
        <div><button type="submit">{copy.save}</button><button type="button" onClick={()=>setState({kind:"ready",note:state.note})}>{copy.cancel}</button></div>
      </form>:<><h2>{note.title}</h2><pre>{note.body}</pre>
        {editEnabled?<button type="button" onClick={()=>setState({kind:"editing",note,title:note.title,body:note.body})}>{copy.edit}</button>
          :<p>{copy.viewOnly}</p>}</>}
    </article>}
  </section>;
}
