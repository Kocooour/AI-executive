import path from "node:path";
import { getAuthState } from "../../../../../lib/auth";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { readStagingPrivateProjectDetailInChild } from "../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validProjectId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });

/** Isolated owner-only project detail. No shared data or project aggregates. */
export async function GET(
  request: Request, context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    return answer(404, "Not found");
  }
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured || !auth.authenticated) {
    return answer(401, "Authentication required");
  }
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !safeId.test(ownerUserId)) {
    return answer(503, "Staging unavailable");
  }
  try {
    const { projectId } = await context.params;
    if (!validProjectId(projectId) ||
        new URL(request.url).search !== "") return answer(400, "Invalid request");
    const limited = enforceRateLimit(request, "target-staging-private-project-detail", 120, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const result = await readStagingPrivateProjectDetailInChild({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
    }, projectId);
    const currentAuth = getAuthState(request);
    if (!currentAuth.enabled || !currentAuth.configured || !currentAuth.authenticated) {
      return answer(401, "Authentication required");
    }
    if (process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId) {
      return answer(503, "Staging unavailable");
    }
    if (!result) return answer(503, "Staging unavailable");
    if (!result.ok) return answer(404, "Not found");
    return Response.json({ project: result.project }, { headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}
