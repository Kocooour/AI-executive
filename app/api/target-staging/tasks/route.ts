import path from "node:path";
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { TargetStagingSessionAuthority } from "../../../../lib/target-staging-session-authority";

// Isolated, opt-in R2b probe. It never opens the legacy application store.
// The owner cookie is the only HTTP identity proof; internal staging tokens
// remain in this process and never leave the server route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actorId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const sessionLifetimeSeconds = 15 * 60;

type ActiveRead = {
  stagingDirectory: string;
  restoreGeneration: string;
  ownerUserId: string;
  authority: TargetStagingSessionAuthority;
  token: string;
  expiresAt: number;
};

// Staging-only, process-local. A cursor expires after 15 minutes, process
// restart, or configuration change; no cross-process session sharing is implied.
let activeRead: ActiveRead | null = null;

function clearActiveRead(): void {
  activeRead?.authority.close();
  activeRead = null;
}

function answer(status: number, error: string): Response {
  return Response.json({ error }, { status, headers });
}

export function GET(request: Request): Response {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    clearActiveRead();
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
    clearActiveRead();
    return answer(503, "Staging unavailable");
  }

  let limit = 50;
  try {
    const params = new URL(request.url).searchParams;
    // Cursor is opaque and signed for this process-local session and snapshot.
    // Actor, Area, workspace, scope and session remain server-controlled.
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

    if (activeRead && (activeRead.stagingDirectory !== stagingDirectory ||
        activeRead.restoreGeneration !== expectedRestoreGeneration ||
        activeRead.ownerUserId !== ownerUserId ||
        activeRead.expiresAt <= Math.floor(Date.now() / 1000))) {
      clearActiveRead();
    }
    if (!activeRead) {
      // Never reinterpret an old cursor under a newly issued session.
      if (cursor !== null) return answer(409, "Cursor expired");
      const authority = new TargetStagingSessionAuthority({
        stagingDirectory, expectedRestoreGeneration,
      });
      const first = authority.issuePersonalFirstPage(ownerUserId, limit, sessionLifetimeSeconds);
      if (!first) {
        authority.close();
        return answer(503, "Staging unavailable");
      }
      activeRead = { stagingDirectory, restoreGeneration: expectedRestoreGeneration,
        ownerUserId, authority, token: first.sessionToken, expiresAt: first.expiresAt };
      return Response.json({ tasks: first.tasks, hasMore: first.nextCursor !== null,
        nextCursor: first.nextCursor }, { headers });
    }

    const result = activeRead.authority.list(activeRead.token,
      { scope: "personal", limit, cursor });
    if (!result.ok) {
      if (result.reason === "invalid_request") return answer(400, "Invalid cursor");
      if (result.reason === "stale_cursor") return answer(409, "Cursor stale");
      return answer(503, "Staging unavailable");
    }
    return Response.json({ tasks: result.tasks, hasMore: result.nextCursor !== null,
      nextCursor: result.nextCursor }, { headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}

