/** Durable, content-free cancellation fence for an uncertain project title PATCH.
 * It serializes with the writer's BEGIN IMMEDIATE and is retained across reload.
 * A stale/lost PATCH after a successfully committed fence must NEVER rename.
 */
import {createHash} from "node:crypto";
import {isReadableStagingProjectId} from "./target-project-id";
import {readAuthorizedProjectTasksPage} from "./target-project-task-read-model";
import {canWriteIsolatedTargetArea,targetStoreRestoreGeneration} from "./target-task-write-preflight";
import {verifiedActor,type TargetStagingReadCredential} from "./target-task-authenticated-read";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession} from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {TARGET_STORE_SCHEMA_VERSION,TARGET_STAGING_AUDIT_MAX_EVENTS,
  TARGET_STAGING_PROJECT_TITLE_CANCEL_PREFIX} from "./target-store-bootstrap";

const BINDING=/^[A-Za-z0-9_-]{43}$/;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX=TARGET_STAGING_PROJECT_TITLE_CANCEL_PREFIX;
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ProjectTitleCancelCommand={projectId:string;commandId:string;restoreGeneration:string;principalBinding:string};
export type ProjectTitleCancelResult=
  |{ok:true;status:"cancelled"|"committed"}
  |{ok:false;reason:"unauthorized"|"invalid_request"|"unavailable"|"resync_required"|"session_revoked"|"write_failed"};
export const validProjectTitleCancelCommand=(v:unknown):v is ProjectTitleCancelCommand=>{
  if(!v||typeof v!=="object"||Array.isArray(v))return false;
  const x=v as Record<string,unknown>;
  return Object.keys(x).sort().join(",")==="commandId,principalBinding,projectId,restoreGeneration"&&
    isReadableStagingProjectId(x.projectId)&&typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    typeof x.principalBinding==="string"&&BINDING.test(x.principalBinding);
};
export const projectTitleCancelKey=(actor:string,projectId:string,commandId:string):string=>
  PREFIX+digest(["lumi:project-title-cancel",actor,projectId,commandId.toLowerCase()]);
export const projectTitleWasCancelled=(
  db:import("node:sqlite").DatabaseSync,actor:string,projectId:string,commandId:string,
):boolean=>{
  const row=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(projectTitleCancelKey(actor,projectId,commandId)) as {value:string}|undefined;
  return row?.value==="1";
};
export function cancelTargetProjectTitle(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:ProjectTitleCancelCommand,expectedActorUserId:string,durableSessionTokenHash?:string,
):ProjectTitleCancelResult{
  const denied=():ProjectTitleCancelResult=>({ok:false,reason:"unauthorized"});
  const failed=():ProjectTitleCancelResult=>({ok:false,reason:"write_failed"});
  if(!validProjectTitleCancelCommand(request))return {ok:false,reason:"invalid_request"};
  if(!ACTOR.test(expectedActorUserId))return denied();
  if(durableSessionTokenHash!==undefined&&!isTargetStagingSessionTokenHash(durableSessionTokenHash))return denied();
  return withPinnedTargetStagingWrite<ProjectTitleCancelResult>(store,context=>{
    const db=context.db,actor=verifiedActor(db,access,true);
    if(!actor||actor!==expectedActorUserId)return denied();
    const live=()=>durableSessionTokenHash===undefined||
      lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now())?.userId===actor;
    if(!live())return {ok:false,reason:"session_revoked"};
    if(targetStoreRestoreGeneration(db)!==request.restoreGeneration.toLowerCase())
      return {ok:false,reason:"resync_required"};
    const version=db.prepare("SELECT value FROM metadata WHERE key='schema_version'")
      .get() as {value:string}|undefined;
    if(version?.value!==String(TARGET_STORE_SCHEMA_VERSION))return failed();
    const page=readAuthorizedProjectTasksPage(db,{
      actorUserId:actor,projectId:request.projectId,limit:1,offset:0,
      restoreGeneration:request.restoreGeneration.toLowerCase(),
    });
    if(!page?.ok||!canWriteIsolatedTargetArea(db,actor,page.page.project.areaId))
      return {ok:false,reason:"unavailable"};
    const receipt=digest(["lumi:project-title",actor,request.projectId,request.commandId.toLowerCase()]);
    if(db.prepare("SELECT 1 FROM project_title_audit WHERE receipt_key=?").get(receipt)){
      if(!live())return {ok:false,reason:"session_revoked"};
      return {ok:true,status:"committed"};
    }
    if(projectTitleWasCancelled(db,actor,request.projectId,request.commandId)){
      if(!live())return {ok:false,reason:"session_revoked"};
      return {ok:true,status:"cancelled"};
    }
    const count=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(PREFIX+"%") as {n:number};
    if(count.n>=TARGET_STAGING_AUDIT_MAX_EVENTS)return failed();
    if(!context.stillPinned()||!context.noSidecars()||!live())return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
      .run(projectTitleCancelKey(actor,request.projectId,request.commandId),"1");
    if(!live())return {ok:false,reason:"session_revoked"};
    // Project-title journal kind, explicitly distinguished as a fence action.
    // COMMIT and the anti-rollback witness are atomic; a missing confirm is not success.
    return context.commit({kind:"project_title",payload:{cancel:1}})
      ?{ok:true,status:"cancelled"}:failed();
  },denied,failed,3_000); // Same bounded lock grace as the racing PATCH.
}
