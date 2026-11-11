"use client";
/** No optimistic update or storage: a submitted command survives this inspector
 * only inside the authenticated runtime's generation-bound recovery bucket. */
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useTargetGeneration,useTargetRuntime} from './target-data-provider';
import {queuedTargetFetch} from '../../lib/target-read-queue';
import {loadProjectTasksPage,type ProjectTasksProject} from '../../lib/target-staging-project-tasks-client';
import {loadProjectTitleEditPreview,validProjectTitleEditText,type ProjectTitleEditCommand,type ProjectTitleEditPreview} from '../../lib/target-staging-project-title-edit-client';
import {forgetTrackedProjectTitleEdit,runTrackedProjectTitleEdit,subscribeTrackedProjectTitleEdit,trackedProjectTitleEdit,projectTitleDraft,setProjectTitleDraft,forgetProjectTitleDraft,projectTitleDraftConflicts,hasSealedProjectTitleEdit,resumeSealedProjectTitleEdit,forgetSealedProjectTitleEdit,hasSealedProjectTitleDraft,resumeSealedProjectTitleDraft,forgetSealedProjectTitleDraft,type TrackedProjectTitleEditPhase} from '../../lib/target-project-title-edit-recovery';
import type {DetailLanguage} from '../../lib/target-detail-copy';
import {projectTitleReloadMarker,reserveProjectTitleReload,confirmProjectTitleReload}
  from '../../lib/target-project-title-reload';
import {recoverProjectTitleReceipt} from '../../lib/target-project-title-receipt-client';

const readFetch=queuedTargetFetch();
type Draft={preview:ProjectTitleEditPreview; original:string; title:string; command:ProjectTitleEditCommand|null; phase:'edit'|'saving'|'uncertain'|'conflict'};
type Mode={kind:'idle'|'checking'|'denied'|'recovery'|'reload'}|{kind:'draft';draft:Draft};
const words={
 cs:{edit:'Upravit název',checking:'Ověřuji oprávnění k úpravě…',denied:'Úprava není dostupná pro tento přístup.',recover:'Obnovit stav posledního ukládání',recovering:'Předchozí uložení není potvrzené. Ověřte přístup a pokračujte stejným příkazem.',title:'Název projektu',save:'Uložit změny',cancel:'Zahodit úpravy',saving:'Ukládám…',invalid:'Vyplňte název v povolené délce bez mezer na začátku a konci.',uncertain:'Výsledek ukládání není jistý. Zopakujte přesně stejný příkaz.',retry:'Ověřit uložením znovu',conflict:'Projekt nebo oprávnění se změnily. Koncept se neuložil.',offline:'Bez připojení nelze změny bezpečně uložit.',refresh:'Zahodit koncept a načíst aktuální obsah',reload:'Předchozí přejmenování není po obnovení stránky potvrzené. Nový zápis je zablokovaný, ale projekt lze dál číst.',receipt:'Ověřit předchozí zápis',notRecorded:'Server ještě nepotvrdil původní zápis. Nový příkaz se nespustí.',storageUnavailable:'Úložiště této záložky není dostupné. Přejmenování nelze bezpečně zahájit.',differentActor:'Nelze ověřit, že jste se přihlásili stejným účtem. Starý příkaz se neobnoví.'},
 en:{edit:'Edit title',checking:'Checking edit access…',denied:'Editing is not available for this access.',recover:'Recover previous save',recovering:'A previous save remains unconfirmed. Verify access before retrying the same command.',title:'Project title',save:'Save changes',cancel:'Discard changes',saving:'Saving…',invalid:'Enter a title within the limit without leading or trailing spaces.',uncertain:'The save outcome is uncertain. Retry the exact same command.',retry:'Retry the same command',conflict:'The project or access changed. Your draft was not saved.',offline:'Changes cannot be saved safely while offline.',refresh:'Discard draft and reload',reload:'The previous rename remains unconfirmed after a reload. New changes are blocked, but the project stays readable.',receipt:'Check previous save',notRecorded:'The server has not confirmed the original write. No new command will be issued.',storageUnavailable:'This tab storage is unavailable. A rename cannot safely begin.',differentActor:'The newly signed-in identity cannot be verified as the original writer. The old command remains blocked.'},
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
 function sessionExpired(){
  void runtime?.reportRefusal("session_expired");
  setMode({kind:'recovery'});setMessage(copy.recovering);
 }
 function refuse(){
   if(runtime){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);forgetProjectTitleDraft(runtime,bound.current,project.id);forgetSealedProjectTitleEdit(runtime,project.id);forgetSealedProjectTitleDraft(runtime,project.id);}
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
   else if(hasSealedProjectTitleEdit(runtime,project.id)){setMode({kind:'checking'});void recoverSealed();}
   else if(hasSealedProjectTitleDraft(runtime,project.id)){setMode({kind:'checking'});void recoverSealedDraft();}
   else if(projectTitleReloadMarker(bound.current).kind!=='clear'){setMode({kind:'checking'});void checkReloadForActor();}
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
   if(result.ok===false){if(result.reason==='expired')sessionExpired();else if(result.reason==='denied')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   if(result.preview.writeAreaId!==project.areaId||result.preview.writeAreaId!==tracked.command.writeAreaId||result.preview.restoreGeneration.toLowerCase()!==tracked.command.restoreGeneration.toLowerCase()){refuse();return;}
   const latest=trackedProjectTitleEdit(runtime,bound.current,project.id);
   if(!latest||latest.command.commandId!==tracked.command.commandId)return;
   if(latest.phase==='saved'){forgetTrackedProjectTitleEdit(runtime,bound.current,project.id);onCommitted();}
   else if(latest.phase==='denied')refuse();
   else setMode({kind:'draft',draft:{preview:result.preview,original:project.title,title:latest.command.title,command:latest.command,phase:editorPhase(latest.phase)}});
 }
 /** After session_expired, the old command may be disclosed ONLY after a
  * fresh authenticated, writable GET has proved the original same actor.
  * A mismatch drops its private title but preserves the global tab barrier. */
 async function recoverSealed(){
   if(!runtime||!alive)return;
   if(!stillBound()){setMode({kind:'recovery'});setMessage(copy.offline);return;}
   const seqId=++seq.current;controller.current?.abort();
   const ctrl=new AbortController();controller.current=ctrl;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,ctrl.signal,readFetch);
   if(seqId!==seq.current||ctrl.signal.aborted||!stillBound())return;
   if(result.ok===false){if(result.reason==='expired')sessionExpired();else if(result.reason==='denied')refuse();
     else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   if(result.preview.writeAreaId!==project.areaId){refuse();return;}
   const resolved=resumeSealedProjectTitleEdit(runtime,bound.current,project.id,result.preview);
   if(resolved==='resumed'){
     const held=trackedProjectTitleEdit(runtime,bound.current,project.id);
     if(!held){setMode({kind:'reload'});return;}
     setMode({kind:'draft',draft:{
       preview:result.preview,original:project.title,title:held.command.title,
       command:held.command,phase:'uncertain',
     }});
   }else{setMode({kind:'idle'});setMessage(copy.denied);}
 }
 /** A stale tab marker must never be disclosed to a DIFFERENT actor. */
 async function checkReloadForActor(){
   if(!runtime||!alive||!stillBound())return;
   const n=++seq.current;controller.current?.abort();const ctrl=new AbortController();controller.current=ctrl;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,ctrl.signal,readFetch);
   if(n!==seq.current||ctrl.signal.aborted||!stillBound())return;
   if(result.ok===false){
     if(result.reason==='expired')sessionExpired();
     else if(result.reason==='denied')refuse();
     else{setMode({kind:'idle'});setMessage(copy.offline);}
     return;
   }
   const own=projectTitleReloadMarker(bound.current,result.preview.principalBinding);
   if(own.kind==='blocked'){setMode({kind:'reload'});setMessage('');}
   else if(own.kind==='clear'){setMode({kind:'idle'});setMessage('');}
   else{setMode({kind:'idle'});setMessage(copy.storageUnavailable);}
 }
 /** On reload, no receipt is even queried until the CURRENT actor's fresh
  * server-issued project binding selects their own content-free marker. */
 async function reconcileReload(){
   if(!runtime||!alive)return;
   if(!stillBound()){setMessage(copy.offline);return;}
   const n=++seq.current;controller.current?.abort();
   const ctrl=new AbortController();controller.current=ctrl;
   setMode({kind:'checking'});setMessage('');
   const preview=await loadProjectTitleEditPreview(project.id,ctrl.signal,readFetch);
   if(n!==seq.current||ctrl.signal.aborted||!stillBound())return;
   if(preview.ok===false){
     if(preview.reason==='expired')sessionExpired();
     else if(preview.reason==='denied')refuse();
     else{setMode({kind:'reload'});setMessage(copy.offline);}
     return;
   }
   const marker=projectTitleReloadMarker(bound.current,preview.preview.principalBinding);
   if(marker.kind==='clear'){setMode({kind:'idle'});setMessage('');return;}
   if(marker.kind!=='blocked'){setMode({kind:'idle'});setMessage(copy.storageUnavailable);return;}
   const status=await recoverProjectTitleReceipt(marker.commandId,ctrl.signal);
   if(n!==seq.current||ctrl.signal.aborted||!stillBound())return;
   if(status.status==='committed'&&status.principalBinding===marker.principalBinding&&
      confirmProjectTitleReload(marker.commandId,marker.principalBinding)){
     setMode({kind:'idle'});onCommitted();return;
   }
   setMode({kind:'reload'});
   setMessage(status.status==='not_recorded'?copy.notRecorded:
     status.status==='denied'?copy.denied:
     status.status==='committed'?copy.differentActor:copy.offline);
 }
 /** Restore an unsent draft only after fresh authorized project and actor proofs. */
 async function recoverSealedDraft(){
  if(!runtime||!alive||!hasSealedProjectTitleDraft(runtime,project.id))return;
  if(!stillBound()){setMode({kind:'recovery'});setMessage(copy.offline);return;}
  const n=++seq.current;controller.current?.abort();const ctrl=new AbortController();controller.current=ctrl;
  setMode({kind:'checking'});setMessage('');
  const preview=await loadProjectTitleEditPreview(project.id,ctrl.signal,readFetch);
  if(n!==seq.current||ctrl.signal.aborted||!stillBound())return;
  if(preview.ok===false){
   if(preview.reason==='expired')sessionExpired();
   else if(preview.reason==='denied')refuse();
   else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;
  }
  const fresh=await loadProjectTasksPage({projectId:project.id,limit:1,signal:ctrl.signal},readFetch);
  if(n!==seq.current||ctrl.signal.aborted||!stillBound())return;
  if(fresh.ok===false){
   if(fresh.reason==='session-expired')sessionExpired();
   else if(fresh.reason==='signed-out'||fresh.reason==='not-found')refuse();
   else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;
  }
  if(fresh.page.project.areaId!==preview.preview.writeAreaId||
     project.areaId!==preview.preview.writeAreaId){refuse();return;}
  if(resumeSealedProjectTitleDraft(runtime,bound.current,project.id,preview.preview)!=='resumed'){
   setMode({kind:'idle'});setMessage(copy.denied);return;
  }
  const draft=projectTitleDraft(runtime,bound.current,project.id);
  if(!draft){setMode({kind:'idle'});return;}
  const conflict=projectTitleDraftConflicts(draft,preview.preview,fresh.page.project.title)||project.title!==draft.original;
  setMode({kind:'draft',draft:{preview:preview.preview,original:draft.original,title:draft.title,
   command:null,phase:conflict?'conflict':'edit'}});
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
   if(result.ok===false){if(result.reason==='expired')sessionExpired();else if(result.reason==='denied')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   // Only reveal the stored title after a fresh writer ACL and same Area check.
   if(result.preview.writeAreaId!==stored.writeAreaId||result.preview.writeAreaId!==project.areaId){refuse();return;}
   const fresh=await loadProjectTasksPage({projectId:project.id,limit:1,signal:current.signal},readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(fresh.ok===false){if(fresh.reason==='session-expired')sessionExpired();
   else if(fresh.reason==='signed-out'||fresh.reason==='not-found')refuse();else{setMode({kind:'recovery'});setMessage(copy.recovering);}return;}
   if(fresh.page.project.areaId!==stored.writeAreaId){refuse();return;}
   const conflict=projectTitleDraftConflicts(stored,result.preview,fresh.page.project.title)||project.title!==stored.original;
   setMode({kind:'draft',draft:{preview:result.preview,original:stored.original,title:stored.title,command:null,phase:conflict?'conflict':'edit'}});
 }
 async function begin(){
   if(!runtime||!alive)return;
   if(trackedProjectTitleEdit(runtime,bound.current,project.id)){void recover();return;}
   if(hasSealedProjectTitleEdit(runtime,project.id)){void recoverSealed();return;}
   if(hasSealedProjectTitleDraft(runtime,project.id)){void recoverSealedDraft();return;}
   if(projectTitleDraft(runtime,bound.current,project.id)){void recoverDraft();return;}
   if(!stillBound()){setMessage(copy.offline);return;}
   const id=++seq.current;controller.current?.abort();const current=new AbortController();controller.current=current;
   setMode({kind:'checking'});setMessage('');
   const result=await loadProjectTitleEditPreview(project.id,current.signal,readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(result.ok===false){if(result.reason==='expired')sessionExpired();else if(result.reason==='denied')refuse();else{setMode({kind:'idle'});setMessage(copy.offline);}return;}
   // A new authenticated actor may edit independently without clearing an
   // older actor's unresolved marker. Each write still has strict CAS.
   const barrier=projectTitleReloadMarker(bound.current,result.preview.principalBinding);
   if(barrier.kind!=='clear'){
     setMode(barrier.kind==='blocked'?{kind:'reload'}:{kind:'idle'});
     setMessage(barrier.kind==='unavailable'?copy.storageUnavailable:'');return;
   }
   // The edit token must be associated with the same visible project/Area;
   // any later concurrent change is still rejected by transactional CAS.
   const fresh=await loadProjectTasksPage({projectId:project.id,limit:1,signal:current.signal},readFetch);
   if(id!==seq.current||current.signal.aborted||!stillBound())return;
   if(fresh.ok===false){
     if(fresh.reason==='session-expired')sessionExpired();
   else if(fresh.reason==='signed-out'||fresh.reason==='not-found')refuse();
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
   // The server-only principal comparison proof is NEVER part of a mutation body.
   const command=d.command??{expectedRevision:d.preview.expectedRevision,
     writeAreaId:d.preview.writeAreaId,restoreGeneration:d.preview.restoreGeneration,
     commandId:crypto.randomUUID(),title:d.title};
   // Reserve a tab-global, content-free marker BEFORE dispatch. On a reload
   // the exact private command is gone; no new UUID may supersede it.
   if(!reserveProjectTitleReload(bound.current,command.commandId,d.preview.principalBinding)){
     setMode({kind:'reload'});
     setMessage(projectTitleReloadMarker(bound.current,d.preview.principalBinding).kind==='unavailable'
       ?copy.storageUnavailable:copy.reload);
     return;
   }
   setMode({kind:'draft',draft:{...d,command,phase:'saving'}});setMessage('');
   void runTrackedProjectTitleEdit(runtime,bound.current,project.id,command,
     undefined,undefined,d.preview.principalBinding);
   forgetProjectTitleDraft(runtime,bound.current,project.id);
 }
 if(!alive)return null;
 if(mode.kind!=='draft')return <div className="targetNoteEdit" data-testid="target-project-title-edit">
   {mode.kind==='idle'&&<button ref={editRef} type="button" onClick={()=>void begin()}>{copy.edit}</button>}
   {mode.kind==='checking'&&<p role="status">{copy.checking}</p>}
   {mode.kind==='denied'&&<p role="status">{copy.denied}</p>}
   {mode.kind==='recovery'&&<><p role="status">{copy.recovering}</p><button type="button" onClick={()=>{
     if(runtime&&trackedProjectTitleEdit(runtime,bound.current,project.id))void recover();
     else if(runtime&&hasSealedProjectTitleEdit(runtime,project.id))void recoverSealed();
     else if(runtime&&hasSealedProjectTitleDraft(runtime,project.id))void recoverSealedDraft();
      else void recoverDraft();}}>{copy.recover}</button></>}
   {mode.kind==='reload'&&<><p role="status">{copy.reload}</p><button type="button" onClick={()=>void reconcileReload()}>{copy.receipt}</button></>}
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
