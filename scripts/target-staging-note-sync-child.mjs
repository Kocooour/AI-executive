/** Bounded note-sync read with server-derived actor and a canonical pinned snapshot. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { NOTE_SYNC_CURSOR_LENGTH } from "../lib/target-note-sync-cursor.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [areaId, rawLimit, rawCursor, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const secret = process.env.AI_EXECUTIVE_TARGET_STAGING_NOTE_SYNC_SECRET;
  const validId = typeof areaId === "string" && areaId.length > 0 && areaId.trim() === areaId &&
    areaId !== "." && areaId !== ".." && areaId.isWellFormed() &&
    Buffer.byteLength(areaId, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(areaId);
  const validCursor = rawCursor === "-" || rawCursor === "invalid" ||
    (typeof rawCursor === "string" && rawCursor.length === NOTE_SYNC_CURSOR_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(rawCursor));
  if (extra !== undefined || !validId || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit || "") ||
      !validCursor || !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId || !secret || secret.length < 32 ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true") {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({ stagingDirectory, expectedRestoreGeneration });
    try {
      const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
      if (!resolved) throw new Error("Unavailable");
      const result = authority.readAuthorizedNoteSync(resolved.actor, {
        areaId, limit: Number(rawLimit), secret,
        ...(rawCursor === "-" ? {} : { cursor: rawCursor }),
      });
      if (!result) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(result));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
