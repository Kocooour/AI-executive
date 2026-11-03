/** Default-off, Area-local staging note metadata synchronization. */
import path from "node:path";
import { enforceRateLimit } from "../../../../lib/http-security";
import { logStagingFailure } from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity, stagingAnchorRefusal, stagingUnauthenticatedRefusal,
  stagingChildSessionConfig, admitStagingIdentity, stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease, verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import { readStagingNoteSyncInChild } from "../../../../lib/target-staging-read-process";
import { NOTE_SYNC_CURSOR_LENGTH, openTargetNoteSyncCursor } from "../../../../lib/target-note-sync-cursor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && value.isWellFormed() &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const answer = (status: number, error: string) => Response.json({ error }, { status, headers });
const code = (value: "resync_required" | "read_stale_reload") =>
  Response.json({ code: value }, { status: 409, headers });
const enabled = () => process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED === "true";

export async function GET(request: Request): Promise<Response> {
  if (!enabled()) return answer(404, "Not found");
  const anchor = stagingAnchorRefusal(request, true);
  if (anchor) return anchor;
  const identity = resolveStagingHttpIdentity(request);
  if (!identity) return stagingUnauthenticatedRefusal(request);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const secret = process.env.AI_EXECUTIVE_SESSION_SECRET || "";
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !uuid.test(expectedRestoreGeneration) ||
      !ownerUserId || !actor.test(ownerUserId) || secret.length < 32)
    return answer(503, "Staging unavailable");
  const store = { stagingDirectory, expectedRestoreGeneration };
  const refused = admitStagingIdentity(request, identity, store);
  if (refused) return refused;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !["areaId", "limit", "cursor"].includes(key)) ||
        params.getAll("areaId").length !== 1 || params.getAll("limit").length > 1 ||
        params.getAll("cursor").length > 1) return answer(400, "Invalid request");
    const areaId = params.get("areaId");
    const rawLimit = params.get("limit") ?? "100";
    const cursor = params.get("cursor");
    if (!validId(areaId) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400, "Invalid request");
    const limit = Number(rawLimit);
    const limited = enforceRateLimit(request, "target-staging-note-sync", 120, 600000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    // A malformed token is a resync only after proving current Area access in the child.
    // Pass a sentinel-shaped invalid token through the authenticated selector.
    const childCursor = cursor === null ? undefined :
      (cursor.length === NOTE_SYNC_CURSOR_LENGTH && /^[A-Za-z0-9_-]+$/.test(cursor)
        ? cursor : "invalid");
    const result = await readStagingNoteSyncInChild({
      ...store, ownerUserId, ...stagingChildSessionConfig(identity), noteSyncSecret: secret,
    }, areaId, limit, childCursor);
    const released = result?.ok
      ? verifyStagingReadBeforeRelease(request, identity, store, ownerUserId,
          result.page.linearization, undefined, undefined, undefined,
          { ...result.stamp, epoch: result.epoch })
      : verifyStagingIdentityBeforeRelease(request, identity, store);
    if (released !== "ok" && released !== "stale") return stagingIdentityRefusal(released);
    if (!enabled() || process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY !== stagingDirectory ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION !== expectedRestoreGeneration ||
        process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID !== ownerUserId ||
        (process.env.AI_EXECUTIVE_SESSION_SECRET || "") !== secret)
      return answer(503, "Staging unavailable");
    if (!result) return answer(503, "Staging unavailable");
    if (result.ok === false) {
      if (result.reason === "inaccessible") return answer(404, "Not found");
      if (result.reason === "resync_required") return code("resync_required");
      return answer(503, "Staging unavailable");
    }
    if (released === "stale") return code("read_stale_reload");
    if (result?.ok) {
      const area = result.page.linearization.areas[0];
      const opened = openTargetNoteSyncCursor(secret, result.page.cursor, {
        actorUserId: result.page.linearization.actorUserId,
        sessionEpoch: result.epoch, restoreGeneration: expectedRestoreGeneration,
        areaId, policyRevision: area.policyRevision, access: area.access,
      });
      if (!opened.ok || (result.page.phase === "bootstrap"
        ? result.page.more
          ? opened.position.phase !== "bootstrap" ||
            opened.position.afterId !== result.page.entries.at(-1)?.id
          : opened.position.phase !== "changes" ||
            opened.position.afterSeq !== result.stamp.head ||
            opened.position.contentRevision !== result.stamp.contentRevision
        : opened.position.phase !== "changes" ||
          (result.page.changes.length > 0
            ? opened.position.afterSeq !== result.page.changes.at(-1)?.seq
            : opened.position.afterSeq !== result.stamp.head) ||
          opened.position.afterSeq > result.stamp.head ||
          opened.position.contentRevision > result.stamp.contentRevision ||
          result.page.more !== (opened.position.afterSeq < result.stamp.head) ||
          result.stamp.contentRevision - opened.position.contentRevision !==
            result.stamp.head - opened.position.afterSeq))
        return answer(503, "Staging unavailable");
    }
    // Explicit external DTO; internal seq, epoch, stamp, actor and policy never leave.
    return Response.json({ phase: result.page.phase, entries: result.page.entries,
      changes: result.page.changes.map(c => ({
        kind: c.kind, noteId: c.noteId, projectId: c.projectId, revision: c.revision,
        ...(c.kind === "upsert" ? { parentRevision: c.parentRevision } : {}),
      })), more: result.page.more, cursor: result.page.cursor }, { headers });
  } catch (error) {
    logStagingFailure("target-staging/note-sync", "route_exception", error);
    return answer(503, "Staging unavailable");
  }
}
