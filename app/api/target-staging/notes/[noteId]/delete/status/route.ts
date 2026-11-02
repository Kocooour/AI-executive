/** R2d.2c.2f.4: opt-in read-only reconciliation of an exact note delete command. */
import path from "node:path";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,
} from "../../../../../../../lib/target-staging-http-identity";
import { readStagingNoteDeleteCommandStatusInChild } from "../../../../../../../lib/target-staging-title-http-process";
import { validTargetStagingNoteDeleteRequest } from "../../../../../../../lib/target-note-delete-writer";
import {
  targetProtocolRefusal, legacySnapshotRefusal, resyncRequiredResponse, writeAreaMismatchResponse,
} from "../../../../../../../lib/target-staging-write-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validNoteId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.trim() === v &&
  v !== "." && v !== ".." && Buffer.byteLength(v, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });
const enabled = () =>
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED === "true";
function config() {
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !safeActor.test(ownerUserId)) return null;
  return { stagingDirectory, expectedRestoreGeneration, ownerUserId };
}
const unchanged = (before: NonNullable<ReturnType<typeof config>>) => {
  const now = config();
  return enabled() && now?.stagingDirectory === before.stagingDirectory &&
    now.expectedRestoreGeneration === before.expectedRestoreGeneration &&
    now.ownerUserId === before.ownerUserId;
};

/**
 * The original four-field command is repeated verbatim (noteId from URL).
 * A successful result proves an actor-bound receipt, not access to note data.
 * Checking live identity both before and after the read prevents a revoked
 * durable session from receiving a stale committed answer.
 */
export async function POST(
  request: Request, context: { params: Promise<{ noteId: string }> },
): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request, true);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return answer(403, "Cross-origin request rejected");
    const admitted = admitStagingIdentity(request, identity, base);
    if (admitted) return admitted;
    const params = await context.params;
    if (!params || Object.keys(params).sort().join(",") !== "noteId" ||
        !validNoteId(params.noteId) || new URL(request.url).search !== "")
      return answer(400, "Invalid request");
    const protocol = targetProtocolRefusal(request);
    if (protocol) return protocol;
    const limited = enforceRateLimit(request, "target-staging-note-delete-status", 60, 600000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 16 * 1024, { strictUtf8: true });
    const legacy = legacySnapshotRefusal(input);
    if (legacy) return legacy;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "commandId,expectedRevision,restoreGeneration,writeAreaId")
      return answer(400, "Invalid request");
    const data = input as Record<string, unknown>;
    const command = {
      noteId: params.noteId, commandId: data.commandId,
      expectedRevision: data.expectedRevision, restoreGeneration: data.restoreGeneration,
      writeAreaId: data.writeAreaId,
    };
    if (!validTargetStagingNoteDeleteRequest(command)) return answer(400, "Invalid request");
    const live = verifyStagingIdentityBeforeRelease(request, identity, base);
    if (live !== "ok") return stagingIdentityRefusal(live);
    if (!unchanged(base)) return answer(503, "Staging unavailable");
    const childConfig = { ...base, ...stagingChildSessionConfig(identity) };
    const result = await readStagingNoteDeleteCommandStatusInChild(childConfig, command);
    const released = verifyStagingIdentityBeforeRelease(request, identity, base);
    if (released !== "ok") return stagingIdentityRefusal(released);
    if (!unchanged(base) || !result) return answer(503, "Staging unavailable");

    // Recheck CURRENT Area permission and exact receipt for EVERY outcome:
    // even a 409 conflict/mismatch must not be released after role revocation.
    const rechecked = await readStagingNoteDeleteCommandStatusInChild(childConfig, command);
    const liveAgain = verifyStagingIdentityBeforeRelease(request, identity, base);
    if (liveAgain !== "ok") return stagingIdentityRefusal(liveAgain);
    if (!unchanged(base) || !rechecked) return answer(503, "Staging unavailable");
    if (JSON.stringify(rechecked) !== JSON.stringify(result))
      return answer(404, "Not found");
    if (result.ok === false && result.reason === "resync_required")
      return resyncRequiredResponse();
    if (result.ok === false && result.reason === "write_area_mismatch")
      return writeAreaMismatchResponse();
    if (result.ok === false)
      return result.reason === "idempotency_conflict"
        ? answer(409, "Revision conflict") : answer(404, "Not found");
    return Response.json({ status: result.status }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    logStagingFailure("target-staging/note-delete-status", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
