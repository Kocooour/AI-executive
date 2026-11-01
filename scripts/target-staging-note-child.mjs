/** R2d.2c.2c: bounded isolated read; actor comes only from trusted HTTP identity. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [noteId, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || !noteId || noteId.trim() !== noteId ||
      noteId === "." || noteId === ".." || Buffer.byteLength(noteId, "utf8") > 512 ||
      /[\u0000-\u001f\u007f]/u.test(noteId) ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({ stagingDirectory, expectedRestoreGeneration });
    try {
      const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
      if (!resolved) throw new Error("Unavailable");
      const found = authority.readAuthorizedNote(resolved.actor, noteId);
      process.stdout.write(JSON.stringify(found
        ? { ok: true, note: found.note, linearization: found.linearization, guard: found.guard }
        : { ok: false, reason: "unavailable" }));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
