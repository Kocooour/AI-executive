/** R2d.3i.2: read-only confirmation of an uncertain dueOn set/clear. */
import {
  HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin,
} from "../../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import {
  temporalDueOnEnabled,temporalDueOnConfig,temporalDueOnUnchanged,
  temporalDueOnAnswer,temporalDueOnCommand,temporalDueOnWriterCanRead,
  verifyTemporalDueOnTaskLive,
} from "../../../../../../lib/target-staging-temporal-due-on-http";
import {readStagingTemporalDetailInChild} from "../../../../../../lib/target-staging-read-process";
import {readTemporalDueOnReceiptInChild} from "../../../../../../lib/target-staging-temporal-due-on-http-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
  writeAreaMismatchResponse,
} from "../../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=temporalDueOnAnswer;

export async function POST(request:Request):Promise<Response> {
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
    const limited=enforceRateLimit(request,"target-staging-temporal-due-on-receipt",60,600000);
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

    const child={...base,...stagingChildSessionConfig(identity)};
    const detail=await readStagingTemporalDetailInChild(child,command.taskId);
    if (!temporalDueOnUnchanged(base)) return refuse(503,"Staging unavailable");
    const result=detail?.ok===true && temporalDueOnWriterCanRead(detail.detail)
      ? await readTemporalDueOnReceiptInChild(child,command):null;
    // The receipt lookup itself rechecks current write ACL on the pinned
    // snapshot. Release also rechecks exact live task/parent/Area+session.
    const released=detail?.ok===true
      ? verifyTemporalDueOnTaskLive(request,identity,base,detail.detail)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if (released!=="ok"&&released!=="stale") return stagingIdentityRefusal(released);
    if (!temporalDueOnUnchanged(base)) return refuse(503,"Staging unavailable");
    if (released==="stale"||detail?.ok===false||
        (detail?.ok===true && !temporalDueOnWriterCanRead(detail.detail)))
      return refuse(404,"Not found");
    if (!detail||!result) return refuse(503,"Staging unavailable");
    if (result.ok===false) {
      if (result.reason==="unavailable") return refuse(404,"Not found");
      if (result.reason==="resync_required") return resyncRequiredResponse();
      if (result.reason==="write_area_mismatch") return writeAreaMismatchResponse();
      return refuse(409,"Revision conflict");
    }
    return Response.json({status:result.status},{headers});
  } catch(error) {
    if (error instanceof HttpInputError) return refuse(error.status,error.message);
    logStagingFailure("target-staging/task-temporal/status-receipt","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
