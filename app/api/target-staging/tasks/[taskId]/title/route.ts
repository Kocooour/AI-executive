import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal, stagingUnauthorizedRefusal, stagingChildSessionConfig,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { previewPrivateTaskTitleInChild, writePrivateTaskTitleInChild } from "../../../../../../lib/target-staging-title-http-process";
import { targetProtocolRefusal, legacySnapshotRefusal, resyncRequiredResponse, writeAreaMismatchResponse } from "../../../../../../lib/target-staging-write-contract";
import { validTargetStagingTaskTitleWriteRequest } from "../../../../../../lib/target-task-staging-writer";
import type { StagingPersonalReadConfig } from "../../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const revision = /^[a-f0-9]{64}$/;
const validTaskId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });
const enabled = () =>
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true";
function config(): StagingPersonalReadConfig | null {
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !safeId.test(ownerUserId)) return null;
  return { stagingDirectory, expectedRestoreGeneration, ownerUserId };
}
const unchanged = (before: StagingPersonalReadConfig) => {
  const current = config();
  return enabled() && current?.stagingDirectory === before.stagingDirectory &&
    current.expectedRestoreGeneration === before.expectedRestoreGeneration &&
    current.ownerUserId === before.ownerUserId;
};
async function taskIdFrom(context: { params: Promise<{ taskId: string }> }) {
  const params = await context.params;
  return params && Object.keys(params).sort().join(",") === "taskId" &&
    validTaskId(params.taskId) ? params.taskId : null;
}

/** Read-only CAS preflight for a task the actor may CURRENTLY write: own private task or shared Area as editor/admin (R2-ID.3). */
export async function GET(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchorRefused = stagingAnchorRefusal(request);
  if (anchorRefused) return anchorRefused;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  const bound = { ...base, ...stagingChildSessionConfig(identity) };
  const taskId = await taskIdFrom(context);
  const refusedPreview = admitStagingIdentity(request, identity, bound);
  if (refusedPreview) return refusedPreview;
  // Input errors only after admission: a dead session always gets its coded 401.
  if (!taskId) return answer(400, "Invalid request");
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "expectedRevision") ||
      query.getAll("expectedRevision").length > 1) return answer(400, "Invalid request");
  const expectedRevision = query.get("expectedRevision");
  if (expectedRevision !== null && !revision.test(expectedRevision)) return answer(400, "Invalid request");
  const limited = enforceRateLimit(request, "target-staging-private-title-preflight", 60, 10 * 60_000);
  if (limited) return Response.json({ error: "Too many requests" }, {
    status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
  });
  const result = await previewPrivateTaskTitleInChild(bound, taskId,
    expectedRevision === null ? undefined : expectedRevision);
  // Read-side linearization point: live session re-verified before release.
  const released = verifyStagingIdentityBeforeRelease(request, identity, bound);
  if (released !== "ok") return stagingIdentityRefusal(released);
  if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
  if (result.ok === false) return answer(result.reason === "stale_revision" ? 409 : 404,
    result.reason === "stale_revision" ? "Revision conflict" : "Not found");
  return Response.json({ snapshotRevision: result.snapshotRevision }, { headers });
}

/** Single title command (private owner or shared editor/admin; ACL re-checked in the write TX); no actor/scope/Area or task ID in JSON. */
export async function PATCH(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchorRefused = stagingAnchorRefusal(request);
  if (anchorRefused) return anchorRefused;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  const bound = { ...base, ...stagingChildSessionConfig(identity) };
  const taskId = await taskIdFrom(context);
  const invalidInput = !taskId || new URL(request.url).search !== "";
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return answer(403, "Cross-origin request rejected");
    }
    // Admission (and its own session-check bucket) comes BEFORE the per-route
    // limiter and the body read: a forged or revoked cookie must not drain
    // bucket budget that legitimate writers or reconciliations need.
    const admitted = admitStagingIdentity(request, identity, bound);
    if (admitted) return admitted;
    // Input errors only after admission: a dead session always gets its coded 401.
    if (invalidInput || !taskId) return answer(400, "Invalid request");
    // R2c.3: protocol version before the limiter and the body read.
    const unsupported = targetProtocolRefusal(request);
    if (unsupported) return unsupported;
    const limited = enforceRateLimit(request, "target-staging-private-title-write", 30, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 32 * 1024, { strictUtf8: true });
    const legacy = legacySnapshotRefusal(input);
    if (legacy) return legacy;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "commandId,expectedRevision,restoreGeneration,title,writeAreaId") {
      return answer(400, "Invalid request");
    }
    const fields = input as Record<string, unknown>;
    const command = { taskId, commandId: fields.commandId,
      title: fields.title, expectedRevision: fields.expectedRevision,
      writeAreaId: fields.writeAreaId, restoreGeneration: fields.restoreGeneration };
    if (!validTargetStagingTaskTitleWriteRequest(command)) return answer(400, "Invalid request");
    // Recheck after potentially slow body read, before dispatching a mutation.
    const liveBeforeWrite = verifyStagingIdentityBeforeRelease(request, identity, bound);
    if (liveBeforeWrite !== "ok") return stagingIdentityRefusal(liveBeforeWrite);
    if (!unchanged(bound)) return answer(503, "Staging unavailable");
    const result = await writePrivateTaskTitleInChild(bound, command);
    // A durable session is verified INSIDE the write transaction, so no
    // post-commit check is made for it (a committed write must not be reported
    // as refused). The owner cookie keeps its existing post-write re-check.
    if (identity.kind === "owner") {
      const afterWrite = verifyStagingIdentityBeforeRelease(request, identity, bound);
      if (afterWrite !== "ok") return stagingIdentityRefusal(afterWrite);
    }
    if (result && result.ok === false && result.reason === "session_revoked") {
      return stagingUnauthorizedRefusal(request, identity, bound);
    }
    if (!result && identity.kind === "session") {
      // Child produced nothing: distinguish a revoked session from an outage.
      const live = verifyStagingIdentityBeforeRelease(request, identity, bound);
      if (live !== "ok") return stagingIdentityRefusal(live);
    }
    if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      if (result.reason === "unavailable") return answer(404, "Not found");
      if (result.reason === "resync_required") return resyncRequiredResponse();
      if (result.reason === "write_area_mismatch") return writeAreaMismatchResponse();
      if (result.reason === "stale_revision" || result.reason === "idempotency_conflict" ||
          result.reason === "unchanged") return answer(409, "Revision conflict");
      return answer(503, "Staging unavailable");
    }
    return Response.json(result.replayed ? { ok: true, replayed: true } : { ok: true }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    return answer(503, "Staging unavailable");
  }
}

