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
import { checkTargetStagingJournal, warmTargetStagingJournal } from "./target-staging-anchor-journal";
import { withPinnedTargetSnapshot } from "./target-store-read-snapshot";
import {
  listAuthenticatedIsolatedTargetTasks, listAuthenticatedIsolatedTargetTasksAtOffset,
  inReadSnapshot, readAuthenticatedIsolatedTargetTask, verifiedActor,
} from "./target-task-authenticated-read";
import {
  personalTaskListRevision, readIsolatedTargetTask, readPrivateTaskTitleAudit,
  readScopedTaskOffsetPage, readSharedTargetTask,
} from "./target-task-read-model";
import type {
  TargetPrivateTaskTitleAuditResult, TargetReadLinearization, TargetScopedOffsetPage,
  TargetScopedReadableTask,
} from "./target-task-read-model";
import { readChangeFeedPage } from "./target-change-feed-read-model";
import type { TargetChangeFeedResult } from "./target-change-feed-read-model";
import type { FeedClaims } from "./target-staging-feed-cursor";
import { readPrivateProjectsAtOffset, readPrivateProjectById } from "./target-project-read-model";
import { readAuthorizedProjectTasksPage } from "./target-project-task-read-model";
import { readAuthorizedProjectIndexPage } from "./target-authorized-project-index";
import { readAuthorizedTargetNote } from "./target-note-access";
import { readTargetNoteEditCommandStatus, type TargetNoteEditCommandStatus } from "./target-note-command-status";
import { validTargetStagingNoteEditRequest, type TargetStagingNoteEditRequest } from "./target-note-staging-writer";
import type { TargetAuthorizedNote } from "./target-note-access";
import type { TargetAuthorizedProjectIndexPage, TargetProjectIndexScope } from "./target-authorized-project-index";
import type { TargetAuthorizedProjectTasksResult } from "./target-project-task-read-model";
import type { TargetPrivateProjectPage, TargetReadableProject } from "./target-project-read-model";
import type { TargetReadableTask, TargetTaskOffsetListResult, TargetTaskScope } from "./target-task-read-model";
import { canEditIsolatedTargetTaskTitle, checkTargetTaskWriteContract, targetTaskTitleEditRevision, validTargetTaskTitleEditPreviewRequest } from "./target-task-write-preflight";
import {
  targetTaskTitleReceiptDigest, targetTaskTitleReceiptKey, validTargetStagingTaskTitleWriteRequest,
} from "./target-task-staging-writer";
import type { TargetStagingTaskTitleWriteRequest } from "./target-task-staging-writer";
import {
  validTargetStagingTaskDeleteRequest, verifyTargetTaskDeleteCommand,
} from "./target-task-delete-writer";
import type {
  TargetStagingTaskDeleteRequest, TargetStagingTaskDeleteStatusResult,
} from "./target-task-delete-writer";
import type { TargetTaskTitleEditPreviewRequest, TargetTaskTitleEditPreviewResult } from "./target-task-write-preflight";
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
  const original = fstatSync(sourceFd);
  const matchingHandleCount = (): number => readdirSync(descriptorRoot).reduce((count, name) => {
    if (!/^[0-9]+$/.test(name)) return count;
    try {
      const opened = fstatSync(Number(name));
      return count + Number(opened.isFile() &&
        opened.dev === original.dev && opened.ino === original.ino);
    } catch {
      return count; // The directory enumeration fd has already closed.
    }
  }, 0);
  const countBeforeSQLiteOpen = matchingHandleCount();
  const sourceDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    sourceDb.exec("PRAGMA query_only = ON");
    sourceDb.exec("BEGIN");
    // BEGIN alone is deferred; an actual SELECT acquires SQLite's SHARED lock.
    sourceDb.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    // Comparing only descriptor numbers is unsafe: readdirSync() temporarily
    // opens the fd directory, and SQLite can reuse that just-closed fd number.
    // Instead demand a net new open handle to the *pinned inode*.
    if (matchingHandleCount() <= countBeforeSQLiteOpen) {
      throw new Error("Source SQLite file identity mismatch");
    }
    return read();
  } finally {
    try { sourceDb.exec("ROLLBACK"); } catch { /* fail closed at caller */ }
    sourceDb.close();
  }
}

function withPreflightedStore<T>(
  store: TargetStagingReadStore,
  denied: () => T,
  query: (db: DatabaseSync, preflight: (db: DatabaseSync) => boolean, revision: string) => T,
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

        // Cold chain verification before the SHARED lock (see warmTargetStagingJournal).
        warmTargetStagingJournal(`${descriptorRoot}/${directoryFd}`, store.expectedRestoreGeneration);
        return withPinnedSourceReadLock(databasePath, descriptorRoot, databaseFd, () => {
          // Keep the source SQLite SHARED lock across the raw descriptor copy.
          // A writer transaction (and any hot rollback journal) must deny reads.
          if (!noSidecars(databasePath)) return denied();
          return withPinnedTargetSnapshot(databaseFd, (snapshotDirectory, snapshotFd, revision) => {
            if (!noSidecars(databasePath)) return denied();
            const db = new DatabaseSync(path.join(snapshotDirectory, TARGET_STORE_FILENAME),
              { readOnly: true });
            try {
              db.exec("PRAGMA query_only = ON");
              // R2c.4a: the copy was taken under the SHARED lock held by this callback, which
              // excludes any commit, so the snapshot anchor and the journal read here are
              // exact. A rolled-back or unverifiable store serves no data.
              const anchorRaw = (db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'")
                .get() as { value: unknown } | undefined)?.value;
              if (checkTargetStagingJournal(`${descriptorRoot}/${directoryFd}`, anchorRaw,
                  store.expectedRestoreGeneration) !== "ok") return denied();
              const preflight = (readDb: DatabaseSync) => inspectIsolatedTargetStore({
                stagingDirectory: snapshotDirectory,
                expectedRestoreGeneration: store.expectedRestoreGeneration,
                mode: "r2-model",
              }, { db: readDb, fd: snapshotFd }).ok;
              return query(db, preflight, revision);
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

/** HTTP owner-only selector: private scope is enforced inside authenticated SQL. */
export function readPreflightedIsolatedPersonalTargetTask(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDetailRequest,
): AuthenticatedTargetTaskDetailResult {
  return withPreflightedStore(store, deniedDetail, (db, preflight) =>
    readAuthenticatedIsolatedTargetTask(db, access, request, preflight, true));
}

/** Owner-private detail and title CAS token from one preflighted read transaction. */
export type TargetPreflightedPersonalTaskDetail =
  | { ok: true; task: TargetReadableTask; snapshotRevision: string }
  | { ok: false; reason: "unauthorized" | "invalid_request" | "unavailable" | "query_failed"; task: null };

export function readPreflightedPersonalTargetTaskWithRevision(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDetailRequest,
): TargetPreflightedPersonalTaskDetail {
  const denied = (): TargetPreflightedPersonalTaskDetail =>
    ({ ok: false, reason: "unauthorized", task: null });
  return withPreflightedStore<TargetPreflightedPersonalTaskDetail>(store, denied,
    (db, preflight) => inReadSnapshot<TargetPreflightedPersonalTaskDetail>(db, () => {
      if (!request || typeof request !== "object" ||
          Object.keys(request).sort().join(",") !== "taskId" ||
          !preflight(db)) return denied();
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return denied();
      const detail = readIsolatedTargetTask(db, { actorUserId, taskId: request.taskId }, true);
      if (detail.ok === false) return { ok: false, reason: detail.reason, task: null };
      // A readable task alone is insufficient: the token is a CAS precondition,
      // not authorization, so require the current private write ACL as well.
      if (!canEditIsolatedTargetTaskTitle(db, actorUserId, request.taskId, true)) {
        return { ok: false, reason: "unavailable", task: null };
      }
      const snapshotRevision = targetTaskTitleEditRevision(db, request.taskId);
      return snapshotRevision
        ? { ok: true, task: detail.task, snapshotRevision }
        : denied();
    }, denied));
}

/**
 * Revision-bound page reads for the staging-only session authority.
 *
 * The digest describes the exact, preflighted SQLite bytes from which this
 * page was selected, not a client-supplied revision. No digest is returned
 * for unauthorized or otherwise denied reads. The authority compares it
 * against the signed previous-page cursor and discards any stale page.
 */
export interface RevisionedTargetTaskList {
  readonly result: AuthenticatedTargetTaskListResult;
  readonly revision: string | null;
}

export function listRevisionedPreflightedIsolatedTargetTasks(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskListRequest,
): RevisionedTargetTaskList {
  return withPreflightedStore(store,
    () => ({ result: deniedList(), revision: null }),
    (db, preflight, revision) => {
      const result = listAuthenticatedIsolatedTargetTasks(db, access, request, preflight);
      return { result, revision: result.ok ? revision : null };
    });
}

/**
 * Offset is supplied only by the in-process session authority after HMAC
 * verification. Personal pages use an ACL-scoped revision (also exposed by
 * the HTTP cursor); other internal scopes retain the pinned-file revision.
 */
export interface RevisionedTargetTaskOffsetList {
  readonly result: TargetTaskOffsetListResult |
    { ok: false; reason: "unauthorized"; tasks: []; hasMore: false };
  readonly revision: string | null;
}

export function listRevisionedPreflightedIsolatedTargetTasksAtOffset(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: { scope: TargetTaskScope; limit?: number; offset: number },
): RevisionedTargetTaskOffsetList {
  return withPreflightedStore(store,
    () => ({ result: { ok: false, reason: "unauthorized", tasks: [], hasMore: false },
      revision: null } as RevisionedTargetTaskOffsetList),
    (db, preflight, revision) => {
      const result = listAuthenticatedIsolatedTargetTasksAtOffset(db, access, request, preflight);
      if (!result.ok) return { result, revision: null };
      // HTTP exposes this revision in a signed (but decodable) cursor. Only
      // hash this actor's ACL-visible private tasks; changes to a different
      // owner's private or shared tasks must not leak through cursor staleness.
      // The copied DB is private and read-only, so both queries see the same
      // state even though the authenticated selector owns its transaction.
      const scopedRevision = request.scope === "personal"
        ? personalTaskListRevision(db, verifiedActor(db, access) ?? "")
        : revision;
      return { result, revision: scopedRevision };
    });
}


/**
 * Dry-run per-item write authorization on a pinned preflighted snapshot. The
 * returned SHA-256 covers this task and its Area policy revision, not every
 * SQLite byte. The snapshotRevision name is a staging compatibility alias. No source database write or new route.
 * Actual mutations must independently recheck ACL + revision in a write TX.
 */
export function previewPreflightedTargetTaskTitleEdit(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetTaskTitleEditPreviewRequest,
  privateOnly = false,
): TargetTaskTitleEditPreviewResult {
  return withPreflightedStore<TargetTaskTitleEditPreviewResult>(
    store,
    () => ({ ok: false, reason: "unauthorized", snapshotRevision: null }),
    (db, preflight): TargetTaskTitleEditPreviewResult => {
      const denied = (): TargetTaskTitleEditPreviewResult =>
        ({ ok: false, reason: "unauthorized", snapshotRevision: null });
      if (!validTargetTaskTitleEditPreviewRequest(request)) {
        return { ok: false, reason: "invalid_request", snapshotRevision: null };
      }
      // The source fd, copied bytes, opened SQLite connection and canonical
      // preflight all originate within this private withPreflightedStore scope.
      // No public selector can mix db from one store with another store's fd.
      return inReadSnapshot(db, () => {
        if (!preflight(db)) return denied();
        const actor = verifiedActor(db, access);
        if (!actor) return denied();
        // Always check live ACL before comparing revisions, so inaccessible
        // tasks disclose neither existence nor staleness.
        if (!canEditIsolatedTargetTaskTitle(db, actor, request.taskId, privateOnly)) {
          return { ok: false, reason: "unavailable", snapshotRevision: null };
        }
        const revision = targetTaskTitleEditRevision(db, request.taskId);
        if (!revision) return denied();
        if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
          return { ok: false, reason: "stale_revision", snapshotRevision: null };
        }
        return { ok: true, snapshotRevision: revision };
      }, denied);
    },
  );
}


/**
 * Staging-only reconciliation after an uncertain title-write response.
 *
 * A "committed" result acknowledges the original command, NOT that its title
 * is still the task's current title. "not_recorded" never authorizes retry:
 * callers must still use the full write command with live ACL and revision CAS.
 * The owner-private HTTP facade is staging-only; there is no production
 * identity bridge or client-side cache.
 */
export type TargetStagingTaskTitleCommandStatusResult =
  | { ok: true; status: "committed" | "not_recorded" }
  | { ok: false; reason: "invalid_request" | "unauthorized" | "unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch" };

/**
 * Access requires a *current writable session*, the current task's write ACL,
 * and the exact original command payload. Every lookup uses a canonical,
 * pinned, read-only copy and a single authenticated SQLite snapshot.
 *
 * In particular, the commandId alone is NOT a capability or task locator.
 */
export function readPreflightedTargetTaskTitleCommandStatus(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskTitleWriteRequest,
  privateOnly = false,
): TargetStagingTaskTitleCommandStatusResult {
  if (!validTargetStagingTaskTitleWriteRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  const denied = (): TargetStagingTaskTitleCommandStatusResult =>
    ({ ok: false, reason: "unauthorized" });
  return withPreflightedStore<TargetStagingTaskTitleCommandStatusResult>(
    store, denied, (db, preflight) => inReadSnapshot(db, () => {
      if (!preflight(db)) return denied();
      const actor = verifiedActor(db, access, true);
      if (!actor) return denied();
      // Recheck current Area membership before even querying the receipt so a
      // former editor cannot infer whether an old command was committed.
      const contract = checkTargetTaskWriteContract(db, actor, request, privateOnly);
      if (contract.ok === false) return { ok: false, reason: contract.reason };
      const row = db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(targetTaskTitleReceiptKey(actor, request.taskId, request.commandId)) as
        { value: string } | undefined;
      if (!row) return { ok: true, status: "not_recorded" };
      if (row.value !== targetTaskTitleReceiptDigest(request)) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      return { ok: true, status: "committed" };
    }, denied),
  );
}


/**
 * R2d.2c.2e: a canonical pinned snapshot checks the actor's current WRITE
 * right and the exact original command before reading the opaque receipt.
 * The HTTP gateway separately rechecks the live note guard before releasing.
 */
export function readPreflightedTargetNoteEditCommandStatus(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  request: TargetStagingNoteEditRequest,
): TargetNoteEditCommandStatus | { ok: false; reason: "unauthorized" } {
  if (!validTargetStagingNoteEditRequest(request))
    return { ok: false, reason: "invalid_request" };
  const denied = () => ({ ok: false as const, reason: "unauthorized" as const });
  return withPreflightedStore<TargetNoteEditCommandStatus | { ok: false; reason: "unauthorized" }>(
    store, denied, (db, preflight) =>
      inReadSnapshot<TargetNoteEditCommandStatus | { ok: false; reason: "unauthorized" }>(
        db, () => {
          if (!preflight(db)) return denied();
          const actor = verifiedActor(db, access, true);
          if (!actor) return denied();
          return readTargetNoteEditCommandStatus(db, actor, request);
        }, denied));
}

/**
 * R2c.1 read-only reconciliation of an uncertain task-delete response. Same
 * pinned, canonical, single-snapshot read as the title status; the verification
 * itself (current write right in the task's or its tombstone's Area, plus the
 * actor's own receipt) lives with the delete command.
 */
export function readPreflightedTargetTaskDeleteCommandStatus(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingTaskDeleteRequest,
  privateOnly = false,
): TargetStagingTaskDeleteStatusResult {
  if (!validTargetStagingTaskDeleteRequest(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  const denied = (): TargetStagingTaskDeleteStatusResult =>
    ({ ok: false, reason: "unauthorized" });
  return withPreflightedStore<TargetStagingTaskDeleteStatusResult>(
    store, denied, (db, preflight) => inReadSnapshot(db, () => {
      if (!preflight(db)) return denied();
      const actor = verifiedActor(db, access, true);
      if (!actor) return denied();
      return verifyTargetTaskDeleteCommand(db, actor, request, privateOnly);
    }, denied),
  );
}

/** Owner-cookie HTTP facade: server-owned actor, one canonical private snapshot. */
export function listPreflightedPrivateProjectsAtOffset(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  limit: number, offset: number,
): TargetPrivateProjectPage | null {
  return withPreflightedStore(store, () => null, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      return readPrivateProjectsAtOffset(
        db, actorUserId, store.expectedRestoreGeneration, limit, offset,
      );
    }, () => null));
}

/** Authenticated owner-private project detail; no existence signal crosses a failed preflight. */
export type TargetPreflightedPrivateProjectDetail =
  | { ok: true; project: TargetReadableProject }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export function readPreflightedPrivateProjectDetail(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, projectId: string,
): TargetPreflightedPrivateProjectDetail {
  const denied = (): TargetPreflightedPrivateProjectDetail =>
    ({ ok: false, reason: "unauthorized" });
  return withPreflightedStore<TargetPreflightedPrivateProjectDetail>(
    store, denied, (db, preflight) =>
      inReadSnapshot<TargetPreflightedPrivateProjectDetail>(db, (): TargetPreflightedPrivateProjectDetail => {
      if (!preflight(db)) return denied();
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return denied();
      const project = readPrivateProjectById(db, actorUserId, projectId);
      return project ? { ok: true, project } : { ok: false, reason: "unavailable" };
    }, denied),
  );
}

/**
 * R2-ID.2b scoped (shared / my-plan) page: one canonical pinned snapshot for
 * preflight, actor, rows, revision and the linearization record. The record is
 * what the HTTP route re-verifies against the LIVE store before release.
 */
export function readPreflightedScopedTaskPage(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  request: { scope: "shared" | "my-plan"; limit: number; offset: number },
): TargetScopedOffsetPage | null {
  return withPreflightedStore<TargetScopedOffsetPage | null>(store, () => null, (db, preflight) =>
    inReadSnapshot<TargetScopedOffsetPage | null>(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      return readScopedTaskOffsetPage(db, {
        actorUserId, scope: request.scope, limit: request.limit, offset: request.offset,
        restoreGeneration: store.expectedRestoreGeneration,
      });
    }, () => null));
}

/**
 * R2c.2a bootstrap / Area bootstrap / feed page: one canonical pinned snapshot for
 * preflight, actor, claim verification, rows and the linearization record. Cursor
 * failures are returned as results; a denied session or store yields null.
 */
export function readPreflightedChangeFeedPage(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, claims: FeedClaims | null,
): TargetChangeFeedResult | null {
  return withPreflightedStore<TargetChangeFeedResult | null>(store, () => null, (db, preflight) =>
    inReadSnapshot<TargetChangeFeedResult | null>(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      return readChangeFeedPage(db, {
        actorUserId, restoreGeneration: store.expectedRestoreGeneration, claims,
      });
    }, () => null));
}

/**
 * Shared-Area task detail for a current member of any role (R2-ID.2b). R2-ID.3:
 * `snapshotRevision` (the title CAS token) is present ONLY when the actor may
 * currently write the task (editor/admin), computed in the same pinned
 * snapshot as the task row and linearization record. Viewers never get it.
 */
export type TargetPreflightedSharedTaskDetail =
  | { ok: true; task: TargetScopedReadableTask; linearization: TargetReadLinearization;
      snapshotRevision?: string }
  | { ok: false; reason: "unavailable" | "query_failed" };

export function readPreflightedSharedTargetTask(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, taskId: string,
): TargetPreflightedSharedTaskDetail | null {
  return withPreflightedStore<TargetPreflightedSharedTaskDetail | null>(store, () => null, (db, preflight) =>
    inReadSnapshot<TargetPreflightedSharedTaskDetail | null>(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      const detail = readSharedTargetTask(db, { actorUserId, taskId });
      if (!detail.ok) return detail;
      const writable = detail.linearization.areas.length === 1 &&
        (detail.linearization.areas[0].access === "editor" || detail.linearization.areas[0].access === "admin") &&
        canEditIsolatedTargetTaskTitle(db, actorUserId, taskId, false);
      if (!writable) return detail;
      // A null token for a task just proven writable can only be a query failure:
      // fail closed (null -> 503) rather than return a token-less DTO that would
      // look like a read-only task.
      const snapshotRevision = targetTaskTitleEditRevision(db, taskId);
      return snapshotRevision ? { ...detail, snapshotRevision } : null;
    }, () => null));
}

/** Owner-private task audit timeline: authenticate, preflight and enforce the
 * task's *current* private Area ACL on the same pinned read-only snapshot. */
export function readPreflightedPrivateTaskTitleAudit(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  taskId: string,
): TargetPrivateTaskTitleAuditResult {
  const denied = (): TargetPrivateTaskTitleAuditResult =>
    ({ ok: false, reason: "query_failed" });
  return withPreflightedStore<TargetPrivateTaskTitleAuditResult>(
    store, denied, (db, preflight) =>
      inReadSnapshot<TargetPrivateTaskTitleAuditResult>(db, () => {
        if (!preflight(db)) return denied();
        const actorUserId = verifiedActor(db, access);
        if (!actorUserId) return denied();
        return readPrivateTaskTitleAudit(db, actorUserId, taskId,
          store.expectedRestoreGeneration);
      }, denied),
  );
}



/**
 * R2d.1a project + inherited task page on ONE authenticated, pinned snapshot.
 * HTTP must perform a live Area read-linearization check on successful results.
 */
export function readPreflightedAuthorizedProjectTasks(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  projectId: string, limit: number, offset: number,
): TargetAuthorizedProjectTasksResult | null {
  return withPreflightedStore<TargetAuthorizedProjectTasksResult | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<TargetAuthorizedProjectTasksResult | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        if (!actorUserId) return null;
        return readAuthorizedProjectTasksPage(db, {
          actorUserId, projectId, limit, offset,
          restoreGeneration: store.expectedRestoreGeneration,
        });
      }, () => null),
  );
}

/** R2d.1b: authenticated project list, pinned/preflighted once per page. */
export function readPreflightedAuthorizedProjectIndex(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  scope: TargetProjectIndexScope, limit: number, offset: number,
): TargetAuthorizedProjectIndexPage | null {
  return withPreflightedStore<TargetAuthorizedProjectIndexPage | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<TargetAuthorizedProjectIndexPage | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId ? readAuthorizedProjectIndexPage(db, {
          actorUserId, scope, limit, offset,
          restoreGeneration: store.expectedRestoreGeneration,
        }) : null;
      }, () => null),
  );
}

/** R2d.2c.2c: exact actor-scoped note, same preflighted pinned snapshot as tasks/projects. */
export function readPreflightedAuthorizedTargetNote(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, noteId: string,
): TargetAuthorizedNote | null {
  return withPreflightedStore<TargetAuthorizedNote | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<TargetAuthorizedNote | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId ? readAuthorizedTargetNote(db, { actorUserId, noteId }) : null;
      }, () => null),
  );
}
