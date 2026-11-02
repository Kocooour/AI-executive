/** R2d.2c.2f.4: read-only note-delete receipt lookup in a canonical pinned snapshot. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { validTargetStagingNoteDeleteRequest } from "../lib/target-note-delete-writer.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { readTitleCommand } from "./target-staging-title-stdin.mjs";

const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
const enabled = process.argv.length === 2 &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED === "true" &&
  !!stagingDirectory && path.isAbsolute(stagingDirectory) &&
  !!expectedRestoreGeneration && !!ownerUserId;

try {
  if (!enabled) throw new Error("Unavailable");
  const input = await readTitleCommand(process.stdin, 16 * 1024);
  if (!validTargetStagingNoteDeleteRequest(input)) throw new Error("Invalid note delete command");
  const authority = new TargetStagingSessionAuthority({ stagingDirectory, expectedRestoreGeneration });
  try {
    const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
    if (!resolved) throw new Error("Unavailable");
    const issued = authority.issueWritable(resolved.actor);
    if (!issued) throw new Error("Unavailable");
    const result = authority.noteDeleteCommandStatus(issued.sessionToken, input);
    if (result.ok || result.reason === "unavailable" ||
        result.reason === "idempotency_conflict" || result.reason === "resync_required" ||
        result.reason === "write_area_mismatch") {
      process.stdout.write(JSON.stringify(result));
    } else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }
