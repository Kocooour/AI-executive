/** R3-CAPTURE-2: no-side-effect preflight for explicit private target Area.
 * A successful preview is NOT permission; the CREATE transaction rechecks ACL. */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin} from
  "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease} from
  "../../../../../lib/target-staging-http-identity";
import {readStagingPrivateNoteAreaTargetsInChild} from
  "../../../../../lib/target-staging-read-process";
import {targetProtocolRefusal} from "../../../../../lib/target-staging-write-contract";
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
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED",
] as const;
const enabled=()=>flags.every(x=>process.env[x]==="true");
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
  const now=config();return enabled()&&now?.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    now.ownerUserId===base.ownerUserId;
}
export async function POST(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=config();if(!base)return answer(503,"Staging unavailable");
  try{
    requireSameOrigin(request);
    if(request.headers.get("origin")!==new URL(request.url).origin)
      return answer(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,base);if(admitted)return admitted;
    if(new URL(request.url).search)return answer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-staging-private-create-preview",60,600000);
    if(limited)return Response.json({error:"Too many requests"},
      {status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const raw=await readJsonBody<unknown>(request,1024,{strictUtf8:true});
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||
      Object.keys(raw).join(",")!=="areaId")return answer(400,"Invalid request");
    const areaId=(raw as {areaId?:unknown}).areaId;
    if(typeof areaId!=="string"||areaId.length===0||
      areaId!==areaId.trim()||Buffer.byteLength(areaId,"utf8")>512||
      /[\u0000-\u001f\u007f]/u.test(areaId))return answer(400,"Invalid request");
    const targets=await readStagingPrivateNoteAreaTargetsInChild({
      ...base,...stagingChildSessionConfig(identity),
    });
    const released=targets?verifyStagingReadBeforeRelease(
      request,identity,base,base.ownerUserId,targets.linearization,
    ):verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    if(released==="stale")return answer(409,"read_stale_reload");
    if(!targets)return answer(503,"Staging unavailable");
    if(!targets.areas.some(a=>a.id===areaId))return answer(404,"Not found");
    // No signed write lease is created; POST /notes re-authorizes atomically.
    return Response.json({restoreGeneration:base.expectedRestoreGeneration},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/private-create-preview","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
