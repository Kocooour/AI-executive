/** Staging-only, default-off, content-free session/Area proof for note sync.
 * Actor and restore generation are ALWAYS derived server-side. Never trust a
 * client-supplied actor, cursor, session identifier or restore generation. */
import path from "node:path";
import { enforceRateLimit } from "../../../../lib/http-security";
import { logStagingFailure } from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { readStagingNoteSyncInChild } from "../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && value.isWellFormed() &&
  Buffer.byteLength(value, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const enabled = () => process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED === "true";
const fail = (status: number, error: string) => Response.json({ error }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return fail(404, "Not found");
  const anchor = stagingAnchorRefusal(request, true);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const secret = process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actor.test(ownerUserId) || secret.length < 32)
    return fail(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "areaId") ||
        params.getAll("areaId").length !== 1) return fail(400, "Invalid request");
    const areaId = params.get("areaId");
    if (!validId(areaId)) return fail(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-note-sync-session", 120, 600_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    // Child verifies live actor/Area membership. Do not return child notes,
    // membership metadata, policy revisions, counts or credentials to caller.
    const result = await readStagingNoteSyncInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity),
      noteSyncSecret: secret,
    }, areaId, 1);
    const released = result?.ok
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId,
          result.page.linearization, undefined, undefined, undefined,
          { ...result.stamp, epoch: result.epoch })
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (released !== "ok" && released !== "stale")
      return stagingIdentityRefusal(released);
    if (!enabled() || process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId ||
        (process.env.AI_EXECUTIVE_SESSION_SECRET || "") !== secret)
      return fail(503, "Staging unavailable");
    if (!result) return fail(503, "Staging unavailable");
    if (result.ok === false) {
      return result.reason === "inaccessible"
        ? fail(404, "Not found") : fail(503, "Staging unavailable");
    }
    if (released === "stale") return Response.json({ code: "read_stale_reload" },
      { status: 409, headers });
    const derivedUserId = result.page.linearization.actorUserId;
    if (!actor.test(derivedUserId)) return fail(503, "Staging unavailable");
    return Response.json({ version: 1, scope: {
      userId: derivedUserId,
      restoreGeneration: expectedRestoreGeneration.toLowerCase(),
      areaId,
    } }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/note-sync-session", "route_exception", error);
    return fail(503, "Staging unavailable");
  }
}
