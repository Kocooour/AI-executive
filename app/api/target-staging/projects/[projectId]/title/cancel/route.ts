/** A successful cancel is a DURABLE write fence, not merely an absent receipt.
 * Serializes with PATCH under pinned BEGIN IMMEDIATE and anti-rollback journal. */
import path from "node:path";
import {logStagingFailure} from "../../../../../../../lib/target-staging-failure-log";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin} from "../../../../../../../lib/http-security";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,stagingUnauthorizedRefusal} from "../../../../../../../lib/target-staging-http-identity";
import {cancelProjectTitleInChild} from "../../../../../../../lib/target-staging-title-http-process";
import {targetProtocolRefusal,resyncRequiredResponse} from "../../../../../../../lib/target-staging-write-contract";
import {isReadableStagingProjectId} from "../../../../../../../lib/target-project-id";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9_.:@-]{1,120}$/;
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED==="true";
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&
    expectedRestoreGeneration&&UUID.test(expectedRestoreGeneration)&&ownerUserId&&ID.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
const unchanged=(base:NonNullable<ReturnType<typeof config>>)=>{
  const current=config();
  return enabled()&&current?.stagingDirectory===base.stagingDirectory&&
    current.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    current.ownerUserId===base.ownerUserId;
};
export async function POST(request:Request,context:{params:Promise<{projectId:string}>}):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();if(!base)return answer(503,"Staging unavailable");
  const bound={...base,...stagingChildSessionConfig(identity)};
  try{
    requireSameOrigin(request);
    if(request.headers.get("origin")!==new URL(request.url).origin)return answer(403,"Cross-origin request rejected");
    const refused=admitStagingIdentity(request,identity,bound);if(refused)return refused;
    const params=await context.params;
    const projectId=params&&Object.keys(params).join(",")==="projectId"&&
      isReadableStagingProjectId(params.projectId)?params.projectId:null;
    if(!projectId||new URL(request.url).search!=="")return answer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-project-title-cancel",30,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const input=await readJsonBody<unknown>(request,512,{strictUtf8:true});
    if(!input||typeof input!=="object"||Array.isArray(input)||
       Object.keys(input).sort().join(",")!=="commandId,restoreGeneration")return answer(400,"Invalid request");
    const value=input as Record<string,unknown>;
    if(typeof value.commandId!=="string"||!UUID.test(value.commandId)||
       typeof value.restoreGeneration!=="string"||!UUID.test(value.restoreGeneration))return answer(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,bound);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    const result=await cancelProjectTitleInChild(bound,{
      projectId,commandId:value.commandId,restoreGeneration:value.restoreGeneration,
    });
    if(identity.kind==="owner"){
      const after=verifyStagingIdentityBeforeRelease(request,identity,bound);
      if(after!=="ok")return stagingIdentityRefusal(after);
    }
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,bound);
    if(!result&&identity.kind==="session"){
      const after=verifyStagingIdentityBeforeRelease(request,identity,bound);
      if(after!=="ok")return stagingIdentityRefusal(after);
    }
    if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return answer(404,"Not found");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      return answer(503,"Staging unavailable");
    }
    return Response.json({status:result.status},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/projects/[projectId]/title/cancel","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
