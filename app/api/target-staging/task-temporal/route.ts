import { createHash } from "node:crypto";
import path from "node:path";
import { authenticationBinding } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { logStagingFailure } from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, stagingCursorIdentity, admitStagingIdentity,
  stagingIdentityRefusal, verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { readStagingTemporalPageInChild } from "../../../../lib/target-staging-read-process";
import { signStagingProjectHttpCursor, verifyStagingProjectHttpCursor }
  from "../../../../lib/target-staging-project-http-cursor";

// R2d.3f internal temporal list, independently opt-in and staging-only.
// No UI, Today/Upcoming, write command, or production database activation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

function enabled(): boolean {
  return process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED === "true";
}

/** A temporal cursor cannot be replayed as a project cursor or across filters. */
function temporalBinding(binding: string, scope: string, status: string): string {
  return createHash("sha256").update("lumi:r2d:temporal-http-cursor:v1\0")
    .update(JSON.stringify([binding, scope, status])).digest("base64url");
}

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
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actor.test(ownerUserId))
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;

  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(k => !["scope","status","limit","cursor"].includes(k)) ||
        ["scope","status","limit","cursor"].some(k => params.getAll(k).length > 1))
      return answer(400, "Invalid request");
    const scope = params.get("scope") ?? "personal";
    const status = params.get("status") ?? "all";
    if (scope !== "personal" && scope !== "shared" && scope !== "my-plan" ||
        status !== "all" && status !== "open" && status !== "completed")
      return answer(400, "Invalid request");
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400, "Invalid request");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length > 4096 || !cursorPattern.test(cursor)))
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-temporal-list", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const identityBinding = stagingCursorIdentity(
      identity, ownerUserId, authenticationBinding(request));
    const context = {
      ...identityBinding,
      authenticationBinding: temporalBinding(identityBinding.authenticationBinding, scope, status),
      stagingDirectory, restoreGeneration: expectedRestoreGeneration,
      sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET || "",
    };
    const previous = cursor === null ? null : verifyStagingProjectHttpCursor(context, cursor);
    if (previous?.ok === false) return answer(previous.reason === "expired" ? 409 : 400,
      previous.reason === "expired" ? "Cursor expired" : "Invalid cursor");
    const offset = previous?.ok === true ? previous.offset : 0;
    const page = await readStagingTemporalPageInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, scope, status, limit, offset);
    const release = page
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId, page.linearization)
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (release !== "ok" && release !== "stale") return stagingIdentityRefusal(release);
    if (!enabled() ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    if (release === "stale") return answer(409, "read_stale_reload");
    if (!page) {
      logStagingFailure("temporal_list", "child_page_unavailable");
      return answer(503, "Staging unavailable");
    }
    if (previous?.ok === true && previous.revision !== page.revision)
      return answer(409, "Cursor stale");
    const nextCursor = page.hasMore ? signStagingProjectHttpCursor(
      context, page.revision, offset + page.tasks.length,
      previous?.ok === true ? previous.expiresAt : undefined) : null;
    if (page.hasMore && !nextCursor) return answer(503, "Staging unavailable");
    // Never emit linearization (membership/role evidence) or raw child payload.
    return Response.json({ tasks: page.tasks, hasMore: page.hasMore, nextCursor }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/task-temporal", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
