import path from "node:path";
import { getAuthState } from "../../../../../../lib/auth";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { previewPrivateTaskTitleInChild, writePrivateTaskTitleInChild } from "../../../../../../lib/target-staging-title-http-process";
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
const authenticated = (request: Request) => {
  const auth = getAuthState(request);
  return auth.enabled && auth.configured && auth.authenticated;
};
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

/** Read-only CAS preflight for one currently owner-private task. */
export async function GET(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  if (!authenticated(request)) return answer(401, "Authentication required");
  const bound = config();
  if (!bound) return answer(503, "Staging unavailable");
  const taskId = await taskIdFrom(context);
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
  if (!authenticated(request)) return answer(401, "Authentication required");
  if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
  if (result.ok === false) return answer(result.reason === "stale_revision" ? 409 : 404,
    result.reason === "stale_revision" ? "Revision conflict" : "Not found");
  return Response.json({ snapshotRevision: result.snapshotRevision }, { headers });
}

/** Single owner-private title command; no actor/scope/Area or task ID in JSON. */
export async function PATCH(request: Request,
  context: { params: Promise<{ taskId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  if (!authenticated(request)) return answer(401, "Authentication required");
  const bound = config();
  if (!bound) return answer(503, "Staging unavailable");
  const taskId = await taskIdFrom(context);
  if (!taskId || new URL(request.url).search !== "") return answer(400, "Invalid request");
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return answer(403, "Cross-origin request rejected");
    }
    const limited = enforceRateLimit(request, "target-staging-private-title-write", 30, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 6144);
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "commandId,expectedRevision,title") {
      return answer(400, "Invalid request");
    }
    const fields = input as Record<string, unknown>;
    const command = { taskId, commandId: fields.commandId,
      title: fields.title, expectedRevision: fields.expectedRevision };
    if (!validTargetStagingTaskTitleWriteRequest(command)) return answer(400, "Invalid request");
    // Recheck after potentially slow body read, before dispatching a mutation.
    if (!authenticated(request)) return answer(401, "Authentication required");
    if (!unchanged(bound)) return answer(503, "Staging unavailable");
    const result = await writePrivateTaskTitleInChild(bound, command);
    if (!authenticated(request)) return answer(401, "Authentication required");
    if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      if (result.reason === "unavailable") return answer(404, "Not found");
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

