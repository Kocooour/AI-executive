/**
 * R2 staging-only single-task title mutation. Not a route, sync command or
 * production writer; the only supported entry is a session-bound authority.
 *
 * Node SQLite cannot attach to a pinned fd. Hold a no-follow source fd and
 * verify SQLite opened that inode before hashing and writing. BEGIN IMMEDIATE
 * serializes writers across revision, authorization and UPDATE. Any failure
 * rolls back; a preview is never a write authorization capability.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TARGET_STORE_FILENAME, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { canEditIsolatedTargetTaskTitle, validTargetTaskTitleEditPreviewRequest } from "./target-task-write-preflight";

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 64 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_TITLE_LENGTH = 4096;

export interface TargetStagingTaskTitleWriteRequest {
  readonly taskId: string;
  readonly title: string;
  /** Mandatory SHA-256 returned by a preview on this exact staging store. */
  readonly expectedRevision: string;
}

export type TargetStagingTaskTitleWriteResult =
  | { ok: true }
  | { ok: false;
      reason: "invalid_request" | "unauthorized" | "unavailable" |
        "stale_revision" | "write_failed" };

const denied = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "write_failed" });

export function validTargetStagingTaskTitleWriteRequest(
  value: unknown,
): value is TargetStagingTaskTitleWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "expectedRevision,taskId,title") return false;
  if (typeof input.expectedRevision !== "string" ||
      !validTargetTaskTitleEditPreviewRequest({
        taskId: input.taskId, expectedRevision: input.expectedRevision,
      })) return false;
  return typeof input.title === "string" &&
    input.title.length > 0 && input.title.length <= MAX_TITLE_LENGTH &&
    input.title.trim().length > 0 && input.title.trim() === input.title &&
    !input.title.includes("\0");
}

function noSidecars(databasePath: string): boolean {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    try {
      lstatSync(databasePath + suffix);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

function fingerprint(fd: number): string {
  const before = fstatSync(fd);
  if (!before.isFile() || !Number.isSafeInteger(before.size) ||
      before.size < 100 || before.size > MAX_DATABASE_BYTES) {
    throw new Error("Invalid staging database size");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let offset = 0;
  while (offset < before.size) {
    const count = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, before.size - offset), offset);
    if (count <= 0) throw new Error("Short staging database read");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(fd);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs) throw new Error("Staging file changed");
  return hash.digest("hex");
}

/**
 * This is a deliberately isolated staging file writer, not a production VFS.
 * The caller cannot supply a DatabaseSync, file descriptor, actor or revision
 * fingerprint. Everything is established within this synchronous boundary.
 */
export function writePreflightedTargetTaskTitle(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskTitleWriteRequest,
): TargetStagingTaskTitleWriteResult {
  if (!validTargetStagingTaskTitleWriteRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string" ||
      !GENERATION.test(store.expectedRestoreGeneration)) return denied();

  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd"
    : process.platform === "darwin" ? "/dev/fd" : null;
  if (!descriptorRoot || constants.O_DIRECTORY === undefined ||
      constants.O_NOFOLLOW === undefined) return denied();

  let directoryFd: number | null = null;
  let databaseFd: number | null = null;
  let db: DatabaseSync | null = null;
  let transaction = false;
  try {
    const directory = verifyExistingTargetStagingPath(store.stagingDirectory);
    directoryFd = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (realpathSync(descriptorRoot + "/" + directoryFd) !== directory) return denied();
    const databasePath = path.join(directory, TARGET_STORE_FILENAME);
    const info = lstatSync(databasePath);
    if (!info.isFile() || info.isSymbolicLink() || !noSidecars(databasePath)) return denied();
    databaseFd = openSync(descriptorRoot + "/" + directoryFd + "/" + TARGET_STORE_FILENAME,
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(databaseFd);
    if (!pinned.isFile() || pinned.nlink !== 1 ||
        pinned.dev !== info.dev || pinned.ino !== info.ino) return denied();

    // SQLite uses a pathname, so prove its newly opened handle refers to
    // the same pinned inode before allowing any write. This is also the
    // fail-closed inode check used by the staging read facade.
    const matchingCount = (): number => readdirSync(descriptorRoot).reduce((sum, name) => {
      if (!/^[0-9]+$/.test(name)) return sum;
      try {
        const opened = fstatSync(Number(name));
        return sum + Number(opened.isFile() &&
          opened.dev === pinned.dev && opened.ino === pinned.ino);
      } catch {
        return sum;
      }
    }, 0);
    const countBefore = matchingCount();
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    transaction = true;
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (matchingCount() <= countBefore || !noSidecars(databasePath)) return denied();

    // All checks, including current roles and the source-byte fingerprint,
    // occur under the same SQLite RESERVED write lock.
    const preflight = inspectIsolatedTargetStore({
      stagingDirectory: directory,
      expectedRestoreGeneration: store.expectedRestoreGeneration,
      mode: "r2-model",
    }, { db, fd: databaseFd });
    if (!preflight.ok) return denied();
    const actor = verifiedActor(db, access);
    if (!actor) return denied();
    if (!canEditIsolatedTargetTaskTitle(db, actor, request.taskId)) {
      return { ok: false, reason: "unavailable" };
    }
    if (fingerprint(databaseFd) !== request.expectedRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    const updated = db.prepare("UPDATE tasks SET title=? WHERE id=?")
      .run(request.title, request.taskId);
    if (updated.changes !== 1) return failed();
    db.exec("COMMIT");
    transaction = false;
    return { ok: true };
  } catch {
    return failed();
  } finally {
    if (db) {
      if (transaction) {
        try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
      }
      try { db.close(); } catch { /* fail closed */ }
    }
    if (databaseFd !== null) {
      try { closeSync(databaseFd); } catch { /* fail closed */ }
    }
    if (directoryFd !== null) {
      try { closeSync(directoryFd); } catch { /* fail closed */ }
    }
  }
}
