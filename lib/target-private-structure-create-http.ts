/** Default-off owner-private project and project-child task create HTTP boundary.
 * No UI, shared Area, project transfer, legacy-store write or actor from JSON.
 * Recovery is a read-only actor+command probe: "not_recorded" cannot prove
 * that a concurrent original create will not commit later.
 */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "./http-security";
import {logStagingFailure} from "./target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  stagingUnauthorizedRefusal,verifyStagingIdentityBeforeRelease,
  verifyStagingReadBeforeRelease,type StagingHttpIdentity}
  from "./target-staging-http-identity";
import {validPrivateStructureCreateCommand,type PrivateStructureKind,
  type PrivateStructureCreateCommand} from "./target-private-structure-create-writer";
import {createStructureInChild,readStructureCreateStatusInChild,
  readStructureCreateRecoveryInChild,cancelStructureCreateInChild} from "./target-staging-structure-create-process";
import {readStagingPrivateProjectDetailInChild,readStagingTemporalDetailInChild}
  from "./target-staging-read-process";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import {targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse}
  from "./target-staging-write-contract";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {structureOwnerScopeForIdentity} from "./target-private-structure-owner-scope";

const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const flag=(kind:PrivateStructureKind)=>kind==="project"
  ?process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED==="true"
  :process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED==="true";
const enabled=(kind:PrivateStructureKind)=>flag(kind)&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true";
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&expectedRestoreGeneration&&
    UUID.test(expectedRestoreGeneration)&&ownerUserId&&ACTOR.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
type Config=NonNullable<ReturnType<typeof config>>;
function unchanged(base:Config,kind:PrivateStructureKind){
  const now=config();
  return enabled(kind)&&!!now&&now.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    now.ownerUserId===base.ownerUserId;
}
/** A committed receipt alone never grants read access to the created row.
 * The read child proves current private ownership; the final HTTP release
 * additionally checks the live durable identity and, for tasks, live ACL/revisions.
 */
async function releaseCommitted(
  request:Request,identity:StagingHttpIdentity,base:Config,kind:PrivateStructureKind,
  id:string,projectId:string,areaId:string,
):Promise<Response>{
  const child:StagingPersonalReadConfig={...base,...stagingChildSessionConfig(identity)};
  const store:TargetStagingReadStore={
    stagingDirectory:base.stagingDirectory,
    expectedRestoreGeneration:base.expectedRestoreGeneration,
  };
  if(kind==="project"){
    const result=await readStagingPrivateProjectDetailInChild(child,projectId);
    const check=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(check!=="ok")return stagingIdentityRefusal(check);
    if(!unchanged(base,kind))return answer(503,"Staging unavailable");
    if(!result)return answer(503,"Staging unavailable");
    if(!result.ok||result.project.id!==id||result.project.areaId!==areaId||
      result.project.areaKind!=="private")return answer(404,"Not found");
  }else{
    const result=await readStagingTemporalDetailInChild(child,id);
    const check=result?.ok===true
      ?verifyStagingReadBeforeRelease(request,identity,store,base.ownerUserId,
        result.detail.linearization,
        undefined,undefined,undefined,undefined,undefined,undefined,
        result.detail.guard)
      :verifyStagingIdentityBeforeRelease(request,identity,store);
    if(check!=="ok"&&check!=="stale")return stagingIdentityRefusal(check);
    if(!unchanged(base,kind))return answer(503,"Staging unavailable");
    if(!result)return answer(503,"Staging unavailable");
    if(check==="stale"||!result.ok||result.detail.task.id!==id||
      result.detail.task.projectId!==projectId||
      result.detail.task.areaId!==areaId||
      result.detail.task.areaKind!=="private"||
      result.detail.linearization.areas.length!==1||
      result.detail.linearization.areas[0]?.areaId!==areaId||
      result.detail.linearization.areas[0]?.access!=="private-owner")
      return answer(404,"Not found");
  }
  return Response.json({status:"committed",id},{headers});
}
async function handle(
  request:Request,kind:PrivateStructureKind,mode:"create"|"status"|"recovery"|"cancel",
):Promise<Response>{
  if(!enabled(kind))return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();if(!base)return answer(503,"Staging unavailable");
  const store={stagingDirectory:base.stagingDirectory,
    expectedRestoreGeneration:base.expectedRestoreGeneration};
  try{
    requireSameOrigin(request);
    if(request.headers.get("origin")!==new URL(request.url).origin)
      return answer(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,store);
    if(admitted)return admitted;
    if(new URL(request.url).search!=="")return answer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);if(protocol)return protocol;
    const limited=enforceRateLimit(request,
      "target-private-structure-"+kind+"-"+mode,mode==="create"?30:60,600_000);
    if(limited)return Response.json({error:"Too many requests"},
      {status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const data=await readJsonBody<unknown>(request,mode==="recovery"?128:mode==="cancel"?256:16*1024,
      {strictUtf8:true});
    const legacy=legacySnapshotRefusal(data);if(legacy)return legacy;
    const input=data&&typeof data==="object"&&!Array.isArray(data)
      ?data as Record<string,unknown>:null;
    const opaque=!!input&&Object.keys(input).sort().join(",")==="commandId"&&
      typeof input.commandId==="string"&&UUID.test(input.commandId);
    const cancelOpaque=!!input&&Object.keys(input).sort().join(",")==="commandId,ownerScope"&&
      typeof input.commandId==="string"&&UUID.test(input.commandId)&&
      typeof input.ownerScope==="string"&&/^[A-Za-z0-9_-]{43}$/.test(input.ownerScope);
    if(mode==="recovery"?!opaque:mode==="cancel"?!cancelOpaque:
      !validPrivateStructureCreateCommand(kind,data))
      return answer(400,"Invalid request");
    const released=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(released!=="ok")return stagingIdentityRefusal(released);
    if(!unchanged(base,kind))return answer(503,"Staging unavailable");
    const child={...base,...stagingChildSessionConfig(identity)};
    if(mode==="cancel"){
      const ownerScope=structureOwnerScopeForIdentity(identity,base);
      if(!ownerScope)return answer(503,"Staging unavailable");
      // This actor-bound opaque comparison is mandatory even for an UNKNOWN
      // command (which has no receipt from which to recover original ownership).
      // A newly logged-in DIFFERENT actor must not fence their own command UUID
      // and unlock a marker belonging to a different actor.
      if(ownerScope!==(data as {ownerScope:string}).ownerScope)
        return answer(404,"Not found");
      const result=await cancelStructureCreateInChild(
        child,kind,(data as {commandId:string}).commandId);
      const check=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(check!=="ok")return stagingIdentityRefusal(check);
      if(!unchanged(base,kind)||!result||result.ok===false)
        return answer(503,"Staging unavailable");
      return Response.json({status:result.status},{headers});
    }
    if(mode==="recovery"){
      const result=await readStructureCreateRecoveryInChild(
        child,kind,(data as {commandId:string}).commandId);
      const check=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(check!=="ok")return stagingIdentityRefusal(check);
      if(!unchanged(base,kind)||!result)return answer(503,"Staging unavailable");
      if(!result.ok)return answer(404,"Not found");
      if(result.status==="not_recorded")
        return Response.json({status:"not_recorded"},{headers});
      return releaseCommitted(request,identity,base,kind,
        result.id,result.projectId,result.areaId);
    }
    const command=data as PrivateStructureCreateCommand;
    if(mode==="status"){
      const result=await readStructureCreateStatusInChild(child,kind,command);
      const check=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(check!=="ok")return stagingIdentityRefusal(check);
      if(!unchanged(base,kind)||!result)return answer(503,"Staging unavailable");
      if(result.ok===false)return answer(result.reason==="idempotency_conflict"?409:404,
        result.reason==="idempotency_conflict"?"Revision conflict":"Not found");
      if(result.status==="not_recorded")
        return Response.json({status:"not_recorded"},{headers});
      const id=kind==="project"?command.projectId:
        (command as {taskId:string}).taskId;
      const areaId=kind==="project"?(command as {areaId:string}).areaId:
        null;
      if(areaId!==null)return releaseCommitted(request,identity,base,kind,
        id,command.projectId,areaId);
      // For a project child, only the server's read child can establish the
      // effective parent Area. Never accept an Area value from the command.
      const recovery=await readStructureCreateRecoveryInChild(
        child,kind,command.commandId);
      if(!recovery||!recovery.ok||recovery.status!=="committed")
        return answer(503,"Staging unavailable");
      return releaseCommitted(request,identity,base,kind,
        recovery.id,recovery.projectId,recovery.areaId);
    }
    const result=await createStructureInChild(child,kind,command);
    const check=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(check!=="ok")return stagingIdentityRefusal(check);
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,store);
    if(!unchanged(base,kind)||!result)return answer(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return answer(404,"Not found");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(result.reason==="idempotency_conflict")return answer(409,"Revision conflict");
      return answer(503,"Staging unavailable");
    }
    const id=kind==="project"?command.projectId:(command as {taskId:string}).taskId;
    return Response.json(result.replayed?{ok:true,id,replayed:true}:{ok:true,id},
      {status:result.replayed?200:201,headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/structure-create-"+kind+"-"+mode,
      "route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export const postPrivateProjectCreate=(request:Request)=>handle(request,"project","create");
export const postPrivateProjectCreateStatus=(request:Request)=>handle(request,"project","status");
export const postPrivateProjectCreateRecovery=(request:Request)=>handle(request,"project","recovery");
export const postPrivateProjectTaskCreate=(request:Request)=>handle(request,"project-task","create");
export const postPrivateProjectTaskCreateStatus=(request:Request)=>handle(request,"project-task","status");
export const postPrivateProjectTaskCreateRecovery=(request:Request)=>handle(request,"project-task","recovery");

export const postPrivateProjectCreateCancel=(request:Request)=>handle(request,"project","cancel");
export const postPrivateProjectTaskCreateCancel=(request:Request)=>handle(request,"project-task","cancel");
