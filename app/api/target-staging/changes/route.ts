import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingUnauthenticatedRefusal, stagingChildSessionConfig, admitStagingIdentity,
  stagingIdentityRefusal, verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { enforceRateLimit } from "../../../../lib/http-security";
import { readStagingFeedPageInChild } from "../../../../lib/target-staging-read-process";
import {
  MAX_FEED_CURSOR_LENGTH, openStagingFeedCursor, sealStagingFeedCursor,
} from "../../../../lib/target-staging-feed-cursor";
import type { FeedClaims, FeedPosition } from "../../../../lib/target-staging-feed-cursor";

// R2c.2a staging-only bootstrap + authorized change feed (mechanism proposed for owner
// approval, see docs/ARCHITECTURE.md). Same admission, identity, limiter, isolated read
// child, no-store and live linearization discipline as the list reads. The encrypted
// cursor is bound to the identity (not to a session), its revocation epoch and the
// restore generation; it never authenticates a request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actorId = /^[A-Za-z0-9_.:@-]{1,120}$/;

const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });
/** Stable machine-readable refusals of this endpoint (R2c.2b adds the 401 codes). */
const code = (status: number, value: "cursor_invalid" | "resync_required" | "read_stale_reload"): Response =>
  Response.json({ code: value }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") return answer(404, "Not found");
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const secret = process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actorId.test(ownerUserId)) {
    return answer(503, "Staging unavailable");
  }
  const store = { stagingDirectory, expectedRestoreGeneration };
  // Live session check BEFORE the limiter and any child dispatch (see admitStagingIdentity).
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;

  try {
    const params = new URL(request.url).searchParams;
    // Only the opaque cursor may be supplied; actor, Area and position stay server-controlled.
    if ([...params.keys()].some(key => key !== "cursor") || params.getAll("cursor").length > 1) {
      return answer(400, "Invalid request");
    }
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length === 0 || cursor.length > MAX_FEED_CURSOR_LENGTH)) {
      return answer(400, "Invalid request");
    }
    const limited = enforceRateLimit(request, "target-staging-changes", 300, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });

    let claims: FeedClaims | null = null;
    if (cursor !== null) {
      const opened = openStagingFeedCursor(secret, cursor);
      if (!opened.ok) return code(400, "cursor_invalid");
      claims = opened.claims;
    }
    const result = await readStagingFeedPageInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, claims);

    // Linearization point: after the child read, immediately before release, the session
    // is re-verified on the LIVE store (401 first) and every Area which contributed data
    // must still grant the actor the observed access at the observed policy_revision.
    const released = result && result.ok
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId, result.linearization)
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    // Config / feature gate first: a disabled gate or rebound store is always 503, never 409.
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId ||
        (process.env.AI_EXECUTIVE_SESSION_SECRET || "") !== secret) {
      return answer(503, "Staging unavailable");
    }
    if (!result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      if (result.reason === "cursor_invalid") return code(400, "cursor_invalid");
      if (result.reason === "resync_required") return code(409, "resync_required");
      return answer(503, "Staging unavailable");
    }
    if (released === "stale") return code(409, "read_stale_reload");

    const seal = (pos: FeedPosition): string | null => sealStagingFeedCursor(secret, {
      uid: result.actorUserId, epoch: result.epoch, gen: expectedRestoreGeneration, pos,
    });
    const items = [];
    for (const item of result.items) {
      if (item.type !== "access_granted") { items.push(item); continue; }
      // Grant notice: an Area-bootstrap cursor from the grant sequence (same AEAD).
      const areaCursor = seal({ ph: "a", a: item.areaId, w: item.grantSeq, k: null });
      if (!areaCursor) return answer(503, "Staging unavailable");
      items.push({ type: "access_granted", areaId: item.areaId, role: item.role, areaCursor });
    }
    const next = result.next ? seal(result.next) : null;
    if (result.next && !next) return answer(503, "Staging unavailable");
    return Response.json(result.phase === "area_bootstrap"
      ? { phase: result.phase, items, done: result.done, cursor: next }
      : { phase: result.phase, items, more: result.more, cursor: next }, { headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}
