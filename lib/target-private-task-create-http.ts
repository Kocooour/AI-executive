/** R3-BE-4c.2: two default-off, private-only task creation HTTP boundaries.
 * Never writes the legacy DB. No actor, parent project or sharing may be supplied. */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "./http-security";
import {logStagingFailure} from "./target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  stagingUnauthorizedRefusal,verifyStagingIdentityBeforeRelease}
  from "./target-staging-http-identity";
import {validPrivateTaskCreateCommand,type PrivateTaskCreateCommand}
  from "./target-private-task-create-writer";
import {createPrivateTaskInChild,readPrivateTaskCreateStatusInChild}
  from "./target-staging-task-create-process";
import {readStagingPersonalDetailInChild} from "./target-staging-read-process";
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
async function handle(request:Request,statusOnly:boolean):Promise<Response>{
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
    const limited=enforceRateLimit(request,statusOnly?
      "target-staging-private-task-create-status":"target-staging-private-task-create",
      statusOnly?60:30,600_000);
    if(limited)return Response.json({error:"Too many requests"},
      {status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const data=await readJsonBody<unknown>(request,16*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(data);if(legacy)return legacy;
    if(!validPrivateTaskCreateCommand(data))
      return answer(400,"Invalid request");
    const command:PrivateTaskCreateCommand=data;
    const verified=verifyStagingIdentityBeforeRelease(request,identity,store);
    if(verified!=="ok")return stagingIdentityRefusal(verified);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    const child={...base,...stagingChildSessionConfig(identity)};
    if(statusOnly){
      const result=await readPrivateTaskCreateStatusInChild(child,command);
      const current=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(current!=="ok")return stagingIdentityRefusal(current);
      if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
      if(!result.ok){
        if(result.reason==="idempotency_conflict")
          return answer(409,"Revision conflict");
        return answer(404,"Not found");
      }
      if(result.status==="not_recorded")
        return Response.json({status:"not_recorded"},{headers});
      // A receipt does not entitle a caller to learn about a deleted/moved
      // task. Repeat the current private task/Area check before release.
      const detail=await readStagingPersonalDetailInChild(child,command.taskId);
      const checked=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(checked!=="ok")return stagingIdentityRefusal(checked);
      if(!unchanged(base)||!detail)return answer(503,"Staging unavailable");
      if(!detail.ok||detail.task.projectId!==null||
        detail.task.effectiveAreaId!==command.areaId||
        detail.task.areaKind!=="private")return answer(404,"Not found");
      return Response.json({status:"committed"},{headers});
    }
    const result=await createPrivateTaskInChild(child,command);
    if(identity.kind==="owner"){
      const checked=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(checked!=="ok")return stagingIdentityRefusal(checked);
    }
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,store);
    if(!result&&identity.kind==="session"){
      const checked=verifyStagingIdentityBeforeRelease(request,identity,store);
      if(checked!=="ok")return stagingIdentityRefusal(checked);
    }
    if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
    if(!result.ok){
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
    logStagingFailure(statusOnly?
      "target-staging/private-task-create-status":"target-staging/private-task-create",
      "route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export const postPrivateTaskCreate=(request:Request)=>handle(request,false);
export const postPrivateTaskCreateStatus=(request:Request)=>handle(request,true);
