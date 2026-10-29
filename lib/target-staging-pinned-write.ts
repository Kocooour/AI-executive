/**
 * R2 staging-only pinned-file write transaction, shared by every staging writer
 * (task title, durable session issuance and revocation). Not a route and not a
 * production VFS.
 *
 * Node SQLite cannot attach to a pinned fd. Hold a no-follow source fd and
 * fail closed unless the SQLite open adds exactly one regular-file descriptor
 * matching that inode. This is only a staging best-effort check, not a
 * production-safe fd-backed VFS or protection against hostile FD/path races.
 * BEGIN IMMEDIATE serializes writers; canonical preflight runs inside it.
 * Any failure or an un-committed body rolls back.
 */
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TARGET_STORE_FILENAME, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingPinnedWriteContext {
  readonly db: DatabaseSync;
  readonly databaseFd: number;
  readonly directory: string;
  readonly databasePath: string;
  /** Path still names the pinned inode (no swap, hard link or symlink). */
  stillPinned(): boolean;
  /** No -journal/-shm/-wal sidecar exists next to the pinned database. */
  noSidecars(): boolean;
  /** Commit. A body that returns without calling this is rolled back. */
  commit(): void;
}

export function noTargetStagingSidecars(databasePath: string): boolean {
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

/**
 * Establish the pinned connection, take the RESERVED write lock, run the
 * canonical r2-model preflight on that very connection, then call body. The
 * caller cannot supply a DatabaseSync, file descriptor or generation.
 * `denied` is returned for every boundary failure, `failed` for any exception.
 */
export function withPinnedTargetStagingWrite<T>(
  store: TargetStagingReadStore,
  body: (context: TargetStagingPinnedWriteContext) => T,
  denied: () => T,
  failed: () => T,
  /** Bounded lock wait for short control-plane writes; the title writer fails fast (0). */
  busyTimeoutMs = 0,
): T {
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
    if (!info.isFile() || info.isSymbolicLink() || !noTargetStagingSidecars(databasePath)) return denied();
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
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 10_000) return denied();
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE`);
    transaction = true;
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    const newlyOpened = [...regularFiles()].filter(([fd]) => !beforeOpen.has(fd));
    if (newlyOpened.length !== 1 ||
        newlyOpened[0][1].dev !== pinned.dev ||
        newlyOpened[0][1].ino !== pinned.ino ||
        !stillPinned() || !noTargetStagingSidecars(databasePath)) return denied();

    // All checks, including current roles and the pinned source integrity check,
    // occur under the same SQLite RESERVED write lock.
    const preflight = inspectIsolatedTargetStore({
      stagingDirectory: directory,
      expectedRestoreGeneration: store.expectedRestoreGeneration,
      mode: "r2-model",
    }, { db, fd: databaseFd });
    if (!preflight.ok) return denied();
    const connection = db;
    return body({
      db: connection, databaseFd, directory, databasePath, stillPinned,
      noSidecars: () => noTargetStagingSidecars(databasePath),
      commit: () => { connection.exec("COMMIT"); transaction = false; },
    });
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
