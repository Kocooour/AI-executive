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
import { TARGET_STORE_FILENAME, TARGET_STORE_SCHEMA_VERSION, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
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
import { readAuthorizedProjectStructuralRelations, type TargetAuthorizedStructuralRelationsResult } from "./target-project-structural-relations";
import { readAuthorizedTargetParentBacklink, type TargetAuthorizedBacklink, type TargetBacklinkKind } from "./target-parent-backlinks";
import { readAuthorizedProjectIndexPage } from "./target-authorized-project-index";
import { readAuthorizedMyPlanHomeSummary, type AuthorizedMyPlanHomeSummary } from "./target-my-plan-home-summary";
import { readAuthorizedScopedHomeSummary, type AuthorizedScopedHomeSummary, type TargetHomeScope } from "./target-scoped-home-summary";
import { readAuthorizedTemporalTaskPage, readAuthorizedTemporalTaskDetail, readAuthorizedTemporalDueWindowPage, temporalCalendarOrdinal } from "./target-task-temporal-read-model";
import { readAuthorizedPersonalWhenPage } from "./target-personal-when-read-model";
import {readAuthorizedMyPlanDayTaskPage} from "./target-my-plan-day-task-read-model";
import {readAuthorizedAttentionCandidatePage} from "./target-attention-read-model";
import {readTargetAttentionProfileZone} from "./target-attention-profile-zone";
import type {AttentionCandidatePage,AttentionAreaFilter,AttentionView} from "./target-attention-read-model";
import {readAuthorizedGlobalTaskPage} from "./target-global-task-read-model";
import type {TargetGlobalTaskPage,TargetGlobalTaskScope} from "./target-global-task-read-model";
import {readAuthorizedGlobalProjectPage} from "./target-global-project-read-model";
import type {TargetGlobalProjectPage} from "./target-global-project-read-model";
import {readAuthorizedGlobalNotePage} from "./target-global-note-read-model";
import type {TargetGlobalNotePage} from "./target-global-note-read-model";
import {readAuthorizedGlobalCombinedPage} from "./target-global-combined-read-model";
import type {TargetGlobalCombinedPage,GlobalCombinedPositions} from "./target-global-combined-read-model";
import {readAuthorizedTitleSearchPage,type AuthorizedSearchPage} from "./target-authorized-title-search";
import type {MyPlanDayTaskPage,MyPlanTaskDayWindow,MyPlanTaskAreaFilter}
  from "./target-my-plan-day-task-read-model";
import {readAuthorizedPersonalWhenCommandPreview,
  type PersonalWhenCommandPreview} from "./target-personal-when-command-read";
import {personalWhenReceiptKey,personalWhenReceiptDigest,
  validTargetStagingPersonalWhenCommand,type TargetStagingPersonalWhenCommand,
} from "./target-personal-when-writer";
import type { PersonalWhenPage, PersonalWhenWindow } from "./target-personal-when-read-model";
import {readAuthorizedAttentionCommandPreview,attentionReceiptInSnapshot,
  type AttentionCommandPreview,type AttentionReceiptResult} from "./target-attention-command-read";
import {validTargetStagingAttentionLifecycleCommand,
  type TargetStagingAttentionLifecycleCommand,type TargetAttentionLifecycleRuleId}
  from "./target-attention-lifecycle-writer";
import type { TemporalScope, TemporalStatus, TemporalTaskPage, TemporalTaskDetail, TemporalDueWindow, TemporalDueWindowPage } from "./target-task-temporal-read-model";
import { readAuthorizedTargetNote } from "./target-note-access";
import { readAuthorizedTargetNoteSyncPage, type TargetNoteSyncPage } from "./target-note-sync-read-model";
import { evaluateTargetAreaPolicy } from "./target-area-policy";
import { readTargetNoteEditCommandStatus, type TargetNoteEditCommandStatus } from "./target-note-command-status";
import { readTargetNoteDeleteCommandStatus, type TargetNoteDeleteCommandStatus } from "./target-note-delete-command-status";
import { validTargetStagingNoteDeleteRequest, type TargetStagingNoteDeleteRequest } from "./target-note-delete-writer";
import {
  temporalStatusReceiptKey,temporalStatusReceiptDigest,
  validTargetStagingTemporalStatusCommand,
  type TargetStagingTemporalStatusCommand,
} from "./target-task-temporal-status-writer";
import {
  temporalDueOnReceiptKey,temporalDueOnReceiptDigest,
  validTargetStagingTemporalDueOnCommand,
  type TargetStagingTemporalDueOnCommand,
} from "./target-task-temporal-due-on-writer";
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


/** R2d.3e: pinned, canonical, authenticated v20 task temporal list. HTTP MUST
 * independently verify the returned Area witness on the live store. */
export function readPreflightedTemporalTaskPage(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: { scope: TemporalScope; status: TemporalStatus; limit: number; offset: number },
): TemporalTaskPage | null {
  return withPreflightedStore(store, () => null, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      return readAuthorizedTemporalTaskPage(db, {
        ...request, actorUserId, restoreGeneration: store.expectedRestoreGeneration,
      });
    }, () => null));
}

/** Staging-only due-date window; live Area witness must be verified by the
 * future HTTP layer before release. No personal planned-day interpretation. */
export function readPreflightedTemporalDueWindowPage(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: {
    scope: TemporalScope; window: TemporalDueWindow; evaluationDate: string;
    throughDate: string | null; limit: number; offset: number;
  },
): TemporalDueWindowPage | null {
  return withPreflightedStore(store, () => null, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return null;
      return readAuthorizedTemporalDueWindowPage(db, {
        ...request, actorUserId, restoreGeneration: store.expectedRestoreGeneration,
      });
    }, () => null));
}

/** R2d.3k.2: actor-only private planned-day read in one pinned snapshot.
 * Not an HTTP endpoint: private epoch and Area witness require a LIVE guard. */
export function readPreflightedPersonalWhenPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{window:PersonalWhenWindow;evaluationDate:string|null;
    throughDate:string|null;limit:number;offset:number},
):PersonalWhenPage|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedPersonalWhenPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** Staging-only task composition for the current actor's day.
 * Canonical pinned preflight + signed actor credential + one read snapshot;
 * a future HTTP adapter MUST verify the Area witness and private epoch live. */
export function readPreflightedMyPlanDayTaskPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{window:MyPlanTaskDayWindow;areaFilter:MyPlanTaskAreaFilter;
    evaluationDate:string;throughDate:string|null;limit:number;offset:number},
):MyPlanDayTaskPage|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedMyPlanDayTaskPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** R2d.5a: staging-only Attention candidates for the verified actor, one
 * pinned snapshot. R2d.4k: the evaluation zone is the actor's server-side
 * profile zone read in the SAME snapshot (fail closed); `notificationEpoch` is
 * the internal live-guard witness of that read. A future HTTP adapter MUST
 * verify session/Area/private epoch live. */
export type TargetAttentionProfilePage=AttentionCandidatePage&{notificationEpoch:number};
export function readPreflightedAttentionCandidatePage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{areaFilter:AttentionAreaFilter;view:AttentionView;evaluatedAtMs:number;
    limit:number;offset:number},
):TargetAttentionProfilePage|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      if(!actorUserId)return null;
      const zone=readTargetAttentionProfileZone(db,actorUserId);
      if(!zone)return null;
      const page=readAuthorizedAttentionCandidatePage(db,{
        ...request,timeZone:zone.timeZone,actorUserId,
        restoreGeneration:store.expectedRestoreGeneration,
      });
      return page?{...page,notificationEpoch:zone.notificationEpoch}:null;
    },()=>null));
}

/** R2d.5d.2: one preflighted, pinned read snapshot for staging-internal
 * notification work. The callback receives only the pinned snapshot handle; it
 * is responsible for binding any query to a server-verified identity (it never
 * receives client input). Returns null when the store is untrusted. */
export function readPreflightedStoreSnapshot<T>(
  store:TargetStagingReadStore,read:(db:DatabaseSync)=>T|null,
):T|null {
  return withPreflightedStore<T|null>(store,()=>null,(db,preflight)=>
    inReadSnapshot<T|null>(db,()=>preflight(db)?read(db):null,()=>null));
}

/** R3-slice/BE-02: both days from the SAME actor-bound, preflighted SQLite
 * read transaction. No independent snapshots can be accidentally composed. */
export function readPreflightedMyPlanTwoDayTaskPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{areaFilter:MyPlanTaskAreaFilter;evaluationDate:string;nextDate:string;
    limit:number;offsetToday:number;offsetTomorrow:number},
):{today:MyPlanDayTaskPage;tomorrow:MyPlanDayTaskPage}|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      if(!actorUserId)return null;
      const common={actorUserId,areaFilter:request.areaFilter,
        evaluationDate:request.evaluationDate,limit:request.limit,
        restoreGeneration:store.expectedRestoreGeneration};
      const today=readAuthorizedMyPlanDayTaskPage(db,{
        ...common,window:"today",throughDate:null,offset:request.offsetToday,
      });
      if(!today)return null;
      const tomorrow=readAuthorizedMyPlanDayTaskPage(db,{
        ...common,window:"upcoming",throughDate:request.nextDate,
        offset:request.offsetTomorrow,
      });
      // Dates are parsed by the canonical model. The child must not provide a
      // non-adjacent second day, even if both windows would otherwise be valid.
      const adjacent=temporalCalendarOrdinal(request.evaluationDate);
      const next=temporalCalendarOrdinal(request.nextDate);
      if(!tomorrow||adjacent===null||next===null||next-adjacent!==1||
        today.privateEpoch!==tomorrow.privateEpoch||
        JSON.stringify(today.linearization)!==JSON.stringify(tomorrow.linearization)||
        JSON.stringify(today.areaEpochs)!==JSON.stringify(tomorrow.areaEpochs))
        return null;
      return {today,tomorrow};
    },()=>null));
}

/** Actor-bound private plan preview. One pinned snapshot contains the task
 * policy witness, private epoch, per-item revision and existing value. */
export function readPreflightedPersonalWhenCommandPreview(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,taskId:string,
):PersonalWhenCommandPreview|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actor=verifiedActor(db,access);
      return actor?readAuthorizedPersonalWhenCommandPreview(
        db,actor,taskId,store.expectedRestoreGeneration):null;
    },()=>null));
}

/** Current-assignee/write-ACL-bound receipt check after uncertain HTTP commit.
 * The previous command's expected CAS is included in the receipt digest but
 * must not be rechecked against live revisions after the write. */
export type TargetPersonalWhenReceiptResult=
  | {ok:true;status:"committed"|"not_recorded"}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "idempotency_conflict"|"resync_required"|"write_area_mismatch"};
/** Shared receipt validation, always called from an already-pinned actor
 * snapshot. Never compare an old command CAS against revisions after commit. */
function personalWhenReceiptInSnapshot(
  db:DatabaseSync,actor:string,command:TargetStagingPersonalWhenCommand,
  restoreGeneration:string,preview?:PersonalWhenCommandPreview,
):TargetPersonalWhenReceiptResult {
  const check=checkTargetTaskWriteContract(db,actor,command);
  if(check.ok===false)return {ok:false,reason:check.reason};
  if(!preview&&!readAuthorizedPersonalWhenCommandPreview(
    db,actor,command.taskId,restoreGeneration))
    return {ok:false,reason:"unavailable"};
  const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(personalWhenReceiptKey(actor,command.taskId,command.commandId)) as
      {value:string}|undefined;
  if(!prior)return {ok:true,status:"not_recorded"};
  return prior.value===personalWhenReceiptDigest(command)
    ? {ok:true,status:"committed"}
    : {ok:false,reason:"idempotency_conflict"};
}

/** BE-06: actor-private scheduling witness and exact command receipt from
 * one canonical preflighted pinned transaction, including the private epoch. */
export type TargetPersonalWhenReceiptSnapshot=
  | {ok:true;preview:PersonalWhenCommandPreview;receipt:TargetPersonalWhenReceiptResult}
  | {ok:false;reason:"inaccessible"};

export function readPreflightedPersonalWhenReceiptSnapshot(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  command:TargetStagingPersonalWhenCommand,
):TargetPersonalWhenReceiptSnapshot {
  const denied=():TargetPersonalWhenReceiptSnapshot=>({ok:false,reason:"inaccessible"});
  if(!validTargetStagingPersonalWhenCommand(command))return denied();
  return withPreflightedStore<TargetPersonalWhenReceiptSnapshot>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if(!preflight(db))return denied();
      const actor=verifiedActor(db,access,true);
      if(!actor)return denied();
      const preview=readAuthorizedPersonalWhenCommandPreview(
        db,actor,command.taskId,store.expectedRestoreGeneration);
      if(!preview)return denied();
      const receipt=personalWhenReceiptInSnapshot(
        db,actor,command,store.expectedRestoreGeneration,preview);
      return {ok:true,preview,receipt};
    },denied));
}

export function readPreflightedPersonalWhenReceipt(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  command:TargetStagingPersonalWhenCommand,
):TargetPersonalWhenReceiptResult {
  if(!validTargetStagingPersonalWhenCommand(command))
    return {ok:false,reason:"invalid_request"};
  const denied=():TargetPersonalWhenReceiptResult=>({ok:false,reason:"unauthorized"});
  return withPreflightedStore<TargetPersonalWhenReceiptResult>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if(!preflight(db))return denied();
      const actor=verifiedActor(db,access,true);
      if(!actor)return denied();
      return personalWhenReceiptInSnapshot(
        db,actor,command,store.expectedRestoreGeneration);
    },denied));
}

/** R2d.5c.2: actor-bound Attention lifecycle preview. One pinned snapshot holds
 * the task policy witness, attention epoch, task revision and the raw state row. */
export function readPreflightedAttentionCommandPreview(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,taskId:string,
  ruleId:TargetAttentionLifecycleRuleId,occurrenceOn:string,nowMs:number,
):AttentionCommandPreview|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actor=verifiedActor(db,access);
      return actor?readAuthorizedAttentionCommandPreview(
        db,actor,taskId,ruleId,occurrenceOn,store.expectedRestoreGeneration,nowMs):null;
    },()=>null));
}

/** Receipt of an exact previous Attention command plus the live-release witness,
 * from one pinned snapshot; write ACL is checked BEFORE the receipt lookup. */
export type TargetAttentionReceiptSnapshot=
  | {ok:true;preview:AttentionCommandPreview;receipt:AttentionReceiptResult}
  | {ok:false;reason:"inaccessible"};
export function readPreflightedAttentionReceiptSnapshot(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  command:TargetStagingAttentionLifecycleCommand,nowMs:number,
):TargetAttentionReceiptSnapshot {
  const denied=():TargetAttentionReceiptSnapshot=>({ok:false,reason:"inaccessible"});
  if(!validTargetStagingAttentionLifecycleCommand(command))return denied();
  return withPreflightedStore<TargetAttentionReceiptSnapshot>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if(!preflight(db))return denied();
      const actor=verifiedActor(db,access,true);
      if(!actor)return denied();
      const preview=readAuthorizedAttentionCommandPreview(
        db,actor,command.taskId,command.ruleId,command.occurrenceOn,
        store.expectedRestoreGeneration,nowMs);
      if(!preview)return denied();
      const receipt=attentionReceiptInSnapshot(
        db,actor,command,store.expectedRestoreGeneration,nowMs,preview);
      return {ok:true,preview,receipt};
    },denied));
}

/** v20 temporal detail with the same actor/ACL/preflight boundary. */
export function readPreflightedTemporalTaskDetail(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, taskId: string,
): TemporalTaskDetail | null {
  return withPreflightedStore(store, () => null, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      return actorUserId ? readAuthorizedTemporalTaskDetail(db, actorUserId, taskId) : null;
    }, () => null));
}

/** R3-slice BE-04: status CAS preview and its live-release task guard
 * originate from the SAME preflighted SQLite read transaction. This is a
 * read-only hint; the writer revalidates everything under BEGIN IMMEDIATE. */
export function readPreflightedTemporalStatusPreview(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, taskId: string,
): {detail: TemporalTaskDetail; expectedRevision: string} | null {
  return withPreflightedStore(store, () => null, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return null;
      const actor = verifiedActor(db, access);
      if (!actor || !canEditIsolatedTargetTaskTitle(db, actor, taskId)) return null;
      const detail = readAuthorizedTemporalTaskDetail(db, actor, taskId);
      const revision = detail ? targetTaskTitleEditRevision(db, taskId) : null;
      if (!detail || !revision || !/^[a-f0-9]{64}$/.test(revision) ||
          detail.linearization.areas.length !== 1 ||
          !["private-owner", "editor", "admin"].includes(detail.linearization.areas[0].access))
        return null;
      return {detail, expectedRevision: revision};
    }, () => null));
}

/** BE-08: dueOn and task-status share the same task-write CAS domain and
 * authorization. Reuse the canonical one-snapshot task/Area/parent witness,
 * never compose a second dueOn-specific read with the CAS revision. */
export function readPreflightedTemporalDueOnPreview(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,taskId:string,
):{detail:TemporalTaskDetail;expectedRevision:string}|null {
  return readPreflightedTemporalStatusPreview(store,access,taskId);
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


/** Isolated pinned receipt reconciliation: current write ACL is checked before
 * querying an opaque actor/task-scoped receipt. Never a retry capability. */
export type TargetTemporalStatusReceiptResult =
  | { ok:true; status:"committed" | "not_recorded" }
  | { ok:false; reason:"invalid_request" | "unauthorized" | "unavailable" |
      "idempotency_conflict" | "resync_required" | "write_area_mismatch" };

/** The exact command receipt is read only after the same snapshot's live
 * actor/write-Area checks. A receipt never grants a write or retry capability. */
function temporalStatusReceiptInSnapshot(
  db:DatabaseSync,actor:string,request:TargetStagingTemporalStatusCommand,
):TargetTemporalStatusReceiptResult {
  const check=checkTargetTaskWriteContract(db,actor,request);
  if(check.ok===false)return {ok:false,reason:check.reason};
  const receipt=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(temporalStatusReceiptKey(actor,request.taskId,request.commandId)) as
    {value:string}|undefined;
  if(!receipt)return {ok:true,status:"not_recorded"};
  return receipt.value===temporalStatusReceiptDigest(request)
    ? {ok:true,status:"committed"}
    : {ok:false,reason:"idempotency_conflict"};
}

/** BE-05: status receipt and the exact live-release task/Area guard are from
 * one pinned, preflighted, writable-actor SQLite snapshot. */
export type TargetTemporalStatusReceiptSnapshot =
  | {ok:true;detail:TemporalTaskDetail;receipt:TargetTemporalStatusReceiptResult}
  | {ok:false;reason:"inaccessible"};

export function readPreflightedTemporalStatusReceiptSnapshot(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:TargetStagingTemporalStatusCommand,
):TargetTemporalStatusReceiptSnapshot {
  const denied=():TargetTemporalStatusReceiptSnapshot=>({ok:false,reason:"inaccessible"});
  if(!validTargetStagingTemporalStatusCommand(request))return denied();
  return withPreflightedStore<TargetTemporalStatusReceiptSnapshot>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if(!preflight(db))return denied();
      const actor=verifiedActor(db,access,true);
      if(!actor||!canEditIsolatedTargetTaskTitle(db,actor,request.taskId))
        return denied();
      const detail=readAuthorizedTemporalTaskDetail(db,actor,request.taskId);
      if(!detail||detail.linearization.areas.length!==1||
          !["private-owner","editor","admin"].includes(
            detail.linearization.areas[0].access))return denied();
      return {ok:true,detail,receipt:temporalStatusReceiptInSnapshot(db,actor,request)};
    },denied));
}

export function readPreflightedTemporalStatusReceipt(
  store:TargetStagingReadStore, access:TargetStagingReadCredential,
  request:TargetStagingTemporalStatusCommand,
):TargetTemporalStatusReceiptResult {
  if (!validTargetStagingTemporalStatusCommand(request))
    return {ok:false,reason:"invalid_request"};
  const denied=():TargetTemporalStatusReceiptResult=>({ok:false,reason:"unauthorized"});
  return withPreflightedStore<TargetTemporalStatusReceiptResult>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if (!preflight(db)) return denied();
      const actor=verifiedActor(db,access,true);
      if (!actor) return denied();
      return temporalStatusReceiptInSnapshot(db,actor,request);
    },denied));
}

/** Exact actor/Area bound and canonical pinned dueOn receipt read. */
export type TargetTemporalDueOnReceiptResult =
  | {ok:true;status:"committed"|"not_recorded"}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "idempotency_conflict"|"resync_required"|"write_area_mismatch"};

/** Exact dueOn receipt check, always inside the caller's pinned actor snapshot.
 * The old command's expected CAS is in the digest; it must not be compared
 * against the task revision after the original command was committed. */
function temporalDueOnReceiptInSnapshot(
  db:DatabaseSync,actor:string,request:TargetStagingTemporalDueOnCommand,
):TargetTemporalDueOnReceiptResult {
  const check=checkTargetTaskWriteContract(db,actor,request);
  if(check.ok===false)return {ok:false,reason:check.reason};
  const receipt=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(temporalDueOnReceiptKey(actor,request.taskId,request.commandId)) as
    {value:string}|undefined;
  if(!receipt)return {ok:true,status:"not_recorded"};
  return receipt.value===temporalDueOnReceiptDigest(request)
    ? {ok:true,status:"committed"}
    : {ok:false,reason:"idempotency_conflict"};
}

/** BE-07: task/parent/Area witness plus dueOn receipt from ONE canonical
 * actor-bound and preflighted SQLite read snapshot. Internal-only DTO. */
export type TargetTemporalDueOnReceiptSnapshot =
  | {ok:true;detail:TemporalTaskDetail;receipt:TargetTemporalDueOnReceiptResult}
  | {ok:false;reason:"inaccessible"};

export function readPreflightedTemporalDueOnReceiptSnapshot(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:TargetStagingTemporalDueOnCommand,
):TargetTemporalDueOnReceiptSnapshot {
  const denied=():TargetTemporalDueOnReceiptSnapshot=>({ok:false,reason:"inaccessible"});
  if(!validTargetStagingTemporalDueOnCommand(request))return denied();
  return withPreflightedStore<TargetTemporalDueOnReceiptSnapshot>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if(!preflight(db))return denied();
      const actor=verifiedActor(db,access,true);
      if(!actor||!canEditIsolatedTargetTaskTitle(db,actor,request.taskId))
        return denied();
      const detail=readAuthorizedTemporalTaskDetail(db,actor,request.taskId);
      if(!detail||detail.linearization.areas.length!==1||
        !["private-owner","editor","admin"].includes(
          detail.linearization.areas[0].access))return denied();
      return {ok:true,detail,receipt:temporalDueOnReceiptInSnapshot(db,actor,request)};
    },denied));
}

export function readPreflightedTemporalDueOnReceipt(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:TargetStagingTemporalDueOnCommand,
):TargetTemporalDueOnReceiptResult {
  if (!validTargetStagingTemporalDueOnCommand(request))
    return {ok:false,reason:"invalid_request"};
  const denied=():TargetTemporalDueOnReceiptResult=>({ok:false,reason:"unauthorized"});
  return withPreflightedStore<TargetTemporalDueOnReceiptResult>(store,denied,
    (db,preflight)=>inReadSnapshot(db,()=>{
      if (!preflight(db)) return denied();
      const actor=verifiedActor(db,access,true);
      if (!actor) return denied();
      return temporalDueOnReceiptInSnapshot(db,actor,request);
    },denied));
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

/** R2d.2c.2f.4: canonical, write-audience, content-free note delete status. */
export function readPreflightedTargetNoteDeleteCommandStatus(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  request: TargetStagingNoteDeleteRequest,
): TargetNoteDeleteCommandStatus | { ok: false; reason: "unauthorized" } {
  if (!validTargetStagingNoteDeleteRequest(request))
    return { ok: false, reason: "invalid_request" };
  const denied = () => ({ ok: false as const, reason: "unauthorized" as const });
  return withPreflightedStore<TargetNoteDeleteCommandStatus | { ok: false; reason: "unauthorized" }>(
    store, denied, (db, preflight) =>
      inReadSnapshot<TargetNoteDeleteCommandStatus | { ok: false; reason: "unauthorized" }>(
        db, () => {
          if (!preflight(db)) return denied();
          const actor = verifiedActor(db, access, true);
          if (!actor) return denied();
          return readTargetNoteDeleteCommandStatus(db, actor, request);
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

/** R2d.4a: signed actor + canonical preflight + one pinned read transaction.
 * Internal only. HTTP must live-check full Area and note epoch witnesses. */
export function readPreflightedAuthorizedTitleSearchPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{scope:TargetGlobalTaskScope;query:string;limit:number;offset:number},
):AuthorizedSearchPage|null{
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedTitleSearchPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** R2d.3m.7 — one canonical preflight, one signed actor, ONE pinned
 * SQLite snapshot across tasks, projects and note titles. Internal only. */
export function readPreflightedGlobalCombinedPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{scope:TargetGlobalTaskScope;limit:number;positions:GlobalCombinedPositions},
):TargetGlobalCombinedPage|null{
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedGlobalCombinedPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** R2d.3m.5: internal global note-title index; one canonical pinned,
 * actor-bound read. Future HTTP MUST pass the note-sync Area epochs to
 * the atomic live guard before returning any title. */
export function readPreflightedGlobalNotePage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{scope:TargetGlobalTaskScope;limit:number;offset:number},
):TargetGlobalNotePage|null{
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedGlobalNotePage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** R2d.3m.3: one canonical pinned, actor-bound global project index.
 * A future HTTP adapter MUST recheck all Area epochs with the live guard. */
export function readPreflightedGlobalProjectPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{scope:TargetGlobalTaskScope;limit:number;offset:number},
):TargetGlobalProjectPage|null{
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedGlobalProjectPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
}

/** R2d.3m.1: authenticated canonical task-only global scope.
 * Unlike My Plan, "all" contains unassigned shared and viewer-visible work.
 * This is NOT an HTTP route or an independently trusted identity source.
 * A future HTTP release MUST verify the complete Area content epochs LIVE. */
export function readPreflightedGlobalTaskPage(
  store:TargetStagingReadStore,access:TargetStagingReadCredential,
  request:{scope:TargetGlobalTaskScope;limit:number;offset:number},
):TargetGlobalTaskPage|null {
  return withPreflightedStore(store,()=>null,(db,preflight)=>
    inReadSnapshot(db,()=>{
      if(!preflight(db))return null;
      const actorUserId=verifiedActor(db,access);
      return actorUserId?readAuthorizedGlobalTaskPage(db,{
        ...request,actorUserId,restoreGeneration:store.expectedRestoreGeneration,
      }):null;
    },()=>null));
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

/** Project title preview must never offer a token on the older read-compatible schema. */
export function readPreflightedProjectTitlePreview(
  store: TargetStagingReadStore, access: TargetStagingReadCredential, projectId: string,
): TargetAuthorizedProjectTasksResult | null {
  return withPreflightedStore<TargetAuthorizedProjectTasksResult | null>(store, () => null, (db, preflight) =>
    inReadSnapshot<TargetAuthorizedProjectTasksResult | null>(db, () => {
      if (!preflight(db)) return null;
      const actorUserId = verifiedActor(db, access);
      const version = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as {value:string} | undefined;
      if (!actorUserId || version?.value !== String(TARGET_STORE_SCHEMA_VERSION)) return null;
      return readAuthorizedProjectTasksPage(db, { actorUserId, projectId, limit:1, offset:0,
        restoreGeneration:store.expectedRestoreGeneration });
    }, () => null));
}

/** R2d structural project links on ONE authorized, preflighted snapshot. */
export function readPreflightedAuthorizedProjectStructuralRelations(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  projectId: string, limit: number, offset: number,
): TargetAuthorizedStructuralRelationsResult | null {
  return withPreflightedStore<TargetAuthorizedStructuralRelationsResult | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<TargetAuthorizedStructuralRelationsResult | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId ? readAuthorizedProjectStructuralRelations(db, {
          actorUserId, projectId, limit, offset,
          restoreGeneration: store.expectedRestoreGeneration,
        }) : null;
      }, () => null),
  );
}

/** One actor-scoped canonical task/note parent backlink on a pinned snapshot. */
export function readPreflightedAuthorizedTargetParentBacklink(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  kind: TargetBacklinkKind, id: string,
): TargetAuthorizedBacklink | null {
  return withPreflightedStore<TargetAuthorizedBacklink | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<TargetAuthorizedBacklink | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId ? readAuthorizedTargetParentBacklink(db, {
          actorUserId, kind, id,
        }) : null;
      }, () => null),
  );
}

/** R2d.3c: authenticated Personal/Shared/My Plan Home inventory. */
export function readPreflightedScopedHomeSummary(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  scope: TargetHomeScope,
): AuthorizedScopedHomeSummary | null {
  return withPreflightedStore<AuthorizedScopedHomeSummary | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<AuthorizedScopedHomeSummary | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId
          ? readAuthorizedScopedHomeSummary(db, actorUserId, scope) : null;
      }, () => null),
  );
}

/** R2d.3b: one pinned read of bounded Home summary and all contributing Areas. */
export function readPreflightedMyPlanHomeSummary(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
): AuthorizedMyPlanHomeSummary | null {
  return withPreflightedStore<AuthorizedMyPlanHomeSummary | null>(
    store, () => null, (db, preflight) =>
      inReadSnapshot<AuthorizedMyPlanHomeSummary | null>(db, () => {
        if (!preflight(db)) return null;
        const actorUserId = verifiedActor(db, access);
        return actorUserId ? readAuthorizedMyPlanHomeSummary(db, actorUserId) : null;
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

export type PreflightedNoteSyncResult =
  | { ok: true; page: TargetNoteSyncPage; epoch: number;
      stamp: { areaId: string; contentRevision: number; head: number } }
  | { ok: false; reason: "inaccessible" | "resync_required" | "unavailable" };

/** One canonical pinned snapshot for ACL, cursor read, and the release stamp. */
export function readPreflightedAuthorizedNoteSync(
  store: TargetStagingReadStore, access: TargetStagingReadCredential,
  request: { areaId: string; limit: number; cursor?: string; secret: string },
): PreflightedNoteSyncResult {
  const unavailable = (): PreflightedNoteSyncResult => ({ ok: false, reason: "unavailable" });
  return withPreflightedStore(store, unavailable, (db, preflight) =>
    inReadSnapshot(db, () => {
      if (!preflight(db)) return unavailable();
      const actorUserId = verifiedActor(db, access);
      if (!actorUserId) return unavailable();
      const decision = evaluateTargetAreaPolicy(db, {
        actorUserId, areaId: request.areaId, permission: "read",
      });
      if (!decision.allowed) return decision.reason === "query_failed" ? unavailable()
        : { ok: false as const, reason: "inaccessible" as const };
      const epochRow = db.prepare("SELECT revocation_epoch AS epoch FROM identities WHERE id=?")
        .get(actorUserId) as { epoch: number } | undefined;
      if (!epochRow || !Number.isSafeInteger(epochRow.epoch) || epochRow.epoch < 0)
        return unavailable();
      const page = readAuthorizedTargetNoteSyncPage(db, {
        actorUserId, areaId: request.areaId, sessionEpoch: epochRow.epoch,
        secret: request.secret, cursor: request.cursor, limit: request.limit,
      });
      if (!page) return request.cursor === undefined ? unavailable()
        : { ok: false as const, reason: "resync_required" as const };
      const stamp = db.prepare(`SELECT a.note_sync_revision AS contentRevision,
        MAX(COALESCE((SELECT MAX(j.seq) FROM note_change_journal j WHERE j.area_id=a.id),0),
        (SELECT f.floor_seq FROM note_journal_floors f WHERE f.area_id=a.id)) AS head
        FROM areas a WHERE a.id=?`).get(request.areaId) as
        { contentRevision: number; head: number } | undefined;
      if (!stamp || !Number.isSafeInteger(stamp.contentRevision) ||
          !Number.isSafeInteger(stamp.head) || stamp.contentRevision < 0 || stamp.head < 0)
        return unavailable();
      return { ok: true as const, page, epoch: epochRow.epoch,
        stamp: { areaId: request.areaId, ...stamp } };
    }, unavailable));
}
