/** R3-FE-4a: ephemeral, generation-bound read session for ONE authorized detail
 * (task, project with its tasks, or note) shown inside the main app.
 *
 * It composes the existing strict, no-store staging readers; the server stays
 * the only authority for actor, Area ACL and revisions. A session is pinned to
 * the runtime generation it was created for: any change makes it terminal
 * ("stale") and drops everything it held. Nothing is cached beyond the open
 * view, persisted or logged, and every open performs a new server read.
 * Missing, foreign and revoked records are deliberately one answer. */
import {readStagingTaskPreview,type TaskPreview,type TaskPreviewFailure} from "./target-staging-task-preview-client";
import {readStagingNotePreview,type NotePreview,type NotePreviewFailure} from "./target-staging-note-preview-client";
import {
  appendProjectTasksPage,loadProjectTasksPage,type ProjectTasksFailure,type ProjectTasksPage,
} from "./target-staging-project-tasks-client";
import type {TargetDetailKind} from "./target-detail-route";

export type TargetDetailFailure=
  |"not-available"|"signed-out"|"stale"|"rate-limited"|"unavailable"|"offline"|"invalid-response";
export type TargetDetailContent=
  |{kind:"task";task:TaskPreview;parentTitle:string|null}
  |{kind:"project";page:ProjectTasksPage}
  |{kind:"note";note:NotePreview};
export type TargetDetailResult=
  |{ok:true;content:TargetDetailContent}
  |{ok:false;reason:TargetDetailFailure|"superseded"|"not-ready"};

type AnyFailure=TaskPreviewFailure|NotePreviewFailure|ProjectTasksFailure;
/** Not found, foreign, revoked, malformed and disabled are indistinguishable by design. */
export function detailFailure(reason:AnyFailure):TargetDetailFailure|"aborted"{
  switch(reason){
    case "not-found":case "invalid-request":case "disabled":return "not-available";
    case "signed-out":case "stale":case "rate-limited":case "unavailable":
    case "offline":case "invalid-response":return reason;
    default:return "aborted";
  }
}

export function createTargetDetailSession(
  config:{kind:TargetDetailKind;id:string;contextVersion:()=>string},
  fetchImpl:typeof fetch=fetch,
){
  const version=()=>{
    try{
      const value=config.contextVersion();
      return typeof value==="string"&&value.length>0&&value.length<=256?value:null;
    }catch{return null;}
  };
  const pinned=version();
  let revision=0;
  let invalidated=false;
  let disposed=false;
  let suspended=false;
  let active:AbortController|null=null;
  let project:ProjectTasksPage|null=null;
  const clear=()=>{active?.abort();active=null;project=null;};
  // A generation mismatch is terminal even if the value later returns (A -> B -> A).
  const guard=():boolean=>{
    if(disposed||pinned===null)return false;
    if(invalidated)return false;
    if(version()!==pinned){invalidated=true;revision++;clear();return false;}
    return true;
  };
  const blocked=():TargetDetailResult|null=>{
    if(disposed)return {ok:false,reason:"superseded"};
    if(!guard())return {ok:false,reason:"stale"};
    if(suspended)return {ok:false,reason:"not-ready"};
    return null;
  };
  const fail=(reason:AnyFailure):TargetDetailResult=>{
    const mapped=detailFailure(reason);
    return mapped==="aborted"?{ok:false,reason:"superseded"}:{ok:false,reason:mapped};
  };
  async function load():Promise<TargetDetailResult>{
    const refused=blocked();
    if(refused)return refused;
    const ticket=++revision;
    active?.abort();
    project=null;
    const controller=new AbortController();
    active=controller;
    const live=()=>ticket===revision&&!controller.signal.aborted;
    let result:TargetDetailResult;
    if(config.kind==="task"){
      const read=await readStagingTaskPreview(config.id,controller.signal,fetchImpl);
      if(!live())return {ok:false,reason:"superseded"};
      if(read.ok===false)result=fail(read.reason);
      else{
        // The parent title is best effort and shown only if the server also
        // authorizes the project; any failure simply leaves it out.
        let parentTitle:string|null=null;
        if(read.task.projectId!==null){
          const parent=await loadProjectTasksPage(
            {projectId:read.task.projectId,limit:1,signal:controller.signal},fetchImpl);
          if(!live())return {ok:false,reason:"superseded"};
          if(parent.ok===true)parentTitle=parent.page.project.title;
          else if(parent.reason==="signed-out"){
            if(guard())active=null;
            return fail(parent.reason);
          }
        }
        result={ok:true,content:{kind:"task",task:read.task,parentTitle}};
      }
    }else if(config.kind==="note"){
      const read=await readStagingNotePreview(config.id,controller.signal,fetchImpl);
      if(!live())return {ok:false,reason:"superseded"};
      result=read.ok===false?fail(read.reason):{ok:true,content:{kind:"note",note:read.note}};
    }else{
      const read=await loadProjectTasksPage({projectId:config.id,signal:controller.signal},fetchImpl);
      if(!live())return {ok:false,reason:"superseded"};
      if(read.ok===false)result=fail(read.reason);
      else{project=read.page;result={ok:true,content:{kind:"project",page:read.page}};}
    }
    // The generation may have changed while the response was in flight.
    if(!guard())return {ok:false,reason:"stale"};
    active=null;
    return result;
  }
  async function loadMore():Promise<TargetDetailResult>{
    const refused=blocked();
    if(refused)return refused;
    const prior=project;
    if(config.kind!=="project"||!prior)return {ok:false,reason:"not-ready"};
    if(!prior.hasMore||prior.nextCursor===null)
      return {ok:true,content:{kind:"project",page:prior}};
    if(active)return {ok:false,reason:"not-ready"};
    const ticket=++revision;
    const controller=new AbortController();
    active=controller;
    const cursor=prior.nextCursor;
    const read=await loadProjectTasksPage(
      {projectId:config.id,cursor,signal:controller.signal},fetchImpl);
    if(ticket!==revision||controller.signal.aborted)return {ok:false,reason:"superseded"};
    if(!guard())return {ok:false,reason:"stale"};
    active=null;
    if(read.ok===false)return fail(read.reason);
    const merged=appendProjectTasksPage(prior,read.page,cursor);
    if(!merged){project=null;return {ok:false,reason:"invalid-response"};}
    project=merged;
    return {ok:true,content:{kind:"project",page:merged}};
  }
  return {
    load,loadMore,
    /** Hidden tab / offline / BFCache: abort and forget everything. */
    suspend():void{
      if(disposed)return;
      revision++;clear();suspended=true;
    },
    /** Allows an explicit new read; never fetches by itself. */
    resume():boolean{
      if(disposed||!guard())return false;
      revision++;clear();suspended=false;
      return true;
    },
    dispose():void{disposed=true;revision++;clear();},
  };
}
export type TargetDetailSession=ReturnType<typeof createTargetDetailSession>;
