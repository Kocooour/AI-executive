import path from "node:path";
import {
  resolveStagingHttpIdentity, stagingChildSessionConfig,
  admitStagingIdentity, stagingIdentityRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { applyMembershipCommandInChild } from "../../../../../../lib/target-staging-membership-http-process";
import { validTargetStagingMembershipCommand } from "../../../../../../lib/target-staging-membership-command";
import type { StagingPersonalReadConfig } from "../../../../../../lib/target-staging-read-process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = /^[A-Za-z0-9_.:@-]{1,120}$/;
const answer = (status: number, error: string, code?: string): Response =>
  Response.json(code ? { error, code } : { error }, { status, headers });
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
 * R2-ID.2a: one membership command (add / remove / set_role) for one shared
 * Area. The actor is always the authenticated identity, never a JSON field.
 */
export async function POST(request: Request,
  context: { params: Promise<{ areaId: string }> }): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return answer(401, "Authentication required");
  const base = config();
  if (!base) return answer(503, "Staging unavailable");
  const bound = { ...base, ...stagingChildSessionConfig(identity) };
  const params = await context.params;
  const areaId = params && Object.keys(params).join(",") === "areaId" &&
    typeof params.areaId === "string" && safeId.test(params.areaId) ? params.areaId : null;
  if (!areaId || new URL(request.url).search !== "") return answer(400, "Invalid request");
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return answer(403, "Cross-origin request rejected");
    }
    // Admission before limiter and body: forged cookies must not drain budgets.
    const admitted = admitStagingIdentity(request, identity, bound);
    if (admitted) return admitted;
    const limited = enforceRateLimit(request, "target-staging-membership-write", 30, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 8 * 1024, { strictUtf8: true });
    if (!input || typeof input !== "object" || Array.isArray(input)) return answer(400, "Invalid request");
    const fields = input as Record<string, unknown>;
    const command = { areaId, commandId: fields.commandId,
      expectedPolicyRevision: fields.expectedPolicyRevision, action: fields.action,
      targetUserId: fields.targetUserId, ...("role" in fields ? { role: fields.role } : {}) };
    // Unknown keys (e.g. actorUserId) are rejected: the key set is exact.
    if (Object.keys(fields).length !== Object.keys(command).length - 1 ||
        !validTargetStagingMembershipCommand(command)) return answer(400, "Invalid request");
    const liveBeforeWrite = verifyStagingIdentityBeforeRelease(request, identity, bound);
    if (liveBeforeWrite !== "ok") return stagingIdentityRefusal(liveBeforeWrite);
    if (!unchanged(bound)) return answer(503, "Staging unavailable");
    const result = await applyMembershipCommandInChild(bound, command);
    // A durable session is verified INSIDE the write transaction; the owner
    // cookie keeps the post-write re-check used by the title route.
    if (identity.kind === "owner") {
      const afterWrite = verifyStagingIdentityBeforeRelease(request, identity, bound);
      if (afterWrite !== "ok") return stagingIdentityRefusal(afterWrite);
    }
    if (result && result.ok === false && result.reason === "session_revoked") {
      return answer(401, "Authentication required");
    }
    if (!result && identity.kind === "session") {
      const live = verifyStagingIdentityBeforeRelease(request, identity, bound);
      if (live !== "ok") return stagingIdentityRefusal(live);
    }
    if (!unchanged(bound) || !result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      switch (result.reason) {
        case "unavailable": return answer(404, "Not found");
        case "stale_policy_revision": return answer(409, "Policy revision conflict", "stale_policy_revision");
        case "idempotency_conflict": return answer(409, "Idempotency conflict", "idempotency_conflict");
        case "already_member": return answer(409, "Already a member", "already_member");
        case "last_admin": return answer(422, "A shared Area needs at least one admin", "last_admin");
        default: return answer(503, "Staging unavailable");
      }
    }
    return Response.json({
      ok: true, outcome: result.outcome, policyRevision: result.policyRevision,
      unassignedTasks: result.unassignedTasks, ...(result.replayed ? { replayed: true } : {}),
    }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    return answer(503, "Staging unavailable");
  }
}
