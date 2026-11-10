"use client";
/** No optimistic update or storage: a submitted command survives this inspector
 * only inside the authenticated runtime's generation-bound recovery bucket. */
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useTargetGeneration,useTargetRuntime} from './target-data-provider';
import {queuedTargetFetch} from '../../lib/target-read-queue';
import {loadProjectTasksPage,type ProjectTasksProject} from '../../lib/target-staging-project-tasks-client';
import {loadProjectTitleEditPreview,validProjectTitleEditText,type ProjectTitleEditCommand,type ProjectTitleEditPreview} from '../../lib/target-staging-project-title-edit-client';
import {forgetTrackedProjectTitleEdit,runTrackedProjectTitleEdit,subscribeTrackedProjectTitleEdit,trackedProjectTitleEdit,projectTitleDraft,setProjectTitleDraft,forgetProjectTitleDraft,projectTitleDraftConflicts,type TrackedProjectTitleEditPhase} from '../../lib/target-project-title-edit-recovery';
import type {DetailLanguage} from '../../lib/target-detail-copy';

const readFetch=queuedTargetFetch();
type Draft={preview:ProjectTitleEditPreview; original:string; title:string; command:ProjectTitleEditCommand|null; phase:'edit'|'saving'|'uncertain'|'conflict'};
type Mode={kind:'idle'|'checking'|'denied'|'recovery'}|{kind:'draft';draft:Draft};
const words={
 cs:{edit:'Upravit název',checking:'Ověřuji oprávnění k úpravě…',denied:'Úprava není dostupná pro tento přístup.',recover:'Obnovit stav posledního ukládání',recovering:'Předchozí uložení není potvrzené. Ověřte přístup a pokračujte stejným příkazem.',title:'Název projektu',save:'Uložit změny',cancel:'Zahodit úpravy',saving:'Ukládám…',invalid:'Vyplňte název v povolené délce bez mezer na začátku a konci.',uncertain:'Výsledek ukládání není jistý. Zopakujte přesně stejný příkaz.',retry:'Ověřit uložením znovu',conflict:'Projekt nebo oprávnění se změnily. Koncept se neuložil.',offline:'Bez připojení nelze změny bezpečně uložit.',refresh:'Zahodit koncept a načíst aktuální obsah'},
 en:{edit:'Edit title',checking:'Checking edit access…',denied:'Editing is not available for this access.',recover:'Recover previous save',recovering:'A previous save remains unconfirmed. Verify access before retrying the same command.',title:'Project title',save:'Save changes',cancel:'Discard changes',saving:'Saving…',invalid:'Enter a title within the limit without leading or trailing spaces.',uncertain:'The save outcome is uncertain. Retry the exact same command.',retry:'Retry the same command',conflict:'The project or access changed. Your draft was not saved.',offline:'Changes cannot be saved safely while offline.',refresh:'Discard draft and reload'},
};
const editorPhase=(phase:TrackedProjectTitleEditPhase):Draft['phase']=>phase==='saving'?'saving':phase==='uncertain'?'uncertain':'conflict';
export default function TargetProjectTitleEditor({project,language,onCommitted,onAccessRefused}:{
  project:ProjectTasksProject;language:DetailLanguage;onCommitted:()=>void;onAccessRefused:()=>void;
}){
 const copy=words[language],runtime=useTargetRuntime(),generation=useTargetGeneration();
 const bound=useRef(generation),alive=bound.current!==''&&generation===bound.current;
 const stillBound=()=>runtime?.known()===true&&runtime.generation()===bound.current&&document.visibilityState!=='hidden'&&navigator.onLine;
 const [mode,setMode]=useState<Mode>({kind:'idle'}),[message,setMessage]=useState('');
 const seq=useRef(0),controller=useRef<AbortController|null>(null);
 const editRef=useRef<HTMLButtonElement|null>(null),inputRef=useRef<HTMLInputElement|null>(null);
 const previousMode=useRef<Mode['kind']>('idle');
 useEffect(()=>{
   const previous=previousMode.current;previousMode.current=mode.kind;
   if(mode.kind==='draft'&&previous!=='draft')inputRef.current?.focus();
   else if(mode.kind==='idle'&&previous!=='idle')editRef.current?.focus();
 },[mode.kind]);
 useEffect(()=>()=>{seq.current++;controller.current?.abort();},[]);
 useEffect(()=>{if(alive)return;seq.current++;controller.current?.abort();setMode({kind:'idle'});setMessage('');},[alive]);
 function refuse(){
   if(runtime){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);forgetProjectTitleDraft(runtime,bound.current,project.id);}
   seq.current++;controller.current?.abort();setMode({kind:'denied'});setMessage(copy.denied);onAccessRefused();
 }
 useEffect(()=>{
   if(!runtime||!alive)return;
   const sync=()=>{
     const tracked=trackedProjectTitleEdit(runtime,bound.current,project.id);if(!tracked)return;
     if(tracked.phase==='saved'){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);seq.current++;controller.current?.abort();setMode({kind:'idle'});onCommitted();}
     else if(tracked.phase==='denied')refuse();
     else setMode(previous=>previous.kind==='draft'&&previous.draft.command?.commandId===tracked.command.commandId
       ?{kind:'draft',draft:{...previous.draft,phase:editorPhase(tracked.phase)}}:previous);
   };
   const unsubscribe=subscribeTrackedProjectTitleEdit(runtime,bound.current,project.id,sync);
   const existing=trackedProjectTitleEdit(runtime,bound.current,project.id);
   if(existing){if(existing.phase==='saved'){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);onCommitted();}
     else if(existing.phase==='denied')refuse();else{setMode({kind:'recovery'});void recover();}}
   else if(projectTitleDraft(runtime,bound.current,project.id)){setMode({kind:'recovery'});void recoverDraft();}
   return unsubscribe;
   // Runtime generation and project identity are the recovery boundary.
   // eslint-disable-next-line react-hooks/exhaustive-deps
 },[runtime,generation,project.id,alive]);
 async function recover(){
   if(!runtime||!alive)return;
   if(!stillBound()){setMode({kind:'recovery'});setMessage(copy.offline);return;}
   const tracked=trackedProjectTitleEdit(runtime,bound.current,project.id);
   if(!tracked){setMode({kind:'idle'});return;}
   if(tracked.phase==='saved'){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);onCommitted();return;}
   if(tracked.phase==='denied'){refuse();return;}
   const id=++seq.current;controller.current?.abort();const current=new AbortController();controller.current=current;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,current.signal,readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(result.ok===false){if(result.reason==='denied')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   if(result.preview.writeAreaId!==project.areaId||result.preview.writeAreaId!==tracked.command.writeAreaId||result.preview.restoreGeneration.toLowerCase()!==tracked.command.restoreGeneration.toLowerCase()){refuse();return;}
   const latest=trackedProjectTitleEdit(runtime,bound.current,project.id);
   if(!latest||latest.command.commandId!==tracked.command.commandId)return;
   if(latest.phase==='saved'){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);onCommitted();}
   else if(latest.phase==='denied')refuse();
   else setMode({kind:'draft',draft:{preview:result.preview,original:project.title,title:latest.command.title,command:latest.command,phase:editorPhase(latest.phase)}});
 }
 async function recoverDraft(){
   if(!runtime||!alive)return;
   const stored=projectTitleDraft(runtime,bound.current,project.id);
   if(!stored){setMode({kind:'idle'});return;}
   if(!stillBound()){setMode({kind:'recovery'});setMessage(copy.offline);return;}
   const id=++seq.current;controller.current?.abort();const current=new AbortController();controller.current=current;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,current.signal,readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(result.ok===false){if(result.reason==='denied')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   // Only reveal the stored title after a fresh writer ACL and same Area check.
   if(result.preview.writeAreaId!==stored.writeAreaId||result.preview.writeAreaId!==project.areaId){refuse();return;}
   const fresh=await loadProjectTasksPage({projectId:project.id,limit:1,signal:current.signal},readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(fresh.ok===false){if(fresh.reason==='signed-out'||fresh.reason==='not-found')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   if(fresh.page.project.areaId!==stored.writeAreaId){refuse();return;}
   const conflict=projectTitleDraftConflicts(stored,result.preview,fresh.page.project.title)||project.title!==stored.original;
   setMode({kind:'draft',draft:{preview:result.preview,original:stored.original,title:stored.title,command:null,phase:conflict?'conflict':'edit'}});
 }
 async function begin(){
   if(!runtime||!alive)return;
   if(trackedProjectTitleEdit(runtime,bound.current,project.id)){void recover();return;}
   if(projectTitleDraft(runtime,bound.current,project.id)){void recoverDraft();return;}
   if(!stillBound()){setMessage(copy.offline);return;}
   const id=++seq.current;controller.current?.abort();const current=new AbortController();controller.current=current;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,current.signal,readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(result.ok===false){if(result.reason==='denied')refuse();else{setMode({kind:'idle'});setMessage(copy.offline);}return;}
   // The edit token must be associated with the same visible project/Area;
   // any later concurrent change is still rejected by transactional CAS.
   const fresh=await loadProjectTasksPage({projectId:project.id,limit:1,signal:current.signal},readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(fresh.ok===false){
     if(fresh.reason==='signed-out'||fresh.reason==='not-found')refuse();
     else {setMode({kind:'idle'});setMessage(copy.conflict);onAccessRefused();}
     return;
   }
   if(fresh.page.project.title!==project.title||fresh.page.project.areaId!==project.areaId||
      fresh.page.project.areaId!==result.preview.writeAreaId){
     setMode({kind:'idle'});setMessage(copy.conflict);onAccessRefused();return;
   }
   setProjectTitleDraft(runtime,bound.current,project.id,{original:project.title,title:project.title,...result.preview});
   setMode({kind:'draft',draft:{preview:result.preview,original:project.title,title:project.title,command:null,phase:'edit'}});
 }
 function discard(){
   if(runtime){const tracked=trackedProjectTitleEdit(runtime,bound.current,project.id);if(tracked?.phase==='saving'||tracked?.phase==='uncertain')return;forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);forgetProjectTitleDraft(runtime,bound.current,project.id);}
   seq.current++;controller.current?.abort();setMode({kind:'idle'});setMessage('');onCommitted();
 }
 function commit(d:Draft){
   if(!runtime||!alive||!stillBound()||d.phase==='saving'){setMessage(copy.offline);return;}
   const retry=d.command!==null;
   if(!retry&&(project.title!==d.original||project.areaId!==d.preview.writeAreaId)){setMode({kind:'draft',draft:{...d,phase:'conflict'}});return;}
   if(!retry&&d.title===project.title){forgetProjectTitleDraft(runtime,bound.current,project.id);setMode({kind:'idle'});return;}
   if(!retry&&!validProjectTitleEditText(d.title)){setMessage(copy.invalid);return;}
   const command=d.command??{...d.preview,commandId:crypto.randomUUID(),title:d.title};
   setMode({kind:'draft',draft:{...d,command,phase:'saving'}});setMessage('');
   void runTrackedProjectTitleEdit(runtime,bound.current,project.id,command);
   forgetProjectTitleDraft(runtime,bound.current,project.id);
 }
 if(!alive)return null;
 if(mode.kind!=='draft')return <div className="targetNoteEdit" data-testid="target-project-title-edit">
   {mode.kind==='idle'&&<button ref={editRef} type="button" onClick={()=>void begin()}>{copy.edit}</button>}
   {mode.kind==='checking'&&<p role="status">{copy.checking}</p>}
   {mode.kind==='denied'&&<p role="status">{copy.denied}</p>}
   {mode.kind==='recovery'&&<><p role="status">{copy.recovering}</p><button type="button" onClick={()=>{if(runtime&&trackedProjectTitleEdit(runtime,bound.current,project.id))void recover();else void recoverDraft();}}>{copy.recover}</button></>}
   {message&&<p role="alert">{message}</p>}</div>;
 const d=mode.draft,conflict=d.phase==='conflict'||(d.command===null&&(project.title!==d.original||project.areaId!==d.preview.writeAreaId));
 const busy=d.phase==='saving',uncertain=d.phase==='uncertain',locked=busy||uncertain||conflict;
 return <form className="targetNoteEdit" data-testid="target-project-title-edit" onSubmit={(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!locked)commit(d);}}>
   <label>{copy.title}<input ref={inputRef} type="text" value={d.title} readOnly={locked} maxLength={4096}
     onChange={event=>{const title=event.target.value;if(runtime)setProjectTitleDraft(runtime,bound.current,project.id,{original:d.original,title,...d.preview});setMode({kind:'draft',draft:{...d,title,command:null}});}}/></label>
   {message&&<p role="alert">{message}</p>}{busy&&<p role="status">{copy.saving}</p>}{conflict&&<p role="alert">{copy.conflict}</p>}{uncertain&&<p role="alert">{copy.uncertain}</p>}
   <div className="targetNoteEditActions">{!locked&&<><button type="submit">{copy.save}</button><button type="button" onClick={discard}>{copy.cancel}</button></>}
   {uncertain&&<button type="button" onClick={()=>commit(d)}>{copy.retry}</button>}{conflict&&<button type="button" onClick={discard}>{copy.refresh}</button>}</div>
 </form>;
}
