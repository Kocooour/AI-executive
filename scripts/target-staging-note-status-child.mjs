/** R2d.2c.2e: read-only note command status. Full command only on bounded stdin. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { validTargetStagingNoteEditRequest } from "../lib/target-note-staging-writer.ts";
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
  const command = await readTitleCommand(process.stdin, 192 * 1024);
  if (!validTargetStagingNoteEditRequest(command)) throw new Error("Invalid command");
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
    if (!resolved) throw new Error("Unavailable");
    const session = authority.issueWritable(resolved.actor);
    if (!session) throw new Error("Unavailable");
    const result = authority.noteEditCommandStatus(session.sessionToken, command);
    if (result.ok || ["unavailable","idempotency_conflict","resync_required","write_area_mismatch"].includes(result.reason))
      process.stdout.write(JSON.stringify(result));
    else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }
