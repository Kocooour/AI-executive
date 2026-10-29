import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingChildSessionConfig,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import { enforceRateLimit } from "../../../../../../lib/http-security";
import { readStagingPrivateTaskAuditInChild } from "../../../../../../lib/target-staging-read-process";

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

export async function GET(
  request: Request, context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    return answer(404, "Not found");
  }
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return answer(401, "Authentication required");
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !safeId.test(ownerUserId)) {
    return answer(503, "Staging unavailable");
  }
  // Live session check BEFORE the per-route limiter and any child dispatch: a
  // forged or revoked cookie gets 401 without spawning a worker. Sessions are
  // throttled by their own bucket first (see admitStagingIdentity).
  const refused = admitStagingIdentity(request, identity, { stagingDirectory, expectedRestoreGeneration });
  if (refused) return refused;
  try {
    const { taskId } = await context.params;
    if (!validTaskId(taskId) ||
        new URL(request.url).search !== "") return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-private-task-audit", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const result = await readStagingPrivateTaskAuditInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
      ...stagingChildSessionConfig(identity),
    }, taskId);
    // Linearization point (R2-ID.1): after the child read, immediately before the
    // body is released, a durable session is re-verified against the LIVE store.
    const released = verifyStagingIdentityBeforeRelease(
      request, identity, { stagingDirectory, expectedRestoreGeneration });
    if (released !== "ok") return stagingIdentityRefusal(released);
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId) {
      return answer(503, "Staging unavailable");
    }
    if (!result) return answer(503, "Staging unavailable");
    if (!result.ok) return answer(404, "Not found");
    return Response.json({ events: result.events }, { headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}
