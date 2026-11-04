/** R2d.3j.2 isolated, independently default-off HTTP read of dueOn-only windows. */
import { createHash } from "node:crypto";
import path from "node:path";
import { authenticationBinding } from "../../../../../lib/auth";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,stagingCursorIdentity,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { temporalCalendarOrdinal } from "../../../../../lib/target-task-temporal-read-model";
import { readStagingTemporalDueWindowInChild } from "../../../../../lib/target-staging-read-process";
import { signStagingProjectHttpCursor,verifyStagingProjectHttpCursor }
  from "../../../../../lib/target-staging-project-http-cursor";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer=(status:number,error:string):Response=>
  Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED==="true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED==="true";

/** Cursor is bound to this route, actor/session, window, BOTH dates and limit. */
function dueWindowBinding(
  binding:string,scope:string,window:string,evaluationDate:string,
  throughDate:string|null,limit:number,
):string {
  return createHash("sha256").update("lumi:r2d:due-window-http-cursor:v1\0")
    .update(JSON.stringify([binding,scope,window,evaluationDate,throughDate,limit]))
    .digest("base64url");
}

export async function GET(request:Request):Promise<Response> {
  if (!enabled()) return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if (anchor) return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actor.test(ownerUserId))
    return answer(503,"Staging unavailable");
  const store={stagingDirectory,expectedRestoreGeneration};
  const refused=admitStagingIdentity(request,identity,store);
  if (refused) return refused;

  try {
    const params=new URL(request.url).searchParams;
    const keys=["scope","window","evaluationDate","throughDate","limit","cursor"];
    if ([...params.keys()].some(k=>!keys.includes(k)) ||
        keys.some(k=>params.getAll(k).length>1))
      return answer(400,"Invalid request");
    const scope=params.get("scope")??"my-plan";
    const window=params.get("window");
    const evaluationDate=params.get("evaluationDate");
    const throughDate=params.get("throughDate");
    if (!["personal","shared","my-plan"].includes(scope) ||
        !["overdue","due-today","upcoming"].includes(window??"") ||
        evaluationDate===null || temporalCalendarOrdinal(evaluationDate)===null)
      return answer(400,"Invalid request");
    const todayOrdinal=temporalCalendarOrdinal(evaluationDate) as number;
    const throughOrdinal=throughDate===null?null:temporalCalendarOrdinal(throughDate);
    if (window==="upcoming"
        ? throughOrdinal===null || throughOrdinal-todayOrdinal<1 ||
          throughOrdinal-todayOrdinal>90
        : throughDate!==null)
      return answer(400,"Invalid request");
    const rawLimit=params.get("limit");
    if (rawLimit!==null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if (cursor!==null && (cursor.length>4096 || !cursorPattern.test(cursor)))
      return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-temporal-due-window",120,600000);
    if (limited) return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const identityBinding=stagingCursorIdentity(
      identity,ownerUserId,authenticationBinding(request));
    const context={
      ...identityBinding,
      authenticationBinding:dueWindowBinding(identityBinding.authenticationBinding,
        scope,window as string,evaluationDate,throughDate,limit),
      stagingDirectory,restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
    };
    const previous=cursor===null?null:verifyStagingProjectHttpCursor(context,cursor);
    if (previous?.ok===false) return answer(previous.reason==="expired"?409:400,
      previous.reason==="expired"?"Cursor expired":"Invalid cursor");
    const offset=previous?.ok===true?previous.offset:0;
    const page=await readStagingTemporalDueWindowInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },scope as "personal"|"shared"|"my-plan",
      window as "overdue"|"due-today"|"upcoming",
      evaluationDate,throughDate,limit,offset);
    const release=page
      ? verifyStagingReadBeforeRelease(request,identity,store,ownerUserId,page.linearization)
      : verifyStagingIdentityBeforeRelease(request,identity,store);
    if (release!=="ok" && release!=="stale")
      return stagingIdentityRefusal(release);
    if (!enabled() ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return answer(503,"Staging unavailable");
    if (release==="stale") return answer(409,"read_stale_reload");
    if (!page) {
      logStagingFailure("temporal_due_window","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    if (previous?.ok===true && previous.revision!==page.revision)
      return answer(409,"Cursor stale");
    const nextCursor=page.hasMore?signStagingProjectHttpCursor(
      context,page.revision,offset+page.tasks.length,
      previous?.ok===true?previous.expiresAt:undefined):null;
    if (page.hasMore && !nextCursor)
      return answer(503,"Staging unavailable");
    // Do not forward actor, role/Area witnesses, snapshot revisions or raw child data.
    return Response.json({
      tasks:page.tasks,hasMore:page.hasMore,nextCursor,
      window:page.window,evaluationDate:page.evaluationDate,throughDate:page.throughDate,
    },{headers});
  } catch(error) {
    logStagingFailure("target-staging/task-temporal/due-window","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
