/** Actor-authorized writable private Areas for structure creation, independent
 * of note-create flags. A returned Area/generation is NEVER a write grant. */
import path from "node:path";
import {enforceRateLimit} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease}
  from "../../../../../lib/target-staging-http-identity";
import {readStagingPrivateNoteAreaTargetsInChild} from "../../../../../lib/target-staging-read-process";
import {structureOwnerScopeForIdentity} from "../../../../../lib/target-private-structure-owner-scope";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true"&&
  (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED==="true"||
   process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED==="true");
function config(){
  const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const restoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return directory&&path.isAbsolute(directory)&&restoreGeneration&&uuid.test(restoreGeneration)&&
    ownerUserId&&actor.test(ownerUserId)
    ?{stagingDirectory:directory,expectedRestoreGeneration:restoreGeneration,ownerUserId}:null;
}
export async function GET(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();if(!base)return answer(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);if(admitted)return admitted;
  try{
    if(new URL(request.url).search)return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-private-structure-areas",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,
      headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const page=await readStagingPrivateNoteAreaTargetsInChild({
      ...base,...stagingChildSessionConfig(identity),
    });
    const check=page?verifyStagingReadBeforeRelease(
      request,identity,base,base.ownerUserId,page.linearization)
      :verifyStagingIdentityBeforeRelease(request,identity,base);
    if(check!=="ok"&&check!=="stale")return stagingIdentityRefusal(check);
    const latest=config();
    if(!enabled()||latest?.stagingDirectory!==base.stagingDirectory||
      latest.expectedRestoreGeneration!==base.expectedRestoreGeneration||
      latest.ownerUserId!==base.ownerUserId)return answer(503,"Staging unavailable");
    if(check==="stale")return answer(409,"read_stale_reload");
    if(!page)return answer(503,"Staging unavailable");
    // Stable across reauthentication of the SAME actor, unlike auth-generation.
    // It is never a write capability or a substitute for the live session check.
    const ownerScope=structureOwnerScopeForIdentity(identity,base);
    if(!ownerScope)return answer(503,"Staging unavailable");
    const afterScope=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(afterScope!=="ok")return stagingIdentityRefusal(afterScope);
    const final=config();
    if(!enabled()||final?.stagingDirectory!==base.stagingDirectory||
      final.expectedRestoreGeneration!==base.expectedRestoreGeneration||
      final.ownerUserId!==base.ownerUserId)return answer(503,"Staging unavailable");
    return Response.json({areas:page.areas,restoreGeneration:base.expectedRestoreGeneration,
      ownerScope},{headers});
  }catch(error){
    logStagingFailure("private_structure_areas","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
