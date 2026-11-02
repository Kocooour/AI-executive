/** R2d.2c.2c: opt-in staging note detail. No production UI or sync activation. */
import path from "node:path";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal, stagingUnauthorizedRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingNoteBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import { readStagingAuthorizedNoteInChild } from "../../../../../lib/target-staging-read-process";
import { deleteStagingNoteInChild } from "../../../../../lib/target-staging-title-http-process";
import { validTargetStagingNoteDeleteRequest } from "../../../../../lib/target-note-delete-writer";
import { targetProtocolRefusal, legacySnapshotRefusal, resyncRequiredResponse, writeAreaMismatchResponse } from "../../../../../lib/target-staging-write-contract";

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
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED !== "true")
    return answer(404, "Not found");
  // Unlike generic staging readers, note HTTP must refuse an unverified live
  // store (including a mismatched restore generation) with 503, not a 404.
  const anchor = stagingAnchorRefusal(request, true);
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
        process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED !== "true" ||
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


/**
 * R2d.2c.2f.3: default-off DELETE of an existing note. The optimistic
 * expectedRevision comes from the authorized /edit GET preview. No content,
 * actor or Area is accepted as a mutation; current ACL is checked in the
 * pinned delete transaction, including on an idempotent replay.
 */
export async function DELETE(
  request: Request, context: { params: Promise<{ noteId: string }> },
): Promise<Response> {
  const enabled = () =>
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true" &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED === "true";
  if (!enabled()) return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request, true);
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
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return answer(403, "Cross-origin request rejected");
    const admitted = admitStagingIdentity(request, identity, store);
    if (admitted) return admitted;
    const params = await context.params;
    if (!params || Object.keys(params).sort().join(",") !== "noteId" ||
        !validNoteId(params.noteId) || new URL(request.url).search !== "")
      return answer(400, "Invalid request");
    const protocol = targetProtocolRefusal(request);
    if (protocol) return protocol;
    const limited = enforceRateLimit(request, "target-staging-note-delete-write", 30, 600000);
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
    const fields = input as Record<string, unknown>;
    const command = {
      noteId: params.noteId, commandId: fields.commandId,
      expectedRevision: fields.expectedRevision,
      restoreGeneration: fields.restoreGeneration, writeAreaId: fields.writeAreaId,
    };
    if (!validTargetStagingNoteDeleteRequest(command)) return answer(400, "Invalid request");
    const live = verifyStagingIdentityBeforeRelease(request, identity, store);
    if (live !== "ok") return stagingIdentityRefusal(live);
    const unchanged = () => enabled() &&
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY === stagingDirectory &&
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION === expectedRestoreGeneration &&
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID === ownerUserId;
    if (!unchanged()) return answer(503, "Staging unavailable");
    const result = await deleteStagingNoteInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity),
    }, command);
    // The write child checks session liveness inside BEGIN IMMEDIATE. After a
    // successful commit, do not rewrite its outcome as a session denial.
    if (identity.kind === "owner") {
      const checked = verifyStagingIdentityBeforeRelease(request, identity, store);
      if (checked !== "ok") return stagingIdentityRefusal(checked);
    }
    if (result?.ok === false && result.reason === "session_revoked")
      return stagingUnauthorizedRefusal(request, identity, store);
    if (!result && identity.kind === "session") {
      const checked = verifyStagingIdentityBeforeRelease(request, identity, store);
      if (checked !== "ok") return stagingIdentityRefusal(checked);
    }
    if (!unchanged() || !result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      if (result.reason === "unavailable") return answer(404, "Not found");
      if (result.reason === "resync_required") return resyncRequiredResponse();
      if (result.reason === "write_area_mismatch") return writeAreaMismatchResponse();
      if (result.reason === "stale_revision" || result.reason === "idempotency_conflict")
        return answer(409, "Revision conflict");
      return answer(503, "Staging unavailable");
    }
    return Response.json(result.replayed ? { ok: true, replayed: true } : { ok: true }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    logStagingFailure("target-staging/note-delete-write", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
