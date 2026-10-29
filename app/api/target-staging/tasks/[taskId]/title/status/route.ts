import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingChildSessionConfig,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../../../../lib/target-staging-http-identity";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../../lib/http-security";
import { readPrivateTaskTitleCommandStatusInChild } from "../../../../../../../lib/target-staging-title-http-process";
import { validTargetStagingTaskTitleWriteRequest } from "../../../../../../../lib/target-task-staging-writer";
import type { StagingPersonalReadConfig } from "../../../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[A-Za-z0-9_.:@-]{1,120}$/;
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

/** Read-only reconciliation for the exact original owner-private title command. */
export async function POST(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return answer(401, "Authentication required");
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  const bound = { ...base, ...stagingChildSessionConfig(identity) };
  const params = await context.params;
  if (!params || Object.keys(params).sort().join(",") !== "taskId" ||
      !validTaskId(params.taskId) || new URL(request.url).search !== "") {
    return answer(400, "Invalid request");
  }
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return answer(403, "Cross-origin request rejected");
    }
    const limited = enforceRateLimit(request, "target-staging-private-title-status", 60, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 32 * 1024, { strictUtf8: true });
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "commandId,expectedRevision,title") {
      return answer(400, "Invalid request");
    }
    const fields = input as Record<string, unknown>;
    const command = { taskId: params.taskId, commandId: fields.commandId,
      title: fields.title, expectedRevision: fields.expectedRevision };
    if (!validTargetStagingTaskTitleWriteRequest(command)) return answer(400, "Invalid request");
    const refusedRead = admitStagingIdentity(request, identity, bound);
    if (refusedRead) return refusedRead;
    if (!unchanged(bound)) return answer(503, "Staging unavailable");
    const result = await readPrivateTaskTitleCommandStatusInChild(bound, command);
    // Reconciliation requires a live session at the moment of release.
    const released = verifyStagingIdentityBeforeRelease(request, identity, bound);
    if (released !== "ok") return stagingIdentityRefusal(released);
    if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
    if (result.ok === false) return answer(result.reason === "idempotency_conflict" ? 409 : 404,
      result.reason === "idempotency_conflict" ? "Revision conflict" : "Not found");
    return Response.json({ status: result.status }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    return answer(503, "Staging unavailable");
  }
}
