/** R2d.3m.8: staging-only, default-off combined Vše/Osobní/Sdílené. */
import path from "node:path";
import {authenticationBinding} from "../../../../lib/auth";
import {enforceRateLimit} from "../../../../lib/http-security";
import {logStagingFailure} from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,stagingCursorIdentity,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
  verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import {readStagingGlobalCombinedPageInChild} from "../../../../lib/target-staging-read-process";
import {
  signGlobalCombinedCursor,verifyGlobalCombinedCursor,
} from "../../../../lib/target-staging-global-combined-http-cursor";
import {INITIAL_GLOBAL_COMBINED_POSITIONS} from "../../../../lib/target-global-combined-read-model";
import type {TargetGlobalTaskScope} from "../../../../lib/target-global-task-read-model";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer=(status:number,error:string):Response=>
  Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED==="true";

/** Combined HTTP remains isolated from the three source-specific flags. */
export async function GET(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!uuid.test(expectedRestoreGeneration)||
    !ownerUserId||!actor.test(ownerUserId))
    return answer(503,"Staging unavailable");
  const store={stagingDirectory,expectedRestoreGeneration};
  const refused=admitStagingIdentity(request,identity,store);
  if(refused)return refused;
  try{
    const params=new URL(request.url).searchParams;
    const keys=["scope","limit","cursor"];
    if([...params.keys()].some(k=>!keys.includes(k))||
      keys.some(k=>params.getAll(k).length>1))return answer(400,"Invalid request");
    const requestedScope=params.get("scope")??"all";
    if(!["all","personal","shared"].includes(requestedScope))
      return answer(400,"Invalid request");
    const scope=requestedScope as TargetGlobalTaskScope;
    const rawLimit=params.get("limit");
    if(rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if(cursor!==null&&(cursor.length>4096||!cursorPattern.test(cursor)))
      return answer(400,"Invalid request");
    const limited=enforceRateLimit(
      request,"target-staging-global-combined",120,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const identityBinding=stagingCursorIdentity(
      identity,ownerUserId,authenticationBinding(request));
    const context={
      ...identityBinding,stagingDirectory,
      restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
      scope,limit,
    };
    const previous=cursor===null?null:verifyGlobalCombinedCursor(context,cursor);
    if(previous?.ok===false)return answer(previous.reason==="expired"?409:400,
      previous.reason==="expired"?"Cursor expired":"Invalid cursor");
    const positions=previous?.ok===true?previous.positions:{
      ...INITIAL_GLOBAL_COMBINED_POSITIONS,
    };
    const page=await readStagingGlobalCombinedPageInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },scope,limit,positions);
    // The LIVE read checks session + entire eligible Area policy/content and
    // note_sync revisions atomically before any project/task/note is returned.
    const release=page?verifyStagingReadBeforeRelease(
      request,identity,store,ownerUserId,page.linearization,
      undefined,undefined,undefined,undefined,undefined,
      {areas:page.areaEpochs,scope:scope==="all"?"global-all":scope,
        noteAreaEpochs:page.noteAreaEpochs}
    ):verifyStagingIdentityBeforeRelease(request,identity,store);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!enabled()||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return answer(503,"Staging unavailable");
    if(release==="stale")return answer(409,"read_stale_reload");
    if(!page){
      logStagingFailure("global_combined","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    if(previous?.ok===true&&previous.revision!==page.revision)
      return answer(409,"Cursor stale");
    const nextCursor=page.nextPositions?signGlobalCombinedCursor(
      context,page.revision,page.nextPositions,
      previous?.ok===true?previous.expiresAt:undefined):null;
    if(page.hasMore&&!nextCursor)return answer(503,"Staging unavailable");
    // Never return actor, note body, Area epochs, linearization, revision
    // or raw typed positions. Only validated mixed-item allowlist.
    return Response.json({
      scope:page.scope,items:page.items,hasMore:page.hasMore,nextCursor,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/global-index","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
