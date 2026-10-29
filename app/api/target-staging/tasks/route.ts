import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingChildSessionConfig, stagingCursorIdentity,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
  verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { authenticationBinding } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import {
  readStagingPersonalPageInChild, readStagingScopedPageInChild,
} from "../../../../lib/target-staging-read-process";
import {
  signStagingHttpCursor, verifyStagingHttpCursor,
} from "../../../../lib/target-staging-http-cursor";
import type { StagingHttpCursorContext } from "../../../../lib/target-staging-http-cursor";

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

/**
 * R2-ID.2b shared / my-plan listing. Same admission, limiter, cursor and env
 * re-check discipline as the personal path, plus the read linearization point:
 * immediately before release the contributing Areas observed by the child are
 * re-verified on the LIVE store in one transaction. A moved membership / role /
 * policy_revision yields 409 `read_stale_reload` (distinct from "Cursor stale").
 */
async function scopedList(input: {
  request: Request;
  identity: NonNullable<ReturnType<typeof resolveStagingHttpIdentity>>;
  requestedScope: "shared" | "my-plan";
  context: StagingHttpCursorContext;
  previous: ReturnType<typeof verifyStagingHttpCursor> | null;
  limit: number; offset: number;
  stagingDirectory: string; expectedRestoreGeneration: string; ownerUserId: string;
}): Promise<Response> {
  const { request, identity, requestedScope, context, previous, limit, offset,
    stagingDirectory, expectedRestoreGeneration, ownerUserId } = input;
  const page = await readStagingScopedPageInChild({
    stagingDirectory, expectedRestoreGeneration, ownerUserId,
    ...stagingChildSessionConfig(identity),
  }, requestedScope, limit, offset);
  const store = { stagingDirectory, expectedRestoreGeneration };
  // No snapshot (child refused, e.g. a revoked session): identity check only.
  const released = page
    ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId, page.linearization)
    : verifyStagingIdentityBeforeRelease(request, identity, store);
  if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
  // Config / feature gate first: a disabled gate or rebound store is always 503, never 409.
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId) {
    return answer(503, "Staging unavailable");
  }
  if (released === "stale") return answer(409, "read_stale_reload");
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
  // Live session check BEFORE the per-route limiter and any child dispatch: a
  // forged or revoked cookie gets 401 without spawning a worker. Sessions are
  // throttled by their own bucket first (see admitStagingIdentity).
  const refused = admitStagingIdentity(request, identity, { stagingDirectory, expectedRestoreGeneration });
  if (refused) return refused;

  let limit = 50;
  try {
    const params = new URL(request.url).searchParams;
    // Only a signed, cookie-bound snapshot position may be supplied.
    // Actor, Area, workspace and scope remain server-controlled.
    // `scope` (R2-ID.2b) only selects WHICH of the authenticated actor's own
    // read views is listed; it never selects an identity, Area or workspace.
    if ([...params.keys()].some(key => key !== "limit" && key !== "cursor" && key !== "scope") ||
        params.getAll("limit").length > 1 || params.getAll("cursor").length > 1 ||
        params.getAll("scope").length > 1) {
      return answer(400, "Invalid request");
    }
    const scopeParam = params.has("scope") ? params.get("scope") : "personal";
    if (scopeParam !== "personal" && scopeParam !== "shared" && scopeParam !== "my-plan") {
      return answer(400, "Invalid request");
    }
    const requestedScope: "personal" | "shared" | "my-plan" = scopeParam;
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
      ...(requestedScope === "personal" ? {} : { scope: requestedScope }),
    };
    const previous = cursor === null ? null : verifyStagingHttpCursor(context, cursor);
    if (previous?.ok === false) {
      return answer(previous.reason === "expired" ? 409 : 400,
        previous.reason === "expired" ? "Cursor expired" : "Invalid cursor");
    }
    const offset = previous?.ok === true ? previous.offset : 0;
    if (requestedScope !== "personal") {
      return await scopedList({
        request, identity, requestedScope, context, previous, limit, offset,
        stagingDirectory, expectedRestoreGeneration, ownerUserId,
      });
    }
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

