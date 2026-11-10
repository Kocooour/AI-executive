/** R3-BE-4b: default-off, private standalone note creation for future Quick Capture.
 * This route never writes legacy data and cannot create/shared-parent notes.
 */
import path from "node:path";
import {
  HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin,
} from "../../../../lib/http-security";
import { logStagingFailure } from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  stagingUnauthorizedRefusal, verifyStagingIdentityBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { validTargetStagingNoteLifecycleRequest } from "../../../../lib/target-note-lifecycle-writer";
import { createPrivateStagingNoteInChild } from "../../../../lib/target-staging-note-create-process";
import {
  targetProtocolRefusal, legacySnapshotRefusal, resyncRequiredResponse,
} from "../../../../lib/target-staging-write-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const answer = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers });
const enabled = (): boolean => [
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
].every(name => process.env[name] === "true");

export async function POST(request: Request): Promise<Response> {
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
      !ownerUserId || !actor.test(ownerUserId))
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const unchanged = () => enabled() &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY === stagingDirectory &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION === expectedRestoreGeneration &&
    process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID === ownerUserId;
  try {
    requireSameOrigin(request);
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return answer(403, "Cross-origin request rejected");
    const admitted = admitStagingIdentity(request, identity, store);
    if (admitted) return admitted;
    if (new URL(request.url).search !== "") return answer(400, "Invalid request");
    const protocol = targetProtocolRefusal(request);
    if (protocol) return protocol;
    const limited = enforceRateLimit(request, "target-staging-private-note-create", 30, 600_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const body = await readJsonBody<unknown>(request, 160 * 1024, { strictUtf8: true });
    const legacy = legacySnapshotRefusal(body);
    if (legacy) return legacy;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).sort().join(",") !==
          "areaId,body,commandId,noteId,restoreGeneration,title")
      return answer(400, "Invalid request");
    const fields = body as Record<string, unknown>;
    // Client does not control the operation or a project parent.
    const command = {
      kind: "create" as const, projectId: null,
      noteId: fields.noteId, areaId: fields.areaId,
      commandId: fields.commandId, restoreGeneration: fields.restoreGeneration,
      title: fields.title, body: fields.body,
    };
    if (!uuid.test(String(fields.noteId ?? "")) ||
        !validTargetStagingNoteLifecycleRequest(command))
      return answer(400, "Invalid request");
    const live = verifyStagingIdentityBeforeRelease(request, identity, store);
    if (live !== "ok") return stagingIdentityRefusal(live);
    if (!unchanged()) return answer(503, "Staging unavailable");
    const result = await createPrivateStagingNoteInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity),
    }, command);
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
      if (result.reason === "idempotency_conflict")
        return answer(409, "Revision conflict");
      return answer(503, "Staging unavailable");
    }
    return Response.json(
      result.replayed
        ? { ok: true, noteId: command.noteId, replayed: true }
        : { ok: true, noteId: command.noteId },
      { status: result.replayed ? 200 : 201, headers },
    );
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    logStagingFailure("target-staging/private-note-create", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
