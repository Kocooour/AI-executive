/** R2d.2c.2c: opt-in staging note detail. No production UI or sync activation. */
import path from "node:path";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingNoteBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { readStagingAuthorizedNoteInChild } from "../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validNoteId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && Buffer.byteLength(value, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

export async function GET(
  request: Request, context: { params: Promise<{ noteId: string }> },
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
    const { noteId } = await context.params;
    if (!validNoteId(noteId) || new URL(request.url).search !== "")
      return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-note-detail", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const result = await readStagingAuthorizedNoteInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, noteId);
    // Exact note + parent revisions, actor, session and Area ACL are verified
    // together against the live store after the child snapshot and BEFORE release.
    const released = result?.ok === true
      ? verifyStagingNoteBeforeRelease(request, identity, store, ownerUserId,
        result.linearization, result.guard)
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId)
      return answer(503, "Staging unavailable");
    if (released === "stale" || result?.ok === false) return answer(404, "Not found");
    if (!result) return answer(503, "Staging unavailable");
    // Internal guard, actor linearization, membership and session tokens never
    // escape the server. No CAS write token is issued to viewers.
    return Response.json({ note: result.note }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/note-detail", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
