/** R2d.3i.2: staging-only CAS preview + atomic dueOn set/clear. */
import {
  HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin,
} from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  temporalDueOnEnabled,temporalDueOnConfig,temporalDueOnUnchanged,
  temporalDueOnAnswer,temporalDueOnTaskId,temporalDueOnCommand,
  temporalDueOnWriterCanRead,verifyTemporalDueOnTaskLive,
} from "../../../../../lib/target-staging-temporal-due-on-http";
import {readStagingTemporalDetailInChild} from "../../../../../lib/target-staging-read-process";
import {previewPrivateTaskTitleInChild} from "../../../../../lib/target-staging-title-http-process";
import {writeTemporalDueOnInChild} from "../../../../../lib/target-staging-temporal-due-on-http-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
  writeAreaMismatchResponse,
} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=temporalDueOnAnswer;

/** Read-only CAS preflight for the exact task, including its effective Area. */
export async function GET(request:Request):Promise<Response> {
  if (!temporalDueOnEnabled()) return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if (anchor) return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base=temporalDueOnConfig();
  if (!base) return refuse(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if (admitted) return admitted;
  try {
    const query=new URL(request.url).searchParams;
    if ([...query.keys()].some(k=>k!=="taskId") ||
        query.getAll("taskId").length!==1 ||
        !temporalDueOnTaskId(query.get("taskId")))
      return refuse(400,"Invalid request");
    const taskId=query.get("taskId") as string;
    const limited=enforceRateLimit(request,"target-staging-temporal-due-on-preview",60,600000);
    if (limited) return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const child={...base,...stagingChildSessionConfig(identity)};
    const detail=await readStagingTemporalDetailInChild(child,taskId);
    // The preview independently confirms the same actor's current write ACL.
    const preview=detail?.ok===true && temporalDueOnWriterCanRead(detail.detail)
      ? await previewPrivateTaskTitleInChild(child,taskId):null;
    const released=detail?.ok===true
      ? verifyTemporalDueOnTaskLive(request,identity,base,detail.detail)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if (released!=="ok" && released!=="stale") return stagingIdentityRefusal(released);
    if (!temporalDueOnUnchanged(base)) return refuse(503,"Staging unavailable");
    if (released==="stale"||detail?.ok===false||
        (detail?.ok===true && !temporalDueOnWriterCanRead(detail.detail)))
      return refuse(404,"Not found");
    if (!detail) return refuse(503,"Staging unavailable");
    if (!preview) return refuse(503,"Staging unavailable");
    if (preview.ok===false) return refuse(404,"Not found");
    return Response.json({
      expectedRevision:preview.snapshotRevision,
      dueOn:detail.detail.task.dueOn,
      writeAreaId:detail.detail.task.areaId,
      restoreGeneration:base.expectedRestoreGeneration,
    },{headers});
  } catch(error) {
    logStagingFailure("target-staging/task-temporal/status-preview","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}

/** CSRF-safe, exact six-field, actor-bound staging mutation. */
export async function PATCH(request:Request):Promise<Response> {
  if (!temporalDueOnEnabled()) return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if (anchor) return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base=temporalDueOnConfig();
  if (!base) return refuse(503,"Staging unavailable");
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin")!==new URL(request.url).origin)
      return refuse(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,base);
    if (admitted) return admitted;
    if (new URL(request.url).search!=="") return refuse(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);
    if (protocol) return protocol;
    const limited=enforceRateLimit(request,"target-staging-temporal-due-on-write",30,600000);
    if (limited) return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const body=await readJsonBody<unknown>(request,32*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if (legacy) return legacy;
    const command=temporalDueOnCommand(body);
    if (!command) return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if (before!=="ok") return stagingIdentityRefusal(before);
    if (!temporalDueOnUnchanged(base)) return refuse(503,"Staging unavailable");
    const result=await writeTemporalDueOnInChild({
      ...base,...stagingChildSessionConfig(identity),
    },command);
    // The child checks durable-session validity under BEGIN IMMEDIATE.
    // A successful commit must not be turned into an apparent 401.
    if (identity.kind==="owner") {
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if (after!=="ok") return stagingIdentityRefusal(after);
    }
    if (result?.ok===false && result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,base);
    if (!result && identity.kind==="session") {
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if (after!=="ok") return stagingIdentityRefusal(after);
    }
    if (!temporalDueOnUnchanged(base)||!result) return refuse(503,"Staging unavailable");
    if (result.ok===false) {
      if (result.reason==="unavailable") return refuse(404,"Not found");
      if (result.reason==="resync_required") return resyncRequiredResponse();
      if (result.reason==="write_area_mismatch") return writeAreaMismatchResponse();
      if (["stale_revision","idempotency_conflict","unchanged"].includes(result.reason))
        return refuse(409,"Revision conflict");
      return refuse(503,"Staging unavailable");
    }
    return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
  } catch(error) {
    if (error instanceof HttpInputError) return refuse(error.status,error.message);
    logStagingFailure("target-staging/task-temporal/status-write","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
