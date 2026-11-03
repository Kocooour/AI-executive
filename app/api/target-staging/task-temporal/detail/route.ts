/** R2d.3g isolated temporal detail; default-off, read only, no UI activation. */
import path from "node:path";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { readStagingTemporalDetailInChild } from "../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const answer = (status: number,error: string): Response =>
  Response.json({error},{status,headers});
const enabled = () =>
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED === "true";

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return answer(404,"Not found");
  const anchor = stagingAnchorRefusal(request,true);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actor.test(ownerUserId))
    return answer(503,"Staging unavailable");
  const store = {stagingDirectory,expectedRestoreGeneration};
  const admitted = admitStagingIdentity(request,identity,store);
  if (admitted) return admitted;

  try {
    const params = new URL(request.url).searchParams;
    // Query parameter instead of a dynamic path segment preserves existing
    // v20 TEXT task IDs, including empty, padded and Unicode identifiers.
    if ([...params.keys()].some(k => k !== "taskId") ||
        params.getAll("taskId").length !== 1)
      return answer(400,"Invalid request");
    const taskId = params.get("taskId");
    // NUL cannot be passed through process.argv; fail closed without affecting
    // the canonical DB or temporal list support for such legacy IDs.
    if (taskId === null || Buffer.byteLength(taskId,"utf8") > 4096 ||
        taskId.includes("\0") || !taskId.isWellFormed())
      return answer(400,"Invalid request");
    const limited = enforceRateLimit(request,"target-staging-temporal-detail",120,10*60_000);
    if (limited) return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const result = await readStagingTemporalDetailInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },taskId);
    // Both authentication and the exact task+parent revisions are checked
    // together on the LIVE store after the child's pinned read.
    const released = result?.ok === true
      ? verifyStagingReadBeforeRelease(request,identity,store,ownerUserId,
          result.detail.linearization,
          undefined,undefined,undefined,undefined,undefined,undefined,
          result.detail.guard)
      : verifyStagingIdentityBeforeRelease(request,identity,store);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    if (!enabled() ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503,"Staging unavailable");
    if (released === "stale" || result?.ok === false) return answer(404,"Not found");
    if (!result) {
      logStagingFailure("temporal_detail","child_unavailable");
      return answer(503,"Staging unavailable");
    }
    // Never release the actor, Area witness or task/parent revision guard.
    return Response.json({task:result.detail.task},{headers});
  } catch (error) {
    logStagingFailure("target-staging/task-temporal/detail","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
