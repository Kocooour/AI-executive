/**
 * R2 staging-only single-task title mutation. Not a route, sync command or
 * production writer; the only supported entry is a session-bound authority.
 *
 * Node SQLite cannot attach to a pinned fd. Hold a no-follow source fd and
 * fail closed unless the SQLite open adds exactly one regular-file descriptor
 * matching that inode. This is only a staging best-effort check, not a
 * production-safe fd-backed VFS or protection against hostile FD/path races.
 * BEGIN IMMEDIATE serializes writers across revision, ACL and UPDATE.
 * Any failure rolls back; a preview is never a write authorization capability.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TARGET_STORE_FILENAME, TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_RECEIPT_PREFIX, verifyExistingTargetStagingPath,
} from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { canEditIsolatedTargetTaskTitle, targetTaskTitleEditRevision, validTargetTaskTitleEditPreviewRequest } from "./target-task-write-preflight";

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 64 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_TITLE_LENGTH = 4096;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingTaskTitleWriteRequest {
  /** Fresh UUID for the logical command. Retries must reuse the same UUID. */
  readonly commandId: string;
  readonly taskId: string;
  readonly title: string;
  /** Mandatory task + policy SHA-256 returned by the staging preview. */
  readonly expectedRevision: string;
}

export type TargetStagingTaskTitleWriteResult =
  | { ok: true; replayed?: true }
  | { ok: false;
      reason: "invalid_request" | "unauthorized" | "unavailable" |
        "stale_revision" | "unchanged" | "idempotency_conflict" | "write_failed" };

const denied = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingTaskTitleWriteResult =>
  ({ ok: false, reason: "write_failed" });

export function validTargetStagingTaskTitleWriteRequest(
  value: unknown,
): value is TargetStagingTaskTitleWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "commandId,expectedRevision,taskId,title" ||
      typeof input.commandId !== "string" || !COMMAND_ID.test(input.commandId)) return false;
  if (typeof input.expectedRevision !== "string" ||
      !validTargetTaskTitleEditPreviewRequest({
        taskId: input.taskId, expectedRevision: input.expectedRevision,
      })) return false;
  return typeof input.title === "string" &&
    input.title.length > 0 && input.title.length <= MAX_TITLE_LENGTH &&
    input.title.trim().length > 0 && input.title.trim() === input.title &&
    !input.title.includes("\0");
}

/**
 * Opaque actor- and task-scoped command key. One command UUID is unique for
 * one actor/task pair, so a revoked task's receipt cannot be queried by
 * replacing its taskId with another editable task.
 *
 * The v2 namespace prevents unsafe reuse of the old actor-only receipts.
 */
export function targetTaskTitleReceiptKey(actor: string, taskId: string, commandId: string): string {
  return TARGET_STAGING_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify([actor, taskId, commandId.toLowerCase()])).digest("hex");
}

/** Digest exact request semantics, including the preview revision. */
export function targetTaskTitleReceiptDigest(request: TargetStagingTaskTitleWriteRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.taskId, request.title, request.expectedRevision]))
    .digest("hex");
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
    // Only the bootstrap-created private staging directory is writable. Never
    // open a path shared with a different user or a legacy production store.
    const stagingStat = fstatSync(directoryFd);
    if (!process.getuid || stagingStat.uid !== process.getuid() ||
        (stagingStat.mode & 0o077) !== 0) return denied();
    const databasePath = path.join(directory, TARGET_STORE_FILENAME);
    const info = lstatSync(databasePath);
    if (!info.isFile() || info.isSymbolicLink() || !noSidecars(databasePath)) return denied();
    databaseFd = openSync(descriptorRoot + "/" + directoryFd + "/" + TARGET_STORE_FILENAME,
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(databaseFd);
    if (!pinned.isFile() || pinned.nlink !== 1 ||
        pinned.dev !== info.dev || pinned.ino !== info.ino) return denied();
    // A WAL-mode source may create -wal/-shm on a writable SQLite open even
    // when no sidecars are present yet. Reject it from the pinned header first.
    const header = Buffer.alloc(20);
    if (readSync(databaseFd, header, 0, header.length, 0) !== header.length ||
        header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header[18] !== 1 || header[19] !== 1) return denied();

    // Observe newly opened *regular-file descriptors*, rather than accepting
    // a rising count of ANY descriptors pointing to the pinned inode. An
    // unexpected concurrent file open makes this staging mutation fail closed.
    // This does not solve arbitrary cross-process directory/path swapping:
    // fd-backed SQLite/VFS remains a prerequisite for production writes.
    const regularFiles = (): Map<number, { dev: number; ino: number }> => {
      const result = new Map<number, { dev: number; ino: number }>();
      for (const name of readdirSync(descriptorRoot)) {
        if (!/^[0-9]+$/.test(name)) continue;
        try {
          const fd = Number(name);
          const stat = fstatSync(fd);
          if (stat.isFile()) result.set(fd, { dev: stat.dev, ino: stat.ino });
        } catch { /* directory enumeration FD may close before fstat */ }
      }
      return result;
    };
    const stillPinned = (): boolean => {
      try {
        const current = lstatSync(databasePath);
        return current.isFile() && !current.isSymbolicLink() &&
          current.nlink === 1 && current.dev === pinned.dev && current.ino === pinned.ino;
      } catch { return false; }
    };
    const beforeOpen = regularFiles();
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    transaction = true;
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    const newlyOpened = [...regularFiles()].filter(([fd]) => !beforeOpen.has(fd));
    if (newlyOpened.length !== 1 ||
        newlyOpened[0][1].dev !== pinned.dev ||
        newlyOpened[0][1].ino !== pinned.ino ||
        !stillPinned() || !noSidecars(databasePath)) return denied();

    // All checks, including current roles and the pinned source integrity check,
    // occur under the same SQLite RESERVED write lock.
    const preflight = inspectIsolatedTargetStore({
      stagingDirectory: directory,
      expectedRestoreGeneration: store.expectedRestoreGeneration,
      mode: "r2-model",
    }, { db, fd: databaseFd });
    if (!preflight.ok) return denied();
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    if (!canEditIsolatedTargetTaskTitle(db, actor, request.taskId)) {
      return { ok: false, reason: "unavailable" };
    }
    // Persist the receipt in the *same transaction* as the UPDATE. The actor
    // and operation UUID are hashed into the key; only a request digest is
    // stored (never the title or task content). Replays are checked after the
    // current ACL, but before optimistic revision staleness.
    const receiptKey = targetTaskTitleReceiptKey(actor, request.taskId, request.commandId);
    const receiptDigest = targetTaskTitleReceiptDigest(request);
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(receiptKey) as { value: string } | undefined;
    if (prior) {
      return prior.value === receiptDigest
        ? { ok: true, replayed: true }
        : { ok: false, reason: "idempotency_conflict" };
    }
    // Keep the pinned-source read/identity check; unrelated SQLite changes
    // must not invalidate this task's optimistic CAS.
    fingerprint(databaseFd);
    if (targetTaskTitleEditRevision(db, request.taskId) !== request.expectedRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    // SQLite can count an UPDATE of the existing value as one changed row
    // without advancing the byte fingerprint. Never report such a no-op as
    // a successful mutation (revisions are optimistic checks, not one-shot IDs).
    const oldTitle = db.prepare("SELECT title FROM tasks WHERE id=?")
      .get(request.taskId) as { title: string } | undefined;
    if (!oldTitle) return failed();
    if (oldTitle.title === request.title) return { ok: false, reason: "unchanged" };
    if (!stillPinned() || !noSidecars(databasePath)) return denied();
    const receiptCount = db.prepare(
      "SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
    ).get(TARGET_STAGING_RECEIPT_PREFIX + "%") as { n: number };
    if (receiptCount.n >= TARGET_STAGING_MAX_RECEIPTS) return failed();
    const updated = db.prepare("UPDATE tasks SET title=? WHERE id=?")
      .run(request.title, request.taskId);
    if (updated.changes !== 1) return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
      .run(receiptKey, receiptDigest);
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
