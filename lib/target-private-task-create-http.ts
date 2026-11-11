/** R3-BE-4c.2: two default-off, private-only task creation HTTP boundaries.
 * Never writes the legacy DB. No actor, parent project or sharing may be supplied. */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "./http-security";
import {logStagingFailure} from "./target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  stagingUnauthorizedRefusal,verifyStagingIdentityBeforeRelease,
  verifyStagingReadBeforeRelease,type StagingHttpIdentity}
  from "./target-staging-http-identity";
import {validPrivateTaskCreateCommand,type PrivateTaskCreateCommand}
  from "./target-private-task-create-writer";
import {createPrivateTaskInChild,readPrivateTaskCreateStatusInChild,
  readPrivateTaskCreateRecoveryInChild}
  from "./target-staging-task-create-process";
import {readStagingTemporalDetailInChild,type StagingTemporalDetailResult}
  from "./target-staging-read-process";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse}
  from "./target-staging-write-contract";

const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const flags=["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED"] as const;
const enabled=()=>flags.every(key=>process.env[key]==="true");
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&
    expectedRestoreGeneration&&uuid.test(expectedRestoreGeneration)&&
    ownerUserId&&actor.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
type Config=NonNullable<ReturnType<typeof config>>;
function unchanged(base:Config):boolean{
  const now=config();return enabled()&&!!now&&
    now.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    now.ownerUserId===base.ownerUserId;
}
/**
 * Recheck the server-derived Area witness and task/parent revisions against the
 * live SQLite immediately before releasing a committed receipt. Kept separate
 * from the child read so a stale snapshot can be regression-tested exactly.
 * A receipt alone is never read authorization for a task.
 */
export function releasePrivateTaskCreateCommittedStatus(
  request:Request,identity:StagingHttpIdentity,store:TargetStagingReadStore,
  ownerUserId:string,command:Pick<PrivateTaskCreateCommand,"taskId"|"areaId">,
  detail:StagingTemporalDetailResult|null,
):Response{
  const live=detail?.ok===true
    ?verifyStagingReadBeforeRelease(request,identity,store,ownerUserId,
      detail.detail.linearization,
      undefined,undefined,undefined,undefined,undefined,undefined,
      detail.detail.guard)
    :verifyStagingIdentityBeforeRelease(request,identity,store);
  if(live!=="ok"&&live!=="stale")return stagingIdentityRefusal(live);
  if(!detail)return answer(503,"Staging unavailable");
  if(live==="stale"||detail.ok===false||
    detail.detail.task.id!==command.taskId||
    detail.detail.guard.taskId!==command.taskId||
    detail.detail.task.projectId!==null||
    detail.detail.task.areaId!==command.areaId||
    detail.detail.task.areaKind!=="private"||
    detail.detail.linearization.areas.length!==1||
    detail.detail.linearization.areas[0]?.areaId!==command.areaId||
    detail.detail.linearization.areas[0]?.access!=="private-owner")
    return answer(404,"Not found");
  return Response.json({status:"committed"},{headers});
}
async function handle(request:Request,mode:"create"|"status"|"recovery"):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
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
    const limited=enforceRateLimit(request,mode==="create"?
      "target-staging-private-task-create":mode==="status"?
      "target-staging-private-task-create-status":"target-staging-private-task-create-recovery",
      mode==="create"?30:60,600_000);
    if(limited)return Response.json({error:"Too many requests"},
      {status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const data=await readJsonBody<unknown>(request,mode==="recovery"?128:16*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(data);if(legacy)return legacy;
    const opaque=mode==="recovery"&&!!data&&typeof data==="object"&&!Array.isArray(data)&&
      Object.keys(data).join(",")==="commandId"&&
      typeof (data as {commandId?:unknown}).commandId==="string"&&
      uuid.test((data as {commandId:string}).commandId);
    if(mode==="recovery"?!opaque:!validPrivateTaskCreateCommand(data))
      return answer(400,"Invalid request");
    const command=mode==="recovery"?null:data as PrivateTaskCreateCommand;
    const verified=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(verified!=="ok")return stagingIdentityRefusal(verified);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    const child={...base,...stagingChildSessionConfig(identity)};
    if(mode==="recovery"){
      const result=await readPrivateTaskCreateRecoveryInChild(
        child,(data as {commandId:string}).commandId);
      const current=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(current!=="ok")return stagingIdentityRefusal(current);
      if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
      if(result.ok===false)return answer(404,"Not found");
      if(result.status==="not_recorded")
        return Response.json({status:"not_recorded"},{headers});
      const detail=await readStagingTemporalDetailInChild(child,result.taskId);
      if(!unchanged(base))return answer(503,"Staging unavailable");
      const response=releasePrivateTaskCreateCommittedStatus(
        request,identity,store,base.ownerUserId,result,detail);
      if(!unchanged(base))return answer(503,"Staging unavailable");
      // Unlike exact-command status, a reload has discarded the original
      // task ID. Only AFTER the server has verified live actor + private Area
      // + exact task on the current store may we return its opaque ID for an
      // authorized detail navigation. Never send title or Area to the client.
      return response.status===200
        ?Response.json({status:"committed",taskId:result.taskId},{headers})
        :response;
    }
    if(command===null)return answer(400,"Invalid request");
    if(mode==="status"){
      const result=await readPrivateTaskCreateStatusInChild(child,command);
      const current=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(current!=="ok")return stagingIdentityRefusal(current);
      if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
      if(result.ok===false){
        if(result.reason==="idempotency_conflict")
          return answer(409,"Revision conflict");
        return answer(404,"Not found");
      }
      if(result.status==="not_recorded")
        return Response.json({status:"not_recorded"},{headers});
      // A receipt never authorizes a detached task snapshot. Release only
      // after the exact private task/Area witness passes the live-read fence.
      const detail=await readStagingTemporalDetailInChild(child,command.taskId);
      if(!unchanged(base))return answer(503,"Staging unavailable");
      const response=releasePrivateTaskCreateCommittedStatus(
        request,identity,store,base.ownerUserId,command,detail);
      if(!unchanged(base))return answer(503,"Staging unavailable");
      return response;
    }
    const result=await createPrivateTaskInChild(child,command);
    // A write may have committed just before the session was revoked:
    // do not release a success response without a fresh live identity check.
    const checked=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(checked!=="ok")return stagingIdentityRefusal(checked);
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,store);
    if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return answer(404,"Not found");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(result.reason==="idempotency_conflict")return answer(409,"Revision conflict");
      return answer(503,"Staging unavailable");
    }
    return Response.json(result.replayed?
      {ok:true,taskId:command.taskId,replayed:true}:
      {ok:true,taskId:command.taskId},
      {status:result.replayed?200:201,headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure(mode==="status"?
      "target-staging/private-task-create-status":mode==="recovery"?
      "target-staging/private-task-create-recovery":"target-staging/private-task-create",
      "route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export const postPrivateTaskCreate=(request:Request)=>handle(request,"create");
export const postPrivateTaskCreateStatus=(request:Request)=>handle(request,"status");
export const postPrivateTaskCreateRecovery=(request:Request)=>handle(request,"recovery");
