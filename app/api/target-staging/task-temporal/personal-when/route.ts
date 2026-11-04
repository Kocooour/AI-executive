/** R2d.3k.3: default-off staging-only actor-private planned-day HTTP read. */
import {createHash} from "node:crypto";
import path from "node:path";
import {authenticationBinding} from "../../../../../lib/auth";
import {enforceRateLimit} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,stagingCursorIdentity,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {temporalCalendarOrdinal} from "../../../../../lib/target-task-temporal-read-model";
import {readStagingPersonalWhenInChild} from "../../../../../lib/target-staging-read-process";
import {signStagingProjectHttpCursor,verifyStagingProjectHttpCursor}
  from "../../../../../lib/target-staging-project-http-cursor";
import type {PersonalWhenWindow} from "../../../../../lib/target-personal-when-read-model";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUser=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const reply=(status:number,error:string):Response=>Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED==="true";
function privateCursorBinding(binding:string,window:PersonalWhenWindow,
  evaluationDate:string|null,throughDate:string|null,limit:number):string {
  return createHash("sha256").update("lumi:r2d:personal-when-http-cursor:v1\0")
    .update(JSON.stringify([binding,window,evaluationDate,throughDate,limit]))
    .digest("base64url");
}
export async function GET(request:Request):Promise<Response>{
  if(!enabled())return reply(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!uuid.test(expectedRestoreGeneration)||
    !ownerUserId||!validUser.test(ownerUserId))
    return reply(503,"Staging unavailable");
  const store={stagingDirectory,expectedRestoreGeneration};
  const refused=admitStagingIdentity(request,identity,store);
  if(refused)return refused;
  try{
    const params=new URL(request.url).searchParams;
    const keys=["window","evaluationDate","throughDate","limit","cursor"];
    if([...params.keys()].some(k=>!keys.includes(k))||
      keys.some(k=>params.getAll(k).length>1))return reply(400,"Invalid request");
    const window=params.get("window");
    if(!["all","on-day","upcoming"].includes(window??""))
      return reply(400,"Invalid request");
    const evaluationDate=params.get("evaluationDate");
    const throughDate=params.get("throughDate");
    const day=evaluationDate===null?null:temporalCalendarOrdinal(evaluationDate);
    const end=throughDate===null?null:temporalCalendarOrdinal(throughDate);
    if(window==="all"?(evaluationDate!==null||throughDate!==null):
       window==="on-day"?(day===null||throughDate!==null):
         day===null||end===null||end-day<1||end-day>90)
      return reply(400,"Invalid request");
    const rawLimit=params.get("limit");
    if(rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return reply(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if(cursor!==null&&(cursor.length>4096||!cursorPattern.test(cursor)))
      return reply(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-personal-when",120,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const identityBinding=stagingCursorIdentity(
      identity,ownerUserId,authenticationBinding(request));
    const context={
      ...identityBinding,
      authenticationBinding:privateCursorBinding(
        identityBinding.authenticationBinding,window as PersonalWhenWindow,
        evaluationDate,throughDate,limit),
      stagingDirectory,restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
    };
    const previous=cursor===null?null:verifyStagingProjectHttpCursor(context,cursor);
    if(previous?.ok===false)return reply(previous.reason==="expired"?409:400,
      previous.reason==="expired"?"Cursor expired":"Invalid cursor");
    const offset=previous?.ok===true?previous.offset:0;
    const page=await readStagingPersonalWhenInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },window as PersonalWhenWindow,evaluationDate,throughDate,limit,offset);
    const release=page?verifyStagingReadBeforeRelease(
      request,identity,store,ownerUserId,page.linearization,
      undefined,undefined,undefined,undefined,undefined,undefined,undefined,
      {privateEpoch:page.privateEpoch}
    ):verifyStagingIdentityBeforeRelease(request,identity,store);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!enabled()||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return reply(503,"Staging unavailable");
    if(release==="stale")return reply(409,"read_stale_reload");
    if(!page){
      logStagingFailure("personal_when","child_page_unavailable");
      return reply(503,"Staging unavailable");
    }
    if(previous?.ok===true&&previous.revision!==page.revision)
      return reply(409,"Cursor stale");
    const nextCursor=page.hasMore?signStagingProjectHttpCursor(context,page.revision,
      offset+page.plans.length,previous?.ok===true?previous.expiresAt:undefined):null;
    if(page.hasMore&&!nextCursor)return reply(503,"Staging unavailable");
    // Never release actor/witness, private epoch, task/Area policy or raw child JSON.
    return Response.json({
      plans:page.plans,hasMore:page.hasMore,nextCursor,
      window:page.window,evaluationDate:page.evaluationDate,throughDate:page.throughDate,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/task-temporal/personal-when","route_exception",error);
    return reply(503,"Staging unavailable");
  }
}
