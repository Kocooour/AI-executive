/** R3-slice/BE-01: default-off, single-identity My Plan today + tomorrow task read. */
import {createHash} from "node:crypto";
import path from "node:path";
import {authenticationBinding} from "../../../../lib/auth";
import {enforceRateLimit} from "../../../../lib/http-security";
import {logStagingFailure} from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,stagingCursorIdentity,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import {temporalCalendarOrdinal} from "../../../../lib/target-task-temporal-read-model";
import {readStagingMyPlanDayInChild} from "../../../../lib/target-staging-read-process";
import {
  signMyPlanSliceCursor,verifyMyPlanSliceCursor,
} from "../../../../lib/target-staging-my-plan-slice-cursor";
import type {MyPlanTaskAreaFilter,MyPlanDayTaskPage}
  from "../../../../lib/target-my-plan-day-task-read-model";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer=(status:number,error:string):Response=>Response.json({error},{status,headers});
const enabled=()=>[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
].every(name=>process.env[name]==="true");

/** Use the caller's explicitly supplied local calendar date; never the server TZ. */
function followingDay(date:string):string|null{
  if(temporalCalendarOrdinal(date)===null)return null;
  const next=new Date(date+"T00:00:00.000Z");
  next.setUTCDate(next.getUTCDate()+1);
  const result=next.toISOString().slice(0,10);
  return temporalCalendarOrdinal(result)===null?null:result;
}
/** Two bounded reads are accepted only from the same complete Area/private epoch. */
function sameSnapshot(today:MyPlanDayTaskPage,tomorrow:MyPlanDayTaskPage):boolean{
  return today.privateEpoch===tomorrow.privateEpoch&&
    JSON.stringify(today.linearization)===JSON.stringify(tomorrow.linearization)&&
    JSON.stringify(today.areaEpochs)===JSON.stringify(tomorrow.areaEpochs);
}
function combinedRevision(today:MyPlanDayTaskPage,tomorrow:MyPlanDayTaskPage):string{
  return createHash("sha256").update("lumi:r3:my-plan-slice-revision:v1\0")
    .update(JSON.stringify([today.revision,tomorrow.revision])).digest("hex");
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
  try{
    const params=new URL(request.url).searchParams;
    const allowed=["evaluationDate","areaFilter","limit","cursor"];
    if([...params.keys()].some(k=>!allowed.includes(k))||
      allowed.some(k=>params.getAll(k).length>1))return answer(400,"Invalid request");
    const evaluationDate=params.get("evaluationDate");
    const next=evaluationDate===null?null:followingDay(evaluationDate);
    const areaFilter=params.get("areaFilter")??"all";
    const rawLimit=params.get("limit");
    if(!next||!["all","personal","shared"].includes(areaFilter)||
      (rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)))
      return answer(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const token=params.get("cursor");
    if(token!==null&&(token.length>4096||!cursorPattern.test(token)))
      return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-my-plan-slice",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const filter=areaFilter as MyPlanTaskAreaFilter;
    const cursorIdentity=stagingCursorIdentity(identity,ownerUserId,authenticationBinding(request));
    const context={
      ...cursorIdentity,stagingDirectory,restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
      evaluationDate,areaFilter:filter,limit,
    };
    const prior=token===null?null:verifyMyPlanSliceCursor(context,token);
    if(prior?.ok===false)return answer(prior.reason==="expired"?409:400,
      prior.reason==="expired"?"Cursor expired":"Invalid cursor");
    const offsets=prior?.ok===true?prior.positions:{today:0,tomorrow:0};
    const child={stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity)};
    // Every read has the same actor, filter and calendar anchor. Their complete
    // epoch witnesses must agree; otherwise no cross-snapshot composition.
    const today=await readStagingMyPlanDayInChild(child,filter,"today",
      evaluationDate,null,limit,offsets.today);
    const tomorrow=await readStagingMyPlanDayInChild(child,filter,"upcoming",
      evaluationDate,next,limit,offsets.tomorrow);
    const release=today&&tomorrow&&sameSnapshot(today,tomorrow)
      ?verifyStagingReadBeforeRelease(
        request,identity,store,ownerUserId,today.linearization,
        undefined,undefined,undefined,undefined,undefined,
        {areas:today.areaEpochs,scope:"my-plan"},undefined,
        {privateEpoch:today.privateEpoch}
      ):verifyStagingIdentityBeforeRelease(request,identity,store);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!enabled()||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return answer(503,"Staging unavailable");
    if(release==="stale")return answer(409,"read_stale_reload");
    if(!today||!tomorrow){
      logStagingFailure("my_plan_slice","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    if(!sameSnapshot(today,tomorrow))return answer(409,"read_stale_reload");
    const revision=combinedRevision(today,tomorrow);
    if(prior?.ok===true&&prior.revision!==revision)
      return answer(409,"Cursor stale");
    const hasMore=today.hasMore||tomorrow.hasMore;
    const nextCursor=hasMore?signMyPlanSliceCursor(context,revision,{
      today:offsets.today+today.tasks.length,
      tomorrow:offsets.tomorrow+tomorrow.tasks.length,
    },prior?.ok===true?prior.expiresAt:undefined):null;
    if(hasMore&&!nextCursor)return answer(503,"Staging unavailable");
    return Response.json({
      evaluationDate,areaFilter:filter,
      today:{tasks:today.tasks,hasMore:today.hasMore},
      tomorrow:{tasks:tomorrow.tasks,hasMore:tomorrow.hasMore},
      hasMore,nextCursor,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/my-plan/slice","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
