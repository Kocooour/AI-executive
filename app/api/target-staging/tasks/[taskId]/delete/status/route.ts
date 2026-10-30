import { logStagingFailure } from "../../../../../../../lib/target-staging-failure-log";
import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingUnauthenticatedRefusal, stagingChildSessionConfig,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../../../../lib/target-staging-http-identity";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../../lib/http-security";
import { readTaskDeleteCommandStatusInChild } from "../../../../../../../lib/target-staging-title-http-process";
import { targetProtocolRefusal, legacySnapshotRefusal, resyncRequiredResponse, writeAreaMismatchResponse } from "../../../../../../../lib/target-staging-write-contract";
import { validTargetStagingTaskDeleteRequest } from "../../../../../../../lib/target-task-delete-writer";
import type { StagingPersonalReadConfig } from "../../../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validTaskId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const CONFLICT = "Revision conflict";
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

/**
 * Read-only per-identity reconciliation for the exact original delete command
 * (R2c.1). Needs the CURRENT write right in the task's Area or, once the task is
 * gone, in the Area its tombstone records, plus the actor's own receipt.
 */
export async function POST(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  const bound = { ...base, ...stagingChildSessionConfig(identity) };
  const params = await context.params;
  const invalidInput = !params || Object.keys(params).sort().join(",") !== "taskId" ||
    !validTaskId(params.taskId) || new URL(request.url).search !== "";
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
    if (invalidInput) return answer(400, "Invalid request");
    // R2c.3: protocol version before the limiter and the body read.
    const unsupported = targetProtocolRefusal(request);
    if (unsupported) return unsupported;
    const limited = enforceRateLimit(request, "target-staging-task-delete-status", 60, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 32 * 1024, { strictUtf8: true });
    const legacy = legacySnapshotRefusal(input);
    if (legacy) return legacy;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "commandId,expectedRevision,restoreGeneration,writeAreaId") {
      return answer(400, "Invalid request");
    }
    const fields = input as Record<string, unknown>;
    const command = { taskId: params.taskId, commandId: fields.commandId,
      expectedRevision: fields.expectedRevision,
      writeAreaId: fields.writeAreaId, restoreGeneration: fields.restoreGeneration };
    if (!validTargetStagingTaskDeleteRequest(command)) return answer(400, "Invalid request");
    const liveBeforeRead = verifyStagingIdentityBeforeRelease(request, identity, bound);
    if (liveBeforeRead !== "ok") return stagingIdentityRefusal(liveBeforeRead);
    if (!unchanged(bound)) return answer(503, "Staging unavailable");
    const result = await readTaskDeleteCommandStatusInChild(bound, command);
    // Reconciliation requires a live session at the moment of release.
    const released = verifyStagingIdentityBeforeRelease(request, identity, bound);
    if (released !== "ok") return stagingIdentityRefusal(released);
    if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
    if (result.ok === false && result.reason === "resync_required") return resyncRequiredResponse();
    if (result.ok === false && result.reason === "write_area_mismatch") return writeAreaMismatchResponse();
    if (result.ok === false) {
      return result.reason === "idempotency_conflict"
        ? Response.json({ error: CONFLICT, code: "idempotency_conflict" }, { status: 409, headers })
        : answer(404, "Not found");
    }
    return Response.json({ status: result.status }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    logStagingFailure("target-staging/tasks/[taskId]/delete/status", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
