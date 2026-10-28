import path from "node:path";
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { TargetStagingSessionAuthority } from "../../../../lib/target-staging-session-authority";

// Isolated, opt-in R2b probe. It never opens the legacy application store.
// The owner cookie is the only HTTP identity proof; internal staging tokens
// remain per-request and never leave this server route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actorId = /^[A-Za-z0-9_.:@-]{1,120}$/;

function answer(status: number, error: string): Response {
  return Response.json({ error }, { status, headers });
}

export function GET(request: Request): Response {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    return answer(404, "Not found");
  }
  // isAuthenticated alone accepts an insecure development bypass. This route
  // deliberately requires real, configured owner-cookie authentication.
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured || !auth.authenticated) {
    return answer(401, "Authentication required");
  }
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
    // No client-selected actor, Area, workspace, scope, cursor or session.
    if ([...params.keys()].some(key => key !== "limit") || params.getAll("limit").length > 1) {
      return answer(400, "Invalid request");
    }
    if (params.has("limit")) {
      const raw = params.get("limit") || "";
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) return answer(400, "Invalid request");
      limit = Number(raw);
    }
    const limited = enforceRateLimit(request, "target-staging-personal-list", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });

    const authority = new TargetStagingSessionAuthority({
      stagingDirectory, expectedRestoreGeneration,
    });
    try {
      const session = authority.issue(ownerUserId);
      if (!session) return answer(503, "Staging unavailable");
      const result = authority.list(session.sessionToken, { scope: "personal", limit });
      if (!result.ok) return answer(503, "Staging unavailable");
      // A cursor cannot survive the per-request authority key. Expose a
      // bounded first page honestly; never return an unusable cursor.
      return Response.json({ tasks: result.tasks, hasMore: result.nextCursor !== null }, { headers });
    } finally {
      authority.close();
    }
  } catch {
    return answer(503, "Staging unavailable");
  }
}
