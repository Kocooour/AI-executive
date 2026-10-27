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
import { lstatSync } from "node:fs";
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
 * A new read-only connection is used for each call so a previous request can
 * never retain a stale Area ACL snapshot. The selector independently checks
 * activation, schema metadata, actor and generation inside its read snapshot.
 *
 * All preflight/path/open failures return the same content-free denial.
 */
function withPreflightedStore<T>(
  store: TargetStagingReadStore,
  denied: () => T,
  query: (db: DatabaseSync) => T,
): T {
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string" ||
      !UUID_PATTERN.test(store.expectedRestoreGeneration)) return denied();

  try {
    const preflight = inspectIsolatedTargetStore({
      stagingDirectory: store.stagingDirectory,
      expectedRestoreGeneration: store.expectedRestoreGeneration,
      mode: "r2-model",
    });
    if (!preflight.ok) return denied();

    const directory = verifyExistingTargetStagingPath(store.stagingDirectory);
    const databasePath = path.join(directory, TARGET_STORE_FILENAME);
    const file = lstatSync(databasePath);
    if (!file.isFile() || file.isSymbolicLink()) return denied();

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON");
      return query(db);
    } finally {
      db.close();
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
  return withPreflightedStore(store, deniedList, db =>
    listAuthenticatedIsolatedTargetTasks(db, access, request));
}

/** Detail reads receive the same preflight and live membership enforcement. */
export function readPreflightedIsolatedTargetTask(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDetailRequest,
): AuthenticatedTargetTaskDetailResult {
  return withPreflightedStore(store, deniedDetail, db =>
    readAuthenticatedIsolatedTargetTask(db, access, request));
}
