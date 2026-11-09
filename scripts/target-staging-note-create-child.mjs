/** R3-BE-4b: one private, standalone note create; bounded stdin, no argv content. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { validTargetStagingNoteLifecycleRequest } from "../lib/target-note-lifecycle-writer.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { readTitleCommand } from "./target-staging-title-stdin.mjs";

const directory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const generation = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const owner = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
try {
  if (process.argv.length !== 2 ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED !== "true" ||
      !directory || !path.isAbsolute(directory) || !generation || !owner)
    throw new Error("Unavailable");
  const input = await readTitleCommand(process.stdin, 192 * 1024);
  if (!validTargetStagingNoteLifecycleRequest(input) ||
      input.kind !== "create" || input.projectId !== null)
    throw new Error("Invalid create command");
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: directory, expectedRestoreGeneration: generation,
  });
  try {
    const resolved = resolveChildActor({
      stagingDirectory: directory, expectedRestoreGeneration: generation, ownerUserId: owner,
    });
    if (!resolved) throw new Error("Unavailable");
    const issued = authority.issueWritable(resolved.actor);
    if (!issued) throw new Error("Unavailable");
    // The pinned writer enforces private Area and no project under BEGIN IMMEDIATE.
    const result = authority.changeNoteLifecycle(
      issued.sessionToken, input, resolved.sessionTokenHash, true,
    );
    if (result.ok) {
      process.stdout.write(JSON.stringify(result.replayed
        ? { ok: true, replayed: true } : { ok: true }));
    } else if ([
      "unavailable", "session_revoked", "resync_required", "idempotency_conflict",
      "write_failed",
    ].includes(result.reason)) {
      process.stdout.write(JSON.stringify(result));
    } else {
      throw new Error("Unavailable");
    }
  } finally { authority.close(); }
} catch { process.exitCode = 1; }
