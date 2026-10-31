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
import { readStagingAuthorizedProjectIndexInChild } from "../../../../lib/target-staging-read-process";
import { signStagingProjectHttpCursor, verifyStagingProjectHttpCursor }
  from "../../../../lib/target-staging-project-http-cursor";

// Staging-only R2d.1b, disabled by default; no production UI activation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

/** Reuse the hardened cursor primitive with a separate project-list/scope binding. */
function indexBinding(binding: string, scope: "personal" | "shared"): string {
  return createHash("sha256").update("lumi:r2d:project-index-cursor:v1\0")
    .update(binding).update("\0").update(scope).digest("base64url");
}

export async function GET(request: Request): Promise<Response> {
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
      !ownerUserId || !actor.test(ownerUserId))
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(k => k !== "limit" && k !== "cursor" && k !== "scope") ||
        params.getAll("limit").length > 1 || params.getAll("cursor").length > 1 ||
        params.getAll("scope").length > 1) return answer(400, "Invalid request");
    const scope = params.get("scope") ?? "personal";
    if (scope !== "personal" && scope !== "shared") return answer(400, "Invalid request");
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400, "Invalid request");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length > 4096 || !cursorPattern.test(cursor)))
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-project-index", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });

    const cursorIdentity = stagingCursorIdentity(identity, ownerUserId, authenticationBinding(request));
    const context = {
      ...cursorIdentity,
      authenticationBinding: indexBinding(cursorIdentity.authenticationBinding, scope),
      stagingDirectory, restoreGeneration: expectedRestoreGeneration,
      sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET || "",
    };
    const previous = cursor === null ? null : verifyStagingProjectHttpCursor(context, cursor);
    if (previous?.ok === false) return answer(previous.reason === "expired" ? 409 : 400,
      previous.reason === "expired" ? "Cursor expired" : "Invalid cursor");
    const offset = previous?.ok === true ? previous.offset : 0;
    const page = await readStagingAuthorizedProjectIndexInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, scope, limit, offset);
    const release = page
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId,
        page.linearization, undefined, { projects: page.guardProjects })
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (release !== "ok" && release !== "stale") return stagingIdentityRefusal(release);
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    if (release === "stale") return answer(409, "read_stale_reload");
    if (!page) {
      logStagingFailure("project_index", "child_page_unavailable");
      return answer(503, "Staging unavailable");
    }
    if (previous?.ok === true && previous.revision !== page.revision)
      return answer(409, "Cursor stale");
    const nextCursor = page.hasMore ? signStagingProjectHttpCursor(
      context, page.revision, offset + page.projects.length,
      previous?.ok === true ? previous.expiresAt : undefined) : null;
    if (page.hasMore && !nextCursor) return answer(503, "Staging unavailable");
    // The live ACL evidence and lookahead are internal only.
    return Response.json({ projects: page.projects, hasMore: page.hasMore, nextCursor }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/project-index", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
