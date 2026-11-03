/** Default-off, private actor-scoped Home inventory for canonical My Plan. */
import path from "node:path";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingReadBeforeRelease, verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { readStagingMyPlanHomeSummaryInChild } from
  "../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const enabled = () =>
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED === "true";
const answer = (status: number, error: string) =>
  Response.json({ error }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !UUID.test(expectedRestoreGeneration) ||
      !ownerUserId || !ACTOR.test(ownerUserId))
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;
  try {
    // No actor, Area, scope, workspace or counting selector is client-controlled.
    if ([...new URL(request.url).searchParams.keys()].length !== 0)
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-home-my-plan", 120, 600_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const summary = await readStagingMyPlanHomeSummaryInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity),
    });
    const release = summary ? verifyStagingReadBeforeRelease(
      request, identity, store, ownerUserId, summary.linearization,
      undefined, undefined, undefined, undefined, undefined,
      { areas: summary.areaEpochs },
    ) : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (release !== "ok" && release !== "stale")
      return stagingIdentityRefusal(release);
    if (!enabled() ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    if (release === "stale") return answer(409, "read_stale_reload");
    if (!summary) {
      logStagingFailure("my_plan_home_summary", "child_unavailable");
      return answer(503, "Staging unavailable");
    }
    // Titles, actor identities, Area IDs and guard/epoch metadata never escape.
    return Response.json({ counts: summary.counts,
      truncated: summary.truncated }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/home/my-plan", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
