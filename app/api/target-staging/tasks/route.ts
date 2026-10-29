import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingChildSessionConfig, stagingCursorIdentity,
  stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { authenticationBinding } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { readStagingPersonalPageInChild } from "../../../../lib/target-staging-read-process";
import {
  signStagingHttpCursor, verifyStagingHttpCursor,
} from "../../../../lib/target-staging-http-cursor";

// Isolated, opt-in R2b probe. It never opens the legacy application store.
// The owner cookie is the only HTTP identity proof. A bounded child process
// performs the synchronous staging preflight/read away from the Next event loop.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actorId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function answer(status: number, error: string): Response {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    return answer(404, "Not found");
  }
  // isAuthenticated alone accepts an insecure development bypass. This route
  // deliberately requires real, configured owner-cookie authentication.
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return answer(401, "Authentication required");
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actorId.test(ownerUserId)) {
    return answer(503, "Staging unavailable");
  }

  let limit = 50;
  try {
    const params = new URL(request.url).searchParams;
    // Only a signed, cookie-bound snapshot position may be supplied.
    // Actor, Area, workspace and scope remain server-controlled.
    if ([...params.keys()].some(key => key !== "limit" && key !== "cursor") ||
        params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) {
      return answer(400, "Invalid request");
    }
    if (params.has("limit")) {
      const raw = params.get("limit") || "";
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) return answer(400, "Invalid request");
      limit = Number(raw);
    }
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length > 4096 || !cursorPattern.test(cursor))) {
      return answer(400, "Invalid request");
    }
    const limited = enforceRateLimit(request, "target-staging-personal-list", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });

    const context = {
      ...stagingCursorIdentity(identity, ownerUserId, authenticationBinding(request)),
      restoreGeneration: expectedRestoreGeneration, stagingDirectory,
      sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET || "",
    };
    const previous = cursor === null ? null : verifyStagingHttpCursor(context, cursor);
    if (previous?.ok === false) {
      return answer(previous.reason === "expired" ? 409 : 400,
        previous.reason === "expired" ? "Cursor expired" : "Invalid cursor");
    }
    const offset = previous?.ok === true ? previous.offset : 0;
    const page = await readStagingPersonalPageInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, limit, offset);
    // The child can run for up to 20 seconds. Do not release its result if
    // the owner cookie, feature gate or trusted store binding changed meanwhile.
    // Linearization point (R2-ID.1): after the child read, immediately before the
    // body is released, a durable session is re-verified against the LIVE store.
    const released = verifyStagingIdentityBeforeRelease(
      request, identity, { stagingDirectory, expectedRestoreGeneration });
    if (released !== "ok") return stagingIdentityRefusal(released);
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId) {
      return answer(503, "Staging unavailable");
    }
    if (!page) return answer(503, "Staging unavailable");
    if (previous?.ok === true && previous.revision !== page.revision) {
      return answer(409, "Cursor stale");
    }
    const nextCursor = page.hasMore ? signStagingHttpCursor(
      context, page.revision, offset + page.tasks.length,
      previous?.ok === true ? previous.expiresAt : undefined,
    ) : null;
    if (page.hasMore && !nextCursor) return answer(503, "Staging unavailable");
    return Response.json({ tasks: page.tasks, hasMore: page.hasMore, nextCursor }, { headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}

