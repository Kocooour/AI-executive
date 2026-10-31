import { createHash } from "node:crypto";
import path from "node:path";
import { authenticationBinding } from "../../../../../../lib/auth";
import { enforceRateLimit } from "../../../../../../lib/http-security";
import { isReadableStagingProjectId } from "../../../../../../lib/target-project-id";
import { logStagingFailure } from "../../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, stagingCursorIdentity, admitStagingIdentity,
  stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
  verifyStagingReadBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import { readStagingAuthorizedProjectTasksInChild } from "../../../../../../lib/target-staging-read-process";
import {
  signStagingProjectHttpCursor, verifyStagingProjectHttpCursor,
} from "../../../../../../lib/target-staging-project-http-cursor";

// R2d.1a: opt-in staging read, never wired to the production UI.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

/** Cursor identity includes the authenticated actor AND the exact project.
 * A cursor for a different project (or the older private-project list) is invalid. */
function projectBinding(binding: string, projectId: string): string {
  return createHash("sha256").update("lumi:r2d:project-tasks-cursor:v1\0")
    .update(binding).update("\0").update(projectId).digest("base64url");
}

export async function GET(
  request: Request, context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true")
    return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !safeActor.test(ownerUserId))
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;
  try {
    const { projectId } = await context.params;
    if (!isReadableStagingProjectId(projectId)) return answer(400, "Invalid request");
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(k => k !== "limit" && k !== "cursor") ||
        params.getAll("limit").length > 1 || params.getAll("cursor").length > 1)
      return answer(400, "Invalid request");
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400, "Invalid request");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length > 4096 || !cursorPattern.test(cursor)))
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-project-tasks", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });

    const cursorIdentity = stagingCursorIdentity(identity, ownerUserId, authenticationBinding(request));
    const cursorContext = {
      ...cursorIdentity,
      authenticationBinding: projectBinding(cursorIdentity.authenticationBinding, projectId),
      stagingDirectory, restoreGeneration: expectedRestoreGeneration,
      sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET || "",
    };
    const previous = cursor === null ? null : verifyStagingProjectHttpCursor(cursorContext, cursor);
    if (previous?.ok === false) return answer(previous.reason === "expired" ? 409 : 400,
      previous.reason === "expired" ? "Cursor expired" : "Invalid cursor");
    const offset = previous?.ok === true ? previous.offset : 0;
    const result = await readStagingAuthorizedProjectTasksInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, projectId, limit, offset);
    const released = result?.ok === true
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId, result.page.linearization)
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    // Inaccessible, deleted or concurrently revoked projects are identical.
    if (released === "stale" || result?.ok === false) return answer(404, "Not found");
    if (!result) return answer(503, "Staging unavailable");
    const page = result.page;
    if (previous?.ok === true && previous.revision !== page.revision)
      return answer(409, "Cursor stale");
    const nextCursor = page.hasMore ? signStagingProjectHttpCursor(
      cursorContext, page.revision, offset + page.tasks.length,
      previous?.ok === true ? previous.expiresAt : undefined,
    ) : null;
    if (page.hasMore && !nextCursor) return answer(503, "Staging unavailable");
    return Response.json({
      project: page.project, tasks: page.tasks, hasMore: page.hasMore, nextCursor,
    }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/project-tasks", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
