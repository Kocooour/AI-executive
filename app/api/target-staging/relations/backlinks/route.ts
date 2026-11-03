/** R2d staging-only reverse structural links from task/note to parent project. */
import path from "node:path";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { validBacklinkId, type TargetBacklinkKind } from
  "../../../../../lib/target-parent-backlinks";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { readStagingParentBacklinkInChild } from
  "../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const enabled = () => process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED === "true";
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request, true);
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
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(k => k !== "kind" && k !== "id") ||
        params.getAll("kind").length !== 1 || params.getAll("id").length !== 1)
      return answer(400, "Invalid request");
    const kind = params.get("kind");
    const id = params.get("id");
    if ((kind !== "task" && kind !== "note") || !validBacklinkId(id))
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-parent-backlinks", 120, 600_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const result = await readStagingParentBacklinkInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity),
    }, kind as TargetBacklinkKind, id);
    const release = result?.ok === true
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId,
          result.result.linearization, undefined, undefined,
          result.result.noteGuard ?? undefined, undefined,
          result.result.taskGuard ?? undefined)
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (release !== "ok" && release !== "stale")
      return stagingIdentityRefusal(release);
    if (!enabled() ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    // Absent, inaccessible, revoked or reparented relations are indistinguishable.
    if (release === "stale" || result?.ok === false)
      return answer(404, "Not found");
    if (!result) return answer(503, "Staging unavailable");
    return Response.json({ relations: result.result.relations }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/parent-backlinks", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
