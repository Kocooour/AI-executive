/** R3-CAPTURE-1: read-only, server-authorized private Area choices for
 * target Quick Capture. This endpoint never creates or modifies a note. */
import path from "node:path";
import {enforceRateLimit} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {readStagingPrivateNoteAreaTargetsInChild} from
  "../../../../../lib/target-staging-read-process";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const flags=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
] as const;
const enabled=()=>flags.every(f=>process.env[f]==="true");
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&
    expectedRestoreGeneration&&uuid.test(expectedRestoreGeneration)&&
    ownerUserId&&actor.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
function unchanged(base:NonNullable<ReturnType<typeof config>>){
  const current=config();
  return enabled()&&current?.stagingDirectory===base.stagingDirectory&&
    current.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    current.ownerUserId===base.ownerUserId;
}
export async function GET(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();
  if(!base)return answer(503,"Staging unavailable");
  const admission=admitStagingIdentity(request,identity,base);
  if(admission)return admission;
  try{
    if(new URL(request.url).search)return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-private-note-areas",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const targets=await readStagingPrivateNoteAreaTargetsInChild({
      ...base,...stagingChildSessionConfig(identity),
    });
    const released=targets?verifyStagingReadBeforeRelease(
      request,identity,base,base.ownerUserId,targets.linearization,
    ):verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")
      return stagingIdentityRefusal(released);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    if(released==="stale")return answer(409,"read_stale_reload");
    if(!targets){
      logStagingFailure("private_note_areas","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    // The internal actor, revision witnesses, and session hash are forbidden
    // in this DTO. Every id is still re-authorized by the create writer.
    return Response.json({areas:targets.areas},{headers});
  }catch(error){
    logStagingFailure("private_note_areas","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
