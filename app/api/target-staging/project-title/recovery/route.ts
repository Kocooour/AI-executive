/** Read-only project rename receipt recovery. Never returns a title or receipt key. */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease} from "../../../../../lib/target-staging-http-identity";
import {readProjectTitleRecoveryInChild} from "../../../../../lib/target-staging-title-http-process";
import {readStagingProjectTitlePreviewInChild} from "../../../../../lib/target-staging-read-process";
import {targetProtocolRefusal} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED==="true";
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&expectedRestoreGeneration&&
    UUID.test(expectedRestoreGeneration)&&ownerUserId&&ACTOR.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
const unchanged=(base:NonNullable<ReturnType<typeof config>>)=>{
  const now=config();return enabled()&&now?.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&now.ownerUserId===base.ownerUserId;
};
export async function POST(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();if(!base)return answer(503,"Staging unavailable");
  const bound={...base,...stagingChildSessionConfig(identity)};
  try{
    requireSameOrigin(request);
    if(request.headers.get("origin")!==new URL(request.url).origin)return answer(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,bound);if(admitted)return admitted;
    if(request.url.includes("?"))return answer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-project-title-recovery",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const input=await readJsonBody<unknown>(request,128,{strictUtf8:true});
    if(!input||typeof input!=="object"||Array.isArray(input)||
      Object.keys(input).join(",")!=="commandId"||
      typeof (input as {commandId?:unknown}).commandId!=="string"||
      !UUID.test((input as {commandId:string}).commandId))return answer(400,"Invalid request");
    const checked=verifyStagingIdentityBeforeRelease(request,identity,bound);
    if(checked!=="ok")return stagingIdentityRefusal(checked);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    const result=await readProjectTitleRecoveryInChild(bound,(input as {commandId:string}).commandId);
    const live=verifyStagingIdentityBeforeRelease(request,identity,bound);
    if(live!=="ok")return stagingIdentityRefusal(live);
    if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
    if(!result.ok)return answer(404,"Not found");
    if(result.status==="not_recorded")return Response.json({status:"not_recorded"},{headers});
    const project=await readStagingProjectTitlePreviewInChild(bound,result.projectId);
    if(!project||!project.ok||project.page.project.areaId!==result.areaId||
      !["private-owner","editor","admin"].includes(project.page.linearization.areas[0]?.access??""))
      return answer(404,"Not found");
    const released=verifyStagingReadBeforeRelease(request,identity,bound,base.ownerUserId,
      project.page.linearization,{
        projectId:result.projectId,areaId:result.areaId,taskIds:project.page.tasks.map(t=>t.id),
      });
    if(released!=="ok")return released==="stale"?answer(404,"Not found"):stagingIdentityRefusal(released);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    return Response.json({status:"committed"},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/project-title-recovery","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
