/** R2d.3l.2: isolated default-off task-only My Plan today/upcoming GET. */
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
import {readStagingMyPlanDayInChild} from "../../../../../lib/target-staging-read-process";
import {signStagingProjectHttpCursor,verifyStagingProjectHttpCursor}
  from "../../../../../lib/target-staging-project-http-cursor";
import type {MyPlanTaskAreaFilter,MyPlanTaskDayWindow}
  from "../../../../../lib/target-my-plan-day-task-read-model";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer=(status:number,error:string):Response=>
  Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED==="true";

function dayCursorBinding(
  binding:string,areaFilter:MyPlanTaskAreaFilter,window:MyPlanTaskDayWindow,
  evaluationDate:string,throughDate:string|null,limit:number,
):string {
  return createHash("sha256").update("lumi:r2d:my-plan-day-http-cursor:v1\0")
    .update(JSON.stringify([binding,areaFilter,window,evaluationDate,throughDate,limit]))
    .digest("base64url");
}

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

  try {
    const params=new URL(request.url).searchParams;
    const keys=["areaFilter","window","evaluationDate","throughDate","limit","cursor"];
    if([...params.keys()].some(k=>!keys.includes(k))||
      keys.some(k=>params.getAll(k).length>1))return answer(400,"Invalid request");
    const areaFilter=params.get("areaFilter")??"all";
    const window=params.get("window");
    const evaluationDate=params.get("evaluationDate");
    const throughDate=params.get("throughDate");
    if(!["all","personal","shared"].includes(areaFilter)||
      !["today","upcoming"].includes(window??"")||
      evaluationDate===null||temporalCalendarOrdinal(evaluationDate)===null)
      return answer(400,"Invalid request");
    const day=temporalCalendarOrdinal(evaluationDate) as number;
    const through=throughDate===null?null:temporalCalendarOrdinal(throughDate);
    if(window==="today"?throughDate!==null:
      through===null||through-day<1||through-day>90)
      return answer(400,"Invalid request");
    const rawLimit=params.get("limit");
    if(rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if(cursor!==null&&(cursor.length>4096||!cursorPattern.test(cursor)))
      return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-my-plan-day",120,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const filter=areaFilter as MyPlanTaskAreaFilter;
    const selected=window as MyPlanTaskDayWindow;
    const identityBinding=stagingCursorIdentity(
      identity,ownerUserId,authenticationBinding(request));
    const context={
      ...identityBinding,
      authenticationBinding:dayCursorBinding(identityBinding.authenticationBinding,
        filter,selected,evaluationDate,throughDate,limit),
      stagingDirectory,restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
    };
    const previous=cursor===null?null:verifyStagingProjectHttpCursor(context,cursor);
    if(previous?.ok===false)return answer(previous.reason==="expired"?409:400,
      previous.reason==="expired"?"Cursor expired":"Invalid cursor");
    const offset=previous?.ok===true?previous.offset:0;
    const page=await readStagingMyPlanDayInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },filter,selected,evaluationDate,throughDate,limit,offset);
    // Unlike a policy-only list guard, this checks every content and project
    // epoch in ONE live transaction, preventing post-snapshot reassignment
    // from releasing a stale/now-foreign shared task.
    const release=page?verifyStagingReadBeforeRelease(
      request,identity,store,ownerUserId,page.linearization,
      undefined,undefined,undefined,undefined,undefined,
      {areas:page.areaEpochs,scope:"my-plan"},undefined,
      {privateEpoch:page.privateEpoch}
    ):verifyStagingIdentityBeforeRelease(request,identity,store);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!enabled()||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return answer(503,"Staging unavailable");
    if(release==="stale")return answer(409,"read_stale_reload");
    if(!page){
      logStagingFailure("my_plan_day","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    if(previous?.ok===true&&previous.revision!==page.revision)
      return answer(409,"Cursor stale");
    const nextCursor=page.hasMore?signStagingProjectHttpCursor(
      context,page.revision,offset+page.tasks.length,
      previous?.ok===true?previous.expiresAt:undefined):null;
    if(page.hasMore&&!nextCursor)return answer(503,"Staging unavailable");
    // Strict typed DTO from bounded child, no private epoch, actor or witnesses.
    return Response.json({
      tasks:page.tasks,hasMore:page.hasMore,nextCursor,areaFilter:page.areaFilter,
      window:page.window,evaluationDate:page.evaluationDate,throughDate:page.throughDate,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/task-temporal/my-plan-day","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
