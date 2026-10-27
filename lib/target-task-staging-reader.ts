/**
 * R2 staging-only, preflight-gated entry point for isolated target task reads.
 *
 * The lower-level authenticated selectors intentionally take a DatabaseSync
 * handle and expect their trusted caller to preflight it. This facade enforces
 * that prerequisite and owns the read-only connection on every request.
 *
 * This is NOT a route, session issuer, sync API or activation flag. Only
 * server-controlled staging paths, generation values and signing keys belong
 * here; none may be populated from client request data.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TARGET_STORE_FILENAME, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import { withPinnedTargetSnapshot } from "./target-store-read-snapshot";
import {
  listAuthenticatedIsolatedTargetTasks, readAuthenticatedIsolatedTargetTask,
} from "./target-task-authenticated-read";
import type {
  AuthenticatedTargetTaskDetailResult, AuthenticatedTargetTaskListResult,
  TargetStagingReadCredential, TargetStagingTaskDetailRequest, TargetStagingTaskListRequest,
} from "./target-task-authenticated-read";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Trusted server configuration, not an object deserialized from HTTP input. */
export interface TargetStagingReadStore {
  stagingDirectory: string;
  expectedRestoreGeneration: string;
}

const deniedList = (): AuthenticatedTargetTaskListResult =>
  ({ ok: false, reason: "unauthorized", tasks: [], nextCursor: null });
const deniedDetail = (): AuthenticatedTargetTaskDetailResult =>
  ({ ok: false, reason: "unauthorized", task: null });

/**
 * Every call pins the isolated source database by a no-follow file descriptor,
 * starts a SQLite read transaction on the source, verifies that the actual
 * SQLite-opened file descriptor identifies that same source inode, and holds
 * the read lock while copying bytes from our pinned fd into a private snapshot.
 * SQLite reads task content ONLY from that private copy. Canonical preflight,
 * authentication and Area ACLs share the copied SQLite snapshot.
 *
 * All source/path/copy/open/preflight failures return a content-free denial.
 */
function noSidecars(databasePath: string): boolean {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
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
 * Node's SQLite API accepts only pathnames. SQLite may reopen paths after
 * resolving /proc/self/fd/N, so opening the source through that alias would
 * NOT prove the connection is using our pinned inode. Record pre-existing
 * handles, open a read-only SQLite connection, start a real SHARED read
 * transaction and verify the new underlying SQLite handle's inode.
 *
 * We deliberately fail closed if descriptor enumeration is unavailable.
 * The transaction blocks rollback-journal writers from spilling pages into
 * the main database while we copy its bytes outside SQLite.
 */
function withPinnedSourceReadLock<T>(
  databasePath: string,
  descriptorRoot: string,
  sourceFd: number,
  read: () => T,
): T {
  const alreadyOpen = new Set(readdirSync(descriptorRoot));
  const sourceDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    sourceDb.exec("PRAGMA query_only = ON");
    sourceDb.exec("BEGIN");
    // BEGIN alone is deferred; an actual SELECT acquires SQLite's SHARED lock.
    sourceDb.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    const original = fstatSync(sourceFd);
    const matchingSQLiteFd = readdirSync(descriptorRoot).some(name => {
      if (alreadyOpen.has(name) || !/^[0-9]+$/.test(name)) return false;
      try {
        const opened = fstatSync(Number(name));
        return opened.isFile() && opened.dev === original.dev && opened.ino === original.ino;
      } catch {
        return false; // Descriptors opened by enumeration itself may close.
      }
    });
    if (!matchingSQLiteFd) throw new Error("Source SQLite file identity mismatch");
    return read();
  } finally {
    try { sourceDb.exec("ROLLBACK"); } catch { /* fail closed at caller */ }
    sourceDb.close();
  }
}

function withPreflightedStore<T>(
  store: TargetStagingReadStore,
  denied: () => T,
  query: (db: DatabaseSync, preflight: (db: DatabaseSync) => boolean) => T,
): T {
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string" ||
      !UUID_PATTERN.test(store.expectedRestoreGeneration)) return denied();

  // Resolve the source under an opened directory descriptor. This is a source
  // copy only: SQLite never opens or follows the original staging pathname.
  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd"
    : process.platform === "darwin" ? "/dev/fd" : null;
  if (!descriptorRoot || constants.O_NOFOLLOW === undefined ||
      constants.O_DIRECTORY === undefined) return denied();

  try {
    const directory = verifyExistingTargetStagingPath(store.stagingDirectory);
    const directoryFd = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (realpathSync(`${descriptorRoot}/${directoryFd}`) !== directory) return denied();
      const databasePath = path.join(directory, TARGET_STORE_FILENAME);
      const file = lstatSync(databasePath);
      if (!file.isFile() || file.isSymbolicLink() || !noSidecars(databasePath)) return denied();

      const databaseFd = openSync(`${descriptorRoot}/${directoryFd}/${TARGET_STORE_FILENAME}`,
        constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(databaseFd);
        if (!opened.isFile() || opened.nlink !== 1 ||
            opened.dev !== file.dev || opened.ino !== file.ino) return denied();

        return withPinnedSourceReadLock(databasePath, descriptorRoot, databaseFd, () => {
          // Keep the source SQLite SHARED lock across the raw descriptor copy.
          // A writer transaction (and any hot rollback journal) must deny reads.
          if (!noSidecars(databasePath)) return denied();
          return withPinnedTargetSnapshot(databaseFd, (snapshotDirectory, snapshotFd) => {
            if (!noSidecars(databasePath)) return denied();
            const db = new DatabaseSync(path.join(snapshotDirectory, TARGET_STORE_FILENAME),
              { readOnly: true });
            try {
              db.exec("PRAGMA query_only = ON");
              const preflight = (readDb: DatabaseSync) => inspectIsolatedTargetStore({
                stagingDirectory: snapshotDirectory,
                expectedRestoreGeneration: store.expectedRestoreGeneration,
                mode: "r2-model",
              }, { db: readDb, fd: snapshotFd }).ok;
              return query(db, preflight);
            } finally {
              db.close();
            }
          });
        });
      } finally {
        closeSync(databaseFd);
      }
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    return denied();
  }
}

/** Request inputs contain only the selected scope and pagination, never an actor. */
export function listPreflightedIsolatedTargetTasks(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskListRequest,
): AuthenticatedTargetTaskListResult {
  return withPreflightedStore(store, deniedList, (db, preflight) =>
    listAuthenticatedIsolatedTargetTasks(db, access, request, preflight));
}

/** Detail reads receive the same preflight and live membership enforcement. */
export function readPreflightedIsolatedTargetTask(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDetailRequest,
): AuthenticatedTargetTaskDetailResult {
  return withPreflightedStore(store, deniedDetail, (db, preflight) =>
    readAuthenticatedIsolatedTargetTask(db, access, request, preflight));
}
