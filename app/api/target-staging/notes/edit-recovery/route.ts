/** Read-only recovery of a tab's random note-edit command ID. */
import path from "node:path";
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,verifyStagingNoteBeforeRelease} from "../../../../../lib/target-staging-http-identity";
import {readStagingNoteEditRecoveryInChild} from "../../../../../lib/target-staging-title-http-process";
import {readStagingAuthorizedNoteInChild} from "../../../../../lib/target-staging-read-process";
import {targetProtocolRefusal} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const answer=(status:number,error:string)=>Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED==="true";
function config(){
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory&&path.isAbsolute(stagingDirectory)&&expectedRestoreGeneration&&
    uuid.test(expectedRestoreGeneration)&&ownerUserId&&safeActor.test(ownerUserId)
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
    if(request.headers.get("origin")!==new URL(request.url).origin)return answer(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,base);if(admitted)return admitted;
    if(new URL(request.url).search)return answer(400,"Invalid request");
    const unsupported=targetProtocolRefusal(request);if(unsupported)return unsupported;
    const limited=enforceRateLimit(request,"target-staging-note-edit-recovery",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const input=await readJsonBody<unknown>(request,128,{strictUtf8:true});
    if(!input||typeof input!=="object"||Array.isArray(input)||
      Object.keys(input).join(",")!=="commandId"||
      typeof (input as {commandId?:unknown}).commandId!=="string"||
      !uuid.test((input as {commandId:string}).commandId))return answer(400,"Invalid request");
    const live=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(live!=="ok")return stagingIdentityRefusal(live);
    if(!unchanged(base))return answer(503,"Staging unavailable");
    const childConfig={...base,...stagingChildSessionConfig(identity)};
    const result=await readStagingNoteEditRecoveryInChild(childConfig,(input as {commandId:string}).commandId);
    const released=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok")return stagingIdentityRefusal(released);
    if(!unchanged(base)||!result)return answer(503,"Staging unavailable");
    if(!result.ok)return answer(404,"Not found");
    if(result.status==="not_recorded")return Response.json({status:"not_recorded"},{headers});
    const note=await readStagingAuthorizedNoteInChild(childConfig,result.noteId);
    const after=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(after!=="ok")return stagingIdentityRefusal(after);
    if(!unchanged(base)||!note)return answer(503,"Staging unavailable");
    if(!note.ok||note.note.areaId!==result.areaId||
      !["private-owner","editor","admin"].includes(note.linearization.areas[0]?.access??""))
      return answer(404,"Not found");
    const guard=verifyStagingNoteBeforeRelease(request,identity,base,base.ownerUserId,note.linearization,note.guard);
    if(guard!=="ok")return answer(404,"Not found");
    return Response.json({status:"committed"},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/note-edit-recovery","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
