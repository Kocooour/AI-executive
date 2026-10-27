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
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TARGET_STORE_FILENAME, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
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
 * Every call pins the isolated directory and database by file descriptor and
 * opens SQLite through that descriptor. This prevents path/symlink replacement
 * between the path check and SQLite open. Canonical preflight, authentication,
 * generation, and live Area ACLs execute within one SQLite read transaction.
 *
 * All preflight/path/open failures return the same content-free denial.
 */
function withPreflightedStore<T>(
  store: TargetStagingReadStore,
  denied: () => T,
  query: (db: DatabaseSync, preflight: (db: DatabaseSync) => boolean) => T,
): T {
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string" ||
      !UUID_PATTERN.test(store.expectedRestoreGeneration)) return denied();

  // These paths refer to already-opened descriptors, not mutable staging names.
  // On unsupported platforms, refuse reads rather than fall back to racy opens.
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
      if (!file.isFile() || file.isSymbolicLink()) return denied();

      const databaseFd = openSync(`${descriptorRoot}/${directoryFd}/${TARGET_STORE_FILENAME}`,
        constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(databaseFd).isFile()) return denied();
        const db = new DatabaseSync(`${descriptorRoot}/${databaseFd}`, { readOnly: true });
        try {
          db.exec("PRAGMA query_only = ON");
          const preflight = (readDb: DatabaseSync) => inspectIsolatedTargetStore({
            stagingDirectory: directory,
            expectedRestoreGeneration: store.expectedRestoreGeneration,
            mode: "r2-model",
          }, { db: readDb, fd: databaseFd }).ok;
          return query(db, preflight);
        } finally {
          db.close();
        }
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
