/** R2d.2c.2e: read-only reconciliation for an uncertain existing-note PATCH. */
import path from "node:path";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../../../lib/http-security";
import { logStagingFailure } from "../../../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingNoteBeforeRelease,
} from "../../../../../../../lib/target-staging-http-identity";
import { readStagingNoteEditCommandStatusInChild } from "../../../../../../../lib/target-staging-title-http-process";
import { readStagingAuthorizedNoteInChild } from "../../../../../../../lib/target-staging-read-process";
import { validTargetStagingNoteEditRequest } from "../../../../../../../lib/target-note-staging-writer";
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
const unchanged = (base: NonNullable<ReturnType<typeof config>>) => {
  const now = config();
  return enabled() && now?.stagingDirectory === base.stagingDirectory &&
    now.expectedRestoreGeneration === base.expectedRestoreGeneration &&
    now.ownerUserId === base.ownerUserId;
};

export async function POST(request: Request, context: { params: Promise<{ noteId: string }> }): Promise<Response> {
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
    const unsupported = targetProtocolRefusal(request);
    if (unsupported) return unsupported;
    const limited = enforceRateLimit(request, "target-staging-note-edit-status", 60, 600000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const input = await readJsonBody<unknown>(request, 192 * 1024, { strictUtf8: true });
    const legacy = legacySnapshotRefusal(input);
    if (legacy) return legacy;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "body,commandId,expectedRevision,restoreGeneration,title,writeAreaId")
      return answer(400, "Invalid request");
    const data = input as Record<string, unknown>;
    const command = {
      noteId: params.noteId, body: data.body, commandId: data.commandId,
      expectedRevision: data.expectedRevision, title: data.title,
      restoreGeneration: data.restoreGeneration, writeAreaId: data.writeAreaId,
    };
    if (!validTargetStagingNoteEditRequest(command)) return answer(400, "Invalid request");
    const live = verifyStagingIdentityBeforeRelease(request, identity, base);
    if (live !== "ok") return stagingIdentityRefusal(live);
    if (!unchanged(base)) return answer(503, "Staging unavailable");

    const childConfig = { ...base, ...stagingChildSessionConfig(identity) };
    // Take the note/parent/Area proof BEFORE the receipt read, then demand
    // that this exact observed scope is still live AFTER reconciliation.
    // A move, membership change or edit across the two snapshots refuses
    // rather than attributing a receipt to a different current note scope.
    const note = await readStagingAuthorizedNoteInChild(childConfig, params.noteId);
    const admittedNote = verifyStagingIdentityBeforeRelease(request, identity, base);
    if (admittedNote !== "ok") return stagingIdentityRefusal(admittedNote);
    if (!unchanged(base) || !note) return answer(503, "Staging unavailable");
    if (note.ok === false) return answer(404, "Not found");
    const role = note.linearization.areas[0]?.access;
    if (role !== "private-owner" && role !== "editor" && role !== "admin")
      return answer(404, "Not found");

    const result = await readStagingNoteEditCommandStatusInChild(childConfig, command);
    const released = verifyStagingNoteBeforeRelease(request, identity, base,
      base.ownerUserId, note.linearization, note.guard);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    if (!unchanged(base) || !result) return answer(503, "Staging unavailable");
    if (released === "stale") return answer(404, "Not found");
    if (result.ok === false && result.reason === "unavailable")
      return answer(404, "Not found");
    if (result.ok === false) {
      if (result.reason === "resync_required") return resyncRequiredResponse();
      if (result.reason === "write_area_mismatch") return writeAreaMismatchResponse();
      return result.reason === "idempotency_conflict"
        ? answer(409, "Revision conflict") : answer(404, "Not found");
    }
    return Response.json({ status: result.status }, { headers });
  } catch (error) {
    if (error instanceof HttpInputError) return answer(error.status, error.message);
    logStagingFailure("target-staging/note-edit-status", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
