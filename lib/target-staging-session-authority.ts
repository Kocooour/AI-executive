import type {TargetProjectTitleRecovery} from "./target-project-title-command-status";
import {cancelTargetProjectTitle,validProjectTitleCancelCommand,type ProjectTitleCancelCommand,type ProjectTitleCancelResult} from "./target-project-title-cancel";
import { writeTargetProjectTitle, validProjectTitleCommand, type ProjectTitleCommand, type ProjectTitleResult } from "./target-project-title-writer";
/**
 * R2 staging-only process-local session issuance and revocation.
 *
 * This is a server-side library, NOT an HTTP route, cookie verifier, passkey
 * binding, or a production session service. Only a trusted server-side
 * principal may be passed to issue(). Never derive its actor ID from a
 * user-controlled task request.
 *
 * Each instance creates its own dedicated, non-persisted HMAC key. Restarting
 * the process or creating a new authority invalidates every prior token.
 * An explicitly revoked token is rejected BEFORE entering the task gateway.
 * No signing key or unsigned credential is exposed by this class.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  TARGET_STAGING_TASK_READ_AUDIENCE, TARGET_STAGING_TASK_WRITE_AUDIENCE, verifiedActor,
} from "./target-task-authenticated-read";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";
import type { TargetScopedOffsetPage } from "./target-task-read-model";
import type { TemporalScope, TemporalStatus, TemporalTaskPage, TemporalTaskDetail, TemporalDueWindow, TemporalDueWindowPage } from "./target-task-temporal-read-model";
import type { PersonalWhenWindow, PersonalWhenPage } from "./target-personal-when-read-model";
import type {AttentionAreaFilter,AttentionView} from "./target-attention-read-model";
import type {MyPlanDayTaskPage,MyPlanTaskDayWindow,MyPlanTaskAreaFilter} from "./target-my-plan-day-task-read-model";
import type {TargetGlobalTaskPage,TargetGlobalTaskScope} from "./target-global-task-read-model";
import type {TargetGlobalProjectPage} from "./target-global-project-read-model";
import type {TargetGlobalNotePage} from "./target-global-note-read-model";
import type {TargetGlobalCombinedPage,GlobalCombinedPositions} from "./target-global-combined-read-model";
import type {AuthorizedSearchPage} from "./target-authorized-title-search";
import {readPreflightedTargetContextBundle} from "./target-context-bundle";
import type {ContextBundleRequest,TargetContextBundle} from "./target-context-bundle";
import type {PersonalWhenCommandPreview} from "./target-personal-when-command-read";
import type {TargetPersonalWhenReceiptResult,TargetPersonalWhenReceiptSnapshot}
  from "./target-task-staging-reader";
import type {
  AuthenticatedTargetTaskDetailResult, AuthenticatedTargetTaskListResult,
  TargetStagingTaskDetailRequest, TargetStagingTaskListRequest,
} from "./target-task-authenticated-read";
import {
  listPreflightedIsolatedTargetTasks, listRevisionedPreflightedIsolatedTargetTasksAtOffset,
  previewPreflightedTargetTaskTitleEdit, readPreflightedIsolatedTargetTask,
  readPreflightedIsolatedPersonalTargetTask, readPreflightedPersonalTargetTaskWithRevision,
  readPreflightedTargetTaskTitleCommandStatus, readPreflightedTargetTaskDeleteCommandStatus,
  readPreflightedTargetNoteEditCommandStatus,readPreflightedTargetNoteEditRecovery,
  readPreflightedTargetNoteCreateRecovery,readPreflightedProjectTitleRecovery,readPreflightedTargetNoteDeleteCommandStatus,
  readPreflightedPrivateTaskCreateStatus,readPreflightedPrivateTaskCreateRecovery,
  listPreflightedPrivateProjectsAtOffset, readPreflightedPrivateProjectDetail,
  readPreflightedPrivateTaskTitleAudit,
  readPreflightedScopedTaskPage, readPreflightedSharedTargetTask, readPreflightedChangeFeedPage,
  readPreflightedAuthorizedProjectTasks, readPreflightedProjectTitlePreview, readPreflightedAuthorizedProjectIndex,
  readPreflightedMyPlanHomeSummary,
  readPreflightedScopedHomeSummary,
  readPreflightedTemporalTaskPage, readPreflightedTemporalTaskDetail,
  readPreflightedTemporalStatusPreview,
  readPreflightedTemporalDueOnPreview, readPreflightedTemporalDueWindowPage,
  readPreflightedPersonalWhenPage,
  readPreflightedMyPlanDayTaskPage,
  readPreflightedAttentionCandidatePage,readPreflightedStoreSnapshot,
  readPreflightedPrivateNoteAreaTargets,
  type TargetAttentionProfilePage,
  readPreflightedMyPlanTwoDayTaskPage,
  readPreflightedGlobalTaskPage,
  readPreflightedGlobalProjectPage,
  readPreflightedGlobalNotePage,
  readPreflightedGlobalCombinedPage,
  readPreflightedAuthorizedTitleSearchPage,
  readPreflightedPersonalWhenCommandPreview,readPreflightedPersonalWhenReceipt,
  readPreflightedPersonalWhenReceiptSnapshot,
  readPreflightedAttentionCommandPreview,readPreflightedAttentionReceiptSnapshot,
  type TargetAttentionReceiptSnapshot,
  readPreflightedTemporalStatusReceipt,readPreflightedTemporalStatusReceiptSnapshot,
  readPreflightedTemporalDueOnReceipt,
  readPreflightedTemporalDueOnReceiptSnapshot,
  readPreflightedAuthorizedProjectStructuralRelations,
  readPreflightedAuthorizedTargetParentBacklink,
  readPreflightedAuthorizedTargetNote,
  readPreflightedAuthorizedNoteSync,
} from "./target-task-staging-reader";
import type { TargetStagingReadStore, TargetPreflightedPrivateProjectDetail, TargetPreflightedSharedTaskDetail,
  TargetPreflightedPersonalTaskDetail,TargetPrivateNoteAreaTargets } from "./target-task-staging-reader";
import type { TargetPrivateProjectPage } from "./target-project-read-model";
import type { TargetAuthorizedProjectTasksResult } from "./target-project-task-read-model";
import type { TargetAuthorizedStructuralRelationsResult } from "./target-project-structural-relations";
import type { TargetAuthorizedBacklink, TargetBacklinkKind } from "./target-parent-backlinks";
import type { TargetAuthorizedNote } from "./target-note-access";
import type { PreflightedNoteSyncResult } from "./target-task-staging-reader";
import type { TargetAuthorizedProjectIndexPage, TargetProjectIndexScope } from "./target-authorized-project-index";
import type { AuthorizedMyPlanHomeSummary } from "./target-my-plan-home-summary";
import type { AuthorizedScopedHomeSummary, TargetHomeScope } from "./target-scoped-home-summary";
import type { TargetChangeFeedResult } from "./target-change-feed-read-model";
import type { FeedClaims } from "./target-staging-feed-cursor";
import type { TargetPrivateTaskTitleAuditResult } from "./target-task-read-model";
import type { TargetStagingTaskTitleCommandStatusResult, TargetTemporalStatusReceiptResult, TargetTemporalStatusReceiptSnapshot, TargetTemporalDueOnReceiptResult, TargetTemporalDueOnReceiptSnapshot } from "./target-task-staging-reader";
import type {TargetNoteEditCommandStatus,TargetNoteEditRecovery} from "./target-note-command-status";
import type {TargetNoteCreateRecovery} from "./target-note-create-status";
import type { TargetNoteDeleteCommandStatus } from "./target-note-delete-command-status";
import { validTargetTaskTitleEditPreviewRequest } from "./target-task-write-preflight";
import { writePreflightedTargetTaskTitle, validTargetStagingTaskTitleWriteRequest } from "./target-task-staging-writer";
import {
  writePreflightedTemporalTaskStatus, validTargetStagingTemporalStatusCommand,
  type TargetStagingTemporalStatusCommand, type TargetStagingTemporalStatusResult,
} from "./target-task-temporal-status-writer";
import {
  writePreflightedTemporalDueOn, validTargetStagingTemporalDueOnCommand,
  type TargetStagingTemporalDueOnCommand, type TargetStagingTemporalDueOnResult,
} from "./target-task-temporal-due-on-writer";
import {writePreflightedPersonalWhen,validTargetStagingPersonalWhenCommand,
  type TargetStagingPersonalWhenCommand,type TargetStagingPersonalWhenResult,
} from "./target-personal-when-writer";
import type {AttentionCommandPreview} from "./target-attention-command-read";
import type {TargetAttentionLifecycleRuleId} from "./target-attention-lifecycle-writer";
import {writePreflightedAttentionLifecycle,validTargetStagingAttentionLifecycleCommand,
  type TargetStagingAttentionLifecycleCommand,type TargetStagingAttentionLifecycleResult,
} from "./target-attention-lifecycle-writer";
import {writePreflightedNotificationSettings,validTargetStagingNotificationSettingsCommand,
  writePreflightedPushTarget,validTargetStagingPushTargetCommand,
  readNotificationSettingsInSnapshot,
  type TargetStagingNotificationSettingsCommand,type TargetStagingNotificationSettingsResult,
  type TargetStagingPushTargetCommand,type TargetStagingPushTargetResult,
  type TargetNotificationSettingsView,
} from "./target-notification-writer";
import {runTargetAttentionPushPass,
  type TargetAttentionPushPassSummary,type TargetPushSender,
} from "./target-attention-push-pass";
import { editPreflightedTargetNote, validTargetStagingNoteEditRequest } from "./target-note-staging-writer";
import type { TargetStagingNoteEditRequest, TargetStagingNoteEditResult } from "./target-note-staging-writer";
import { deletePreflightedTargetNote, validTargetStagingNoteDeleteRequest } from "./target-note-delete-writer";
import {
  changePreflightedTargetNoteLifecycle, validTargetStagingNoteLifecycleRequest,
  type TargetStagingNoteLifecycleRequest, type TargetStagingNoteLifecycleResult,
} from "./target-note-lifecycle-writer";
import type { TargetStagingNoteDeleteRequest, TargetStagingNoteDeleteResult } from "./target-note-delete-writer";
import type { TargetStagingTaskTitleWriteRequest, TargetStagingTaskTitleWriteResult } from "./target-task-staging-writer";
import {
  createPreflightedPrivateTask, cancelPreflightedPrivateTaskCreate,
  validPrivateTaskCreateCommand,
  type PrivateTaskCreateCommand, type PrivateTaskCreateResult, type PrivateTaskCreateStatus,type PrivateTaskCreateRecovery,
  type PrivateTaskCreateCancelResult,
} from "./target-private-task-create-writer";

import { deletePreflightedTargetTask, validTargetStagingTaskDeleteRequest } from "./target-task-delete-writer";
import type {
  TargetStagingTaskDeleteRequest, TargetStagingTaskDeleteResult, TargetStagingTaskDeleteStatusResult,
} from "./target-task-delete-writer";
import { applyTargetStagingMembershipCommand, validTargetStagingMembershipCommand } from "./target-staging-membership-command";
import type { TargetStagingMembershipCommand, TargetStagingMembershipResult } from "./target-staging-membership-command";
import type { TargetTaskTitleEditPreviewRequest, TargetTaskTitleEditPreviewResult } from "./target-task-write-preflight";

const TOKEN_DOMAIN = "lumi:r2:target-task-read:staging:v1\0";
const WRITE_TOKEN_DOMAIN = "lumi:r2:target-task-write:staging:v1\0";
const CURSOR_DOMAIN = "lumi:r2:target-task-page-cursor:staging:v2\0";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_SESSION_SECONDS = 15 * 60;
const DEFAULT_SESSION_SECONDS = 5 * 60;
const MAX_ACTIVE_SESSIONS = 256;
const MAX_TOKEN_LENGTH = 4096;

interface ActiveSession {
  readonly actor: string;
  readonly expiresAt: number;
  readonly writable: boolean;
}

export interface IssuedTargetStagingSession {
  /** Bearer token: return only to the specifically authenticated principal. */
  readonly sessionToken: string;
  /** Unix epoch seconds. */
  readonly expiresAt: number;
}

/** Initial personal page obtained during issuance, without a second DB snapshot. */
export interface IssuedTargetStagingPersonalPage extends IssuedTargetStagingSession {
  readonly tasks: Extract<StableStagingTaskListResult, { ok: true }>["tasks"];
  readonly nextCursor: string | null;
}

/** Trusted server-side page for a separately authenticated HTTP principal. */
export interface TargetStagingPersonalOffsetPage {
  readonly tasks: IssuedTargetStagingPersonalPage["tasks"];
  readonly hasMore: boolean;
  readonly revision: string;
}

const deniedList = (): AuthenticatedTargetTaskListResult =>
  ({ ok: false, reason: "unauthorized", tasks: [], nextCursor: null });
const deniedDetail = (): AuthenticatedTargetTaskDetailResult =>
  ({ ok: false, reason: "unauthorized", task: null });
const invalidList = (): AuthenticatedTargetTaskListResult =>
  ({ ok: false, reason: "invalid_request", tasks: [], nextCursor: null });
const staleList = (): StableStagingTaskListResult =>
  ({ ok: false, reason: "stale_cursor", tasks: [], nextCursor: null });

/** Public session-bound paging accepts signed cursors, never raw task IDs. */
export type StableStagingTaskListRequest =
  Omit<TargetStagingTaskListRequest, "afterTaskId"> & {
    readonly cursor?: string | null;
    readonly afterTaskId?: never;
    readonly offset?: never;
  };

export type StableStagingTaskListResult = AuthenticatedTargetTaskListResult |
  { ok: false; reason: "stale_cursor"; tasks: []; nextCursor: null };

type CursorClaims = {
  v: 2;
  scope: TargetStagingTaskListRequest["scope"];
  sid: string;
  rev: string;
  offset: number;
};


const digest = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * The authority is created once per staging server process. Never persist or
 * share its key across processes: cross-process acceptance would need a
 * durable, atomic revocation store and is deliberately OUT OF SCOPE here.
 */
export class TargetStagingSessionAuthority {
  readonly #store: TargetStagingReadStore;
  readonly #key = randomBytes(32);
  readonly #active = new Map<string, ActiveSession>();
  #closed = false;

  constructor(store: TargetStagingReadStore) {
    // Freeze a private copy so later caller mutation cannot redirect requests
    // to a different database or restore generation.
    this.#store = Object.freeze({
      stagingDirectory: store?.stagingDirectory,
      expectedRestoreGeneration: store?.expectedRestoreGeneration,
    });
  }

  #pruneExpired(now: number): void {
    for (const [key, session] of this.#active) {
      if (session.expiresAt <= now) this.#active.delete(key);
    }
  }

  /**
   * Called only after a separate server-side identity proof has established
   * actorUserId; does not accept an actor from list/detail request fields.
   * Independently confirms the actor against the isolated preflighted store
   * before issuing a session. All failure cases have the same null response.
   */
  issue(actorUserId: string, lifetimeSeconds = DEFAULT_SESSION_SECONDS): IssuedTargetStagingSession | null {
    return this.#issue(actorUserId, lifetimeSeconds, false);
  }

  /** Trusted server-only shortcut: issue a read session and its first personal
   * page from the same pinned/preflighted snapshot. The token stays server-side. */
  issuePersonalFirstPage(
    actorUserId: string, limit: number, lifetimeSeconds = DEFAULT_SESSION_SECONDS,
  ): IssuedTargetStagingPersonalPage | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
    const issued = this.#issue(actorUserId, lifetimeSeconds, false, limit);
    if (!issued?.initialPage) return null;
    return { sessionToken: issued.sessionToken, expiresAt: issued.expiresAt,
      tasks: issued.initialPage.tasks, nextCursor: issued.initialPage.nextCursor };
  }

  /** Read exactly one preflighted page in a trusted isolated worker. The
   * caller MUST authenticate the principal and validate any external cursor
   * before selecting the offset. No session token is returned to the caller. */
  readPersonalOffsetPage(
    actorUserId: string, limit: number, offset: number,
  ): TargetStagingPersonalOffsetPage | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 ||
        offset > MAX_STAGING_PAGE_OFFSET) return null;
    const issued = this.#issue(actorUserId, DEFAULT_SESSION_SECONDS, false, limit, offset);
    if (!issued?.initialPage) return null;
    return { tasks: issued.initialPage.tasks, hasMore: issued.initialPage.hasMore,
      revision: issued.initialPage.revision };
  }

  /** One pinned snapshot for the entire owner-only detail decision. No token
   * escapes this short-lived child and no preliminary list snapshot is made. */
  readPersonalTaskDetail(actorUserId: string, taskId: string): AuthenticatedTargetTaskDetailResult {
    if (this.#closed || typeof actorUserId !== "string" || !ACTOR_PATTERN.test(actorUserId)) {
      return deniedDetail();
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      return readPreflightedIsolatedPersonalTargetTask(this.#store,
        { signingKey: this.#key, sessionToken: `${payload}.${signature}` }, { taskId });
    } catch {
      return deniedDetail();
    }
  }

  /** Owner-private detail and title CAS token from the same authenticated snapshot. */
  readPersonalTaskDetailWithRevision(actorUserId: string, taskId: string): TargetPreflightedPersonalTaskDetail {
    if (this.#closed || typeof actorUserId !== "string" || !ACTOR_PATTERN.test(actorUserId)) {
      return { ok: false, reason: "unauthorized", task: null };
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      return readPreflightedPersonalTargetTaskWithRevision(this.#store,
        { signingKey: this.#key, sessionToken: `${payload}.${signature}` }, { taskId });
    } catch {
      return { ok: false, reason: "unauthorized", task: null };
    }
  }

  /** Content-free audit timeline for one currently authorized owner-private task.
   * The credential remains within this short-lived worker. */
  readPrivateTaskTitleAudit(
    actorUserId: string, taskId: string,
  ): TargetPrivateTaskTitleAuditResult {
    const denied = (): TargetPrivateTaskTitleAuditResult =>
      ({ ok: false, reason: "query_failed" });
    if (this.#closed || typeof actorUserId !== "string" ||
        !ACTOR_PATTERN.test(actorUserId)) return denied();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      return readPreflightedPrivateTaskTitleAudit(this.#store,
        { signingKey: this.#key, sessionToken: `${payload}.${signature}` }, taskId);
    } catch {
      return denied();
    }
  }

  /** One-use authenticated owner-private project page on a pinned snapshot. */
  readPrivateProjectOffsetPage(
    actorUserId: string, limit: number, offset: number,
  ): TargetPrivateProjectPage | null {
    if (this.#closed || typeof actorUserId !== "string" ||
        !ACTOR_PATTERN.test(actorUserId) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 ||
        offset > MAX_STAGING_PAGE_OFFSET) return null;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      return listPreflightedPrivateProjectsAtOffset(this.#store,
        { signingKey: this.#key, sessionToken: `${payload}.${signature}` },
        limit, offset);
    } catch {
      return null;
    }
  }

  /** One authenticated owner-private project detail on a canonical pinned snapshot. */
  readPrivateProjectDetail(
    actorUserId: string, projectId: string,
  ): TargetPreflightedPrivateProjectDetail {
    const denied = (): TargetPreflightedPrivateProjectDetail =>
      ({ ok: false, reason: "unauthorized" });
    if (this.#closed || typeof actorUserId !== "string" ||
        !ACTOR_PATTERN.test(actorUserId)) return denied();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      return readPreflightedPrivateProjectDetail(this.#store,
        { signingKey: this.#key, sessionToken: `${payload}.${signature}` }, projectId);
    } catch {
      return denied();
    }
  }

  #oneShotReadCredential(actorUserId: string): { signingKey: Uint8Array; sessionToken: string } | null {
    if (this.#closed || typeof actorUserId !== "string" || !ACTOR_PATTERN.test(actorUserId)) return null;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1, aud: TARGET_STAGING_TASK_READ_AUDIENCE, sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration, iat: now,
      exp: now + DEFAULT_SESSION_SECONDS, jti: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#key).update(TOKEN_DOMAIN)
      .update(payload).digest("base64url");
    return { signingKey: this.#key, sessionToken: `${payload}.${signature}` };
  }

  /** R3-CAPTURE-1: signed actor + pinned private writable Area witnesses.
   * Live release guard belongs to the HTTP route; never trust scope alone. */
  readPrivateNoteAreaTargets(actorUserId:string):TargetPrivateNoteAreaTargets|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential
        ?readPreflightedPrivateNoteAreaTargets(this.#store,credential):null;
    }catch{return null;}
  }

  /** R2-ID.2b: one shared / my-plan page plus its read-linearization record,
   * from a single pinned snapshot. The caller (HTTP route) must re-verify the
   * record on the live store before releasing the body. */
  readScopedOffsetPage(
    actorUserId: string, scope: "shared" | "my-plan", limit: number, offset: number,
  ): TargetScopedOffsetPage | null {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_STAGING_PAGE_OFFSET ||
        (scope !== "shared" && scope !== "my-plan")) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedScopedTaskPage(this.#store, credential, { scope, limit, offset }) : null;
    } catch {
      return null;
    }
  }

  /** R2d.3e: no HTTP route; caller must perform live-release Area guard. */
  readTemporalTaskPage(
    actorUserId: string, scope: TemporalScope, status: TemporalStatus,
    limit: number, offset: number,
  ): TemporalTaskPage | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedTemporalTaskPage(this.#store, credential,
        { scope, status, limit, offset }) : null;
    } catch { return null; }
  }

  /** R2d.3j.1: pinned dueOn-only deadline window; not full Today/Upcoming. */
  readTemporalDueWindowPage(
    actorUserId: string, scope: TemporalScope, window: TemporalDueWindow,
    evaluationDate: string, throughDate: string | null, limit: number, offset: number,
  ): TemporalDueWindowPage | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedTemporalDueWindowPage(this.#store, credential,
        { scope, window, evaluationDate, throughDate, limit, offset }) : null;
    } catch { return null; }
  }

  /** R2d.3k.2: private actor-bound planned-day page, not a public API. */
  readPersonalWhenPage(
    actorUserId:string,window:PersonalWhenWindow,
    evaluationDate:string|null,throughDate:string|null,
    limit:number,offset:number,
  ):PersonalWhenPage|null {
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedPersonalWhenPage(this.#store,credential,{
        window,evaluationDate,throughDate,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R2d.4i: internal, title-only authorized Context Resolver bundle (one
   * pinned snapshot). No provider call, HTTP route or client-supplied identity. */
  resolveContextBundle(
    actorUserId:string,request:ContextBundleRequest,
  ):TargetContextBundle|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedTargetContextBundle(
        this.#store,credential,request):null;
    }catch{return null;}
  }

  /** R2d.4a: internal title-only search of the authorized global scope.
   * No HTTP, client-supplied identity, or production search activation. */
  readAuthorizedTitleSearchPage(
    actorUserId:string,scope:TargetGlobalTaskScope,query:string,
    limit:number,offset:number,
  ):AuthorizedSearchPage|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedAuthorizedTitleSearchPage(
        this.#store,credential,{scope,query,limit,offset}):null;
    }catch{return null;}
  }

  /** R2d.3m.7: unified Vše/Osobní/Sdílené from a single
   * actor-bound SQLite read snapshot; INTERNAL ONLY, no HTTP admission. */
  readGlobalCombinedPage(
    actorUserId:string,scope:TargetGlobalTaskScope,limit:number,
    positions:GlobalCombinedPositions,
  ):TargetGlobalCombinedPage|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedGlobalCombinedPage(this.#store,credential,{
        scope,limit,positions,
      }):null;
    }catch{return null;}
  }

  /** R2d.3m.5: note titles only; body and foreign member IDs never released. */
  readGlobalNotePage(
    actorUserId:string,scope:TargetGlobalTaskScope,limit:number,offset:number,
  ):TargetGlobalNotePage|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedGlobalNotePage(this.#store,credential,{
        scope,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R2d.3m.3: task-independent global project list (not My Plan). */
  readGlobalProjectPage(
    actorUserId:string,scope:TargetGlobalTaskScope,limit:number,offset:number,
  ):TargetGlobalProjectPage|null{
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedGlobalProjectPage(this.#store,credential,{
        scope,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R2d.3m.1: global authorized task scope (not My Plan). Internal only. */
  readGlobalTaskPage(
    actorUserId:string,scope:TargetGlobalTaskScope,limit:number,offset:number,
  ):TargetGlobalTaskPage|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedGlobalTaskPage(this.#store,credential,{
        scope,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R2d.3l.1: task-only My Plan day buckets, never an HTTP response. */
  readMyPlanDayTaskPage(
    actorUserId:string,areaFilter:MyPlanTaskAreaFilter,window:MyPlanTaskDayWindow,
    evaluationDate:string,throughDate:string|null,limit:number,offset:number,
  ):MyPlanDayTaskPage|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedMyPlanDayTaskPage(this.#store,credential,{
        areaFilter,window,evaluationDate,throughDate,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R2d.5a: staging-only Attention candidates, never an HTTP response. */
  readAttentionCandidatePage(
    actorUserId:string,areaFilter:AttentionAreaFilter,view:AttentionView,
    evaluatedAtMs:number,limit:number,offset:number,
  ):TargetAttentionProfilePage|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedAttentionCandidatePage(this.#store,credential,{
        areaFilter,view,evaluatedAtMs,limit,offset,
      }):null;
    }catch{return null;}
  }

  /** R3-slice/BE-02: one pinned actor snapshot for Today and Tomorrow. */
  readMyPlanTwoDayTaskPage(
    actorUserId:string,areaFilter:MyPlanTaskAreaFilter,
    evaluationDate:string,nextDate:string,limit:number,
    offsetToday:number,offsetTomorrow:number,
  ):{today:MyPlanDayTaskPage;tomorrow:MyPlanDayTaskPage}|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedMyPlanTwoDayTaskPage(this.#store,credential,{
        areaFilter,evaluationDate,nextDate,limit,offsetToday,offsetTomorrow,
      }):null;
    }catch{return null;}
  }

  /** Actor-bound isolated temporal detail, not an authorization capability. */
  readTemporalTaskDetail(actorUserId: string, taskId: string): TemporalTaskDetail | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedTemporalTaskDetail(this.#store, credential, taskId) : null;
    } catch { return null; }
  }

  /** BE-04: single actor-bound, pinned CAS + temporal guard read. */
  readTemporalStatusPreview(
    actorUserId: string, taskId: string,
  ): {detail: TemporalTaskDetail; expectedRevision: string} | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedTemporalStatusPreview(
        this.#store, credential, taskId,
      ) : null;
    } catch { return null; }
  }

  /** BE-08: one actor-bound dueOn CAS token and task/Area release guard.
   * Preview is only a hint; PATCH authorizes again under BEGIN IMMEDIATE. */
  readTemporalDueOnPreview(
    actorUserId:string,taskId:string,
  ):{detail:TemporalTaskDetail;expectedRevision:string}|null {
    if(this.#closed)return null;
    try{
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedTemporalDueOnPreview(this.#store,credential,taskId)
        : null;
    }catch{return null;}
  }

  /** R2d.1a: project detail and children on one pinned ACL-checked snapshot. */
  readAuthorizedProjectTasks(
    actorUserId: string, projectId: string, limit: number, offset: number,
  ): TargetAuthorizedProjectTasksResult | null {
    if (this.#closed || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_STAGING_PAGE_OFFSET) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedAuthorizedProjectTasks(this.#store, credential, projectId, limit, offset)
        : null;
    } catch {
      return null;
    }
  }

  /** R3: canonical v26-only project rename preview. Both the schema check
   * and the actor's Area ACL, title and CAS revision are read from the SAME
   * pinned/preflighted SQLite snapshot. A v25 store must return null even
   * though ordinary project/task reads remain available. This is not a write
   * authorization; PATCH independently rechecks the current actor and ACL. */
  readProjectTitlePreview(
    actorUserId: string, projectId: string,
  ): TargetAuthorizedProjectTasksResult | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedProjectTitlePreview(this.#store, credential, projectId)
        : null;
    } catch {
      return null;
    }
  }

  /** Content-free project -> task/note structural links for an authorized actor. */
  readAuthorizedProjectStructuralRelations(
    actorUserId: string, projectId: string, limit: number, offset: number,
  ): TargetAuthorizedStructuralRelationsResult | null {
    if (this.#closed || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_STAGING_PAGE_OFFSET)
      return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedAuthorizedProjectStructuralRelations(this.#store, credential,
            projectId, limit, offset)
        : null;
    } catch {
      return null;
    }
  }

  /** Canonical task/note -> parent project backlink, no semantic relation grant. */
  readAuthorizedTargetParentBacklink(
    actorUserId: string, kind: TargetBacklinkKind, id: string,
  ): TargetAuthorizedBacklink | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedAuthorizedTargetParentBacklink(this.#store, credential, kind, id)
        : null;
    } catch {
      return null;
    }
  }

  /** R2d.2c.2c: authenticated note + exact parent/Area guard on one snapshot.
   * Only server-derived actor identities are accepted, and the guard is never public. */
  readAuthorizedNote(actorUserId: string, noteId: string): TargetAuthorizedNote | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedAuthorizedTargetNote(this.#store, credential, noteId) : null;
    } catch {
      return null;
    }
  }

  readAuthorizedNoteSync(actorUserId: string,
    request: { areaId: string; limit: number; cursor?: string; secret: string },
  ): PreflightedNoteSyncResult | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedAuthorizedNoteSync(this.#store, credential, request) : null;
    } catch {
      return null;
    }
  }

  /** R2d.3c: bounded Home inventory, actor derived from verified session. */
  readScopedHomeSummary(
    actorUserId: string, scope: TargetHomeScope,
  ): AuthorizedScopedHomeSummary | null {
    if (this.#closed ||
        (scope !== "personal" && scope !== "shared" && scope !== "my-plan"))
      return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedScopedHomeSummary(this.#store, credential, scope) : null;
    } catch {
      return null;
    }
  }

  /** R2d.3b: content-free, bounded Home inventory for authenticated actor. */
  readMyPlanHomeSummary(actorUserId: string): AuthorizedMyPlanHomeSummary | null {
    if (this.#closed) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedMyPlanHomeSummary(this.#store, credential) : null;
    } catch {
      return null;
    }
  }

  /** R2d.1b: one authenticated personal/shared project page and ACL evidence. */
  readAuthorizedProjectIndex(
    actorUserId: string, scope: TargetProjectIndexScope, limit: number, offset: number,
  ): TargetAuthorizedProjectIndexPage | null {
    if (this.#closed || (scope !== "personal" && scope !== "shared" && scope !== "my-plan") ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_STAGING_PAGE_OFFSET) return null;
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential
        ? readPreflightedAuthorizedProjectIndex(this.#store, credential, scope, limit, offset)
        : null;
    } catch {
      return null;
    }
  }

  /** R2c.2a: one bootstrap / Area bootstrap / feed page from a single pinned snapshot. */
  readChangeFeedPage(actorUserId: string, claims: FeedClaims | null): TargetChangeFeedResult | null {
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedChangeFeedPage(this.#store, credential, claims) : null;
    } catch {
      return null;
    }
  }

  /** R2-ID.2b: shared-Area task detail for a current member of any role; R2-ID.3 adds the
   * title CAS token only for a current editor/admin (same snapshot). */
  readSharedTaskDetail(actorUserId: string, taskId: string): TargetPreflightedSharedTaskDetail | null {
    try {
      const credential = this.#oneShotReadCredential(actorUserId);
      return credential ? readPreflightedSharedTargetTask(this.#store, credential, taskId) : null;
    } catch {
      return null;
    }
  }

  /**
   * Explicit trusted-server issuance for staging mutations. A regular read
   * session cannot be upgraded through a task request or a preview.
   * This is not exposed as an HTTP or client-side token issuance endpoint.
   */
  issueWritable(actorUserId: string, lifetimeSeconds = DEFAULT_SESSION_SECONDS): IssuedTargetStagingSession | null {
    return this.#issue(actorUserId, lifetimeSeconds, true);
  }

  #issue(
    actorUserId: string, lifetimeSeconds: number, writable: boolean,
    firstPageLimit?: number, firstPageOffset = 0,
  ): (IssuedTargetStagingSession & {
    initialPage?: {
      tasks: IssuedTargetStagingPersonalPage["tasks"];
      nextCursor: string | null;
      hasMore: boolean;
      revision: string;
    };
  }) | null {
    if (this.#closed || typeof actorUserId !== "string" ||
        !ACTOR_PATTERN.test(actorUserId) ||
        !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 ||
        lifetimeSeconds > MAX_SESSION_SECONDS) return null;

    const now = Math.floor(Date.now() / 1000);
    this.#pruneExpired(now);
    if (this.#active.size >= MAX_ACTIVE_SESSIONS) return null;

    const expiresAt = now + lifetimeSeconds;
    const claims = {
      v: 1,
      aud: writable ? TARGET_STAGING_TASK_WRITE_AUDIENCE : TARGET_STAGING_TASK_READ_AUDIENCE,
      sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration,
      iat: now,
      exp: expiresAt,
      jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key)
        .update(writable ? WRITE_TOKEN_DOMAIN : TOKEN_DOMAIN)
        .update(payload).digest("base64url");
      const sessionToken = payload + "." + signature;

      // The staging gateway performs canonical preflight, generation validation
      // and identity lookup. It returns ok even when personal tasks are empty.
      // Do not register or return sessions for missing/corrupt/activated stores.
      const credential = { signingKey: this.#key, sessionToken };
      let initialPage: {
        tasks: IssuedTargetStagingPersonalPage["tasks"];
        nextCursor: string | null;
        hasMore: boolean;
        revision: string;
      } | undefined;
      if (firstPageLimit === undefined) {
        const check = listPreflightedIsolatedTargetTasks(this.#store, credential,
          { scope: "personal", limit: 1 });
        if (!check.ok) return null;
      } else {
        const page = listRevisionedPreflightedIsolatedTargetTasksAtOffset(this.#store, credential,
          { scope: "personal", limit: firstPageLimit, offset: firstPageOffset });
        if (!page.result.ok || !page.revision) return null;
        const nextOffset = firstPageOffset + page.result.tasks.length;
        if (page.result.hasMore && nextOffset > MAX_STAGING_PAGE_OFFSET) return null;
        initialPage = {
          tasks: page.result.tasks,
          hasMore: page.result.hasMore,
          revision: page.revision,
          nextCursor: page.result.hasMore ?
            this.#signCursor(sessionToken, "personal", page.revision, nextOffset) : null,
        };
      }

      this.#active.set(digest(sessionToken), { actor: actorUserId, expiresAt, writable });
      return initialPage ? { sessionToken, expiresAt, initialPage } : { sessionToken, expiresAt };
    } catch {
      return null;
    }
  }

  #credential(
    sessionToken: string, requireWrite = false,
  ): { signingKey: Uint8Array; sessionToken: string } | null {
    if (this.#closed || typeof sessionToken !== "string" ||
        sessionToken.length === 0 || sessionToken.length > MAX_TOKEN_LENGTH) return null;
    const now = Math.floor(Date.now() / 1000);
    this.#pruneExpired(now);
    const session = this.#active.get(digest(sessionToken));
    if (!session || (requireWrite && !session.writable)) return null;
    return { signingKey: this.#key, sessionToken };
  }

  /**
   * A cursor is signed for exactly one issued session and one scope. Hashing
   * the preflighted source snapshot prevents inserts, deletions, edits or
   * ACL changes between pages from being silently mixed into one traversal.
   * Each new page still runs the full current Area ACL check.
   */
  #signCursor(sessionToken: string, scope: CursorClaims["scope"], rev: string, offset: number): string {
    const claims: CursorClaims = { v: 2, scope, sid: digest(sessionToken), rev, offset };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#key)
      .update(CURSOR_DOMAIN).update(payload).digest("base64url");
    return payload + "." + signature;
  }

  #verifyCursor(
    cursor: string, sessionToken: string, scope: CursorClaims["scope"],
  ): Pick<CursorClaims, "rev" | "offset"> | null {
    if (cursor.length === 0 || cursor.length > MAX_TOKEN_LENGTH || !CURSOR_PATTERN.test(cursor)) {
      return null;
    }
    try {
      const [payload, encodedSignature] = cursor.split(".");
      const bytes = Buffer.from(payload, "base64url");
      const actual = Buffer.from(encodedSignature, "base64url");
      if (payload !== bytes.toString("base64url") ||
          encodedSignature !== actual.toString("base64url")) return null;
      const expected = createHmac("sha256", this.#key)
        .update(CURSOR_DOMAIN).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const claims: CursorClaims = JSON.parse(bytes.toString("utf8"));
      if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
          Object.keys(claims).sort().join(",") !== "offset,rev,scope,sid,v" ||
          claims.v !== 2 || claims.scope !== scope ||
          claims.sid !== digest(sessionToken) ||
          typeof claims.rev !== "string" || !REVISION_PATTERN.test(claims.rev) ||
          !Number.isSafeInteger(claims.offset) || claims.offset < 1 ||
          claims.offset > MAX_STAGING_PAGE_OFFSET) return null;
      return { rev: claims.rev, offset: claims.offset };
    } catch {
      return null;
    }
  }

  /**
   * The session authority deliberately forbids legacy raw afterTaskId paging.
   * Any change to the staging snapshot makes the next page fail closed with
   * stale_cursor and no task content; the client must restart from page one.
   * Lower-level R1 fixture readers retain their existing keyset API.
   */
  list(
    sessionToken: string,
    request: StableStagingTaskListRequest,
  ): StableStagingTaskListResult {
    const credential = this.#credential(sessionToken);
    if (!credential) return deniedList();
    if (!request || typeof request !== "object" ||
        "actorUserId" in request || "afterTaskId" in request ||
        "offset" in request ||
        !["personal", "shared", "my-plan"].includes(request.scope) ||
        (request.limit !== undefined &&
          (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) ||
        (request.cursor !== undefined && request.cursor !== null &&
          typeof request.cursor !== "string")) return invalidList();
    const prior = request.cursor == null ? null :
      this.#verifyCursor(request.cursor, sessionToken, request.scope);
    if (request.cursor != null && !prior) return invalidList();

    const offset = prior?.offset ?? 0;
    const page = listRevisionedPreflightedIsolatedTargetTasksAtOffset(this.#store, credential, {
      scope: request.scope, limit: request.limit, offset,
    });
    if (page.result.ok === false) return {
      ok: false, reason: page.result.reason, tasks: [], nextCursor: null,
    };
    if (!page.revision || (prior && prior.rev !== page.revision)) return staleList();
    const nextOffset = offset + page.result.tasks.length;
    // Never emit a cursor the verifier cannot accept, nor return a partial
    // page whose remaining items cannot be reached within the bounded protocol.
    if (page.result.hasMore && nextOffset > MAX_STAGING_PAGE_OFFSET) return invalidList();
    return {
      ok: true,
      tasks: page.result.tasks,
      nextCursor: page.result.hasMore ?
        this.#signCursor(sessionToken, request.scope, page.revision, nextOffset) : null,
    };
  }

  /**
   * Read-only preview of a future task title write. It can never authorize
   * a subsequent write without an independent transactional recheck.
   * Read-only viewers, nonexistent tasks and foreign private tasks all yield
   * the same content-free unavailable result.
   */
  previewTaskTitleEdit(
    sessionToken: string,
    request: TargetTaskTitleEditPreviewRequest,
    privateOnly = false,
  ): TargetTaskTitleEditPreviewResult {
    const credential = this.#credential(sessionToken);
    if (!credential) return { ok: false, reason: "unauthorized", snapshotRevision: null };
    if (!validTargetTaskTitleEditPreviewRequest(request)) {
      return { ok: false, reason: "invalid_request", snapshotRevision: null };
    }
    return previewPreflightedTargetTaskTitleEdit(this.#store, credential, request, privateOnly);
  }

  /**
   * Explicit staging-only transactional mutation. Never accessible from a
   * public route: the authority binds a process-local, revocable session and
   * the writer revalidates identity, live Area ACL and expected revision under
   * BEGIN IMMEDIATE. A preview alone cannot authorize this command.
   */
  updateTaskTitle(
    sessionToken: string,
    request: TargetStagingTaskTitleWriteRequest,
    privateOnly = false,
    durableSessionTokenHash?: string,
  ): TargetStagingTaskTitleWriteResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTaskTitleWriteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    // R2-ID.1: when the HTTP identity is a durable staging session, the writer
    // re-verifies that session inside its BEGIN IMMEDIATE transaction.
    return writePreflightedTargetTaskTitle(
      this.#store, credential, request, privateOnly, durableSessionTokenHash,
    );
  }

  updateProjectTitle(sessionToken: string, request: ProjectTitleCommand,
    expectedActorUserId: string, durableSessionTokenHash?: string): ProjectTitleResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return {ok:false,reason:"unauthorized"};
    if (!validProjectTitleCommand(request)) return {ok:false,reason:"invalid_request"};
    return writeTargetProjectTitle(this.#store, credential, request, expectedActorUserId, durableSessionTokenHash);
  }

  /** Durable cancellation of a command which may have been lost after reload. */
  cancelProjectTitle(sessionToken:string,request:ProjectTitleCancelCommand,
    expectedActorUserId:string,durableSessionTokenHash?:string):ProjectTitleCancelResult{
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    if(!validProjectTitleCancelCommand(request))return {ok:false,reason:"invalid_request"};
    return cancelTargetProjectTitle(this.#store,credential,request,expectedActorUserId,durableSessionTokenHash);
  }

  /**
   * R2d.3h.1: staging-only complete/reopen. Never derive an actor from input;
   * require a live writable authority session, then recheck ACL and optional
   * durable session inside the pinned write transaction. No HTTP/UI activation.
   */
  changeTemporalTaskStatus(
    sessionToken: string, command: TargetStagingTemporalStatusCommand,
    durableSessionTokenHash?: string,
  ): TargetStagingTemporalStatusResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return {ok:false,reason:"unauthorized"};
    if (!validTargetStagingTemporalStatusCommand(command))
      return {ok:false,reason:"invalid_request"};
    return writePreflightedTemporalTaskStatus(
      this.#store,credential,command,durableSessionTokenHash);
  }

  /**
   * R2d.3i.1: isolated, staging-only date-only dueOn mutation, not HTTP.
   * A writable authority token is mandatory; the pinned writer checks live
   * ACL, optional durable-session revocation and task/Area CAS under lock.
   */
  changeTemporalDueOn(
    sessionToken: string, command: TargetStagingTemporalDueOnCommand,
    durableSessionTokenHash?: string,
  ): TargetStagingTemporalDueOnResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTemporalDueOnCommand(command))
      return { ok: false, reason: "invalid_request" };
    return writePreflightedTemporalDueOn(
      this.#store, credential, command, durableSessionTokenHash);
  }

  /** One authenticated pinned snapshot for the actor's own whenOn command. */
  previewPersonalWhen(actorUserId:string,taskId:string):PersonalWhenCommandPreview|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedPersonalWhenCommandPreview(
        this.#store,credential,taskId):null;
    }catch{return null;}
  }

  /** BE-06: read-only private scheduling receipt and live-release witness. */
  personalWhenReceiptSnapshot(
    sessionToken:string,command:TargetStagingPersonalWhenCommand,
  ):TargetPersonalWhenReceiptSnapshot {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"inaccessible"};
    return readPreflightedPersonalWhenReceiptSnapshot(this.#store,credential,command);
  }

  /** Read-only outcome reconciliation requires a WRITE credential and current
   * task/Area/assignee authorization before the receipt lookup. */
  personalWhenReceipt(
    sessionToken:string,command:TargetStagingPersonalWhenCommand,
  ):TargetPersonalWhenReceiptResult {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    return readPreflightedPersonalWhenReceipt(this.#store,credential,command);
  }

  /** R2d.3k.4a: actor-private plan CAS, isolated staging only. */
  changePersonalWhen(
    sessionToken:string,command:TargetStagingPersonalWhenCommand,
    durableSessionTokenHash?:string,
  ):TargetStagingPersonalWhenResult {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    if(!validTargetStagingPersonalWhenCommand(command))
      return {ok:false,reason:"invalid_request"};
    return writePreflightedPersonalWhen(
      this.#store,credential,command,durableSessionTokenHash);
  }

  /** R2d.5b.2: actor-private Attention snooze/dismiss/restore, isolated staging only. */
  changeAttentionLifecycle(
    sessionToken:string,command:TargetStagingAttentionLifecycleCommand,
    durableSessionTokenHash?:string,
  ):TargetStagingAttentionLifecycleResult {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    if(!validTargetStagingAttentionLifecycleCommand(command))
      return {ok:false,reason:"invalid_request"};
    return writePreflightedAttentionLifecycle(
      this.#store,credential,command,durableSessionTokenHash);
  }

  /** R2d.5d.2: actor-private notification settings CAS, isolated staging only. */
  changeNotificationSettings(
    sessionToken:string,command:TargetStagingNotificationSettingsCommand,
    durableSessionTokenHash?:string,
  ):TargetStagingNotificationSettingsResult {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    if(!validTargetStagingNotificationSettingsCommand(command))
      return {ok:false,reason:"invalid_request"};
    return writePreflightedNotificationSettings(
      this.#store,credential,command,durableSessionTokenHash);
  }

  /** R2d.5d.2: register/revoke the actor's OWN push target (endpoint hash only). */
  changePushTarget(
    sessionToken:string,command:TargetStagingPushTargetCommand,
    durableSessionTokenHash?:string,
  ):TargetStagingPushTargetResult {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"unauthorized"};
    if(!validTargetStagingPushTargetCommand(command))
      return {ok:false,reason:"invalid_request"};
    return writePreflightedPushTarget(
      this.#store,credential,command,durableSessionTokenHash);
  }

  /** R2d.5d.2: the actor's own settings, epoch and live target IDs (no hashes). */
  readNotificationSettings(actorUserId:string):TargetNotificationSettingsView|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedStoreSnapshot(this.#store,db=>
        verifiedActor(db,credential)===actorUserId
          ? readNotificationSettingsInSnapshot(db,actorUserId):null):null;
    }catch{return null;}
  }

  /** R2d.5d.2: one identity-bound Attention push pass with an INJECTED sender.
   * Identities come from the verified store, never from a caller. No timer, no
   * network: a scheduler/real web-push is wired only at the R4 cutover. */
  runAttentionPushPass(
    nowMs:number,sender:TargetPushSender,clock?:()=>number,
  ):Promise<TargetAttentionPushPassSummary> {
    if(this.#closed)return Promise.resolve({users:0,sent:0,
      held:{quiet_hours:0,daily_limit:0,disabled:0}});
    return runTargetAttentionPushPass(this.#store,{nowMs,sender,clock,
      credentialFor:userId=>{
        try{return this.#oneShotReadCredential(userId);}catch{return null;}
      }});
  }

  /** R2d.5c.2: one pinned snapshot with the actor's Attention CAS inputs. */
  previewAttentionCommand(
    actorUserId:string,taskId:string,ruleId:TargetAttentionLifecycleRuleId,
    occurrenceOn:string,nowMs:number,
  ):AttentionCommandPreview|null {
    if(this.#closed)return null;
    try {
      const credential=this.#oneShotReadCredential(actorUserId);
      return credential?readPreflightedAttentionCommandPreview(
        this.#store,credential,taskId,ruleId,occurrenceOn,nowMs):null;
    }catch{return null;}
  }

  /** R2d.5c.2: read-only Attention receipt (WRITE credential, ACL first) and
   * live-release witness from one pinned snapshot. */
  attentionReceiptSnapshot(
    sessionToken:string,command:TargetStagingAttentionLifecycleCommand,nowMs:number,
  ):TargetAttentionReceiptSnapshot {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"inaccessible"};
    return readPreflightedAttentionReceiptSnapshot(this.#store,credential,command,nowMs);
  }

  /** BE-07: current actor's pinned dueOn receipt and live-release witness. */
  temporalDueOnReceiptSnapshot(
    sessionToken:string,command:TargetStagingTemporalDueOnCommand,
  ):TargetTemporalDueOnReceiptSnapshot {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"inaccessible"};
    return readPreflightedTemporalDueOnReceiptSnapshot(this.#store,credential,command);
  }

  /** R2d.3i.2: read-only command reconciliation with current live write ACL. */
  temporalDueOnReceipt(
    sessionToken:string,command:TargetStagingTemporalDueOnCommand,
  ):TargetTemporalDueOnReceiptResult {
    const credential=this.#credential(sessionToken,true);
    if (!credential) return {ok:false,reason:"unauthorized"};
    return readPreflightedTemporalDueOnReceipt(this.#store,credential,command);
  }

  /** BE-05 actor-scoped pinned receipt plus task/parent live-release witness. */
  temporalStatusReceiptSnapshot(
    sessionToken:string,command:TargetStagingTemporalStatusCommand,
  ):TargetTemporalStatusReceiptSnapshot {
    const credential=this.#credential(sessionToken,true);
    if(!credential)return {ok:false,reason:"inaccessible"};
    return readPreflightedTemporalStatusReceiptSnapshot(this.#store,credential,command);
  }

  /** Read-only current-write-ACL-bound receipt check, no mutation. */
  temporalStatusReceipt(
    sessionToken:string,command:TargetStagingTemporalStatusCommand,
  ):TargetTemporalStatusReceiptResult {
    const credential=this.#credential(sessionToken,true);
    if (!credential) return {ok:false,reason:"unauthorized"};
    return readPreflightedTemporalStatusReceipt(this.#store,credential,command);
  }

  /**
   * R2d.2c.2a isolated note edits. This method is NOT an HTTP endpoint.
   * The process-local write credential is checked here; the pinned writer
   * rechecks current Area policy and an optional durable session under lock.
   */
  updateNote(
    sessionToken: string,
    request: TargetStagingNoteEditRequest,
    durableSessionTokenHash?: string,
  ): TargetStagingNoteEditResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingNoteEditRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return editPreflightedTargetNote(this.#store, credential, request, durableSessionTokenHash);
  }

  /**
   * Staging-only note delete. An HTTP DELETE child may invoke it; callers must
   * possess a signed write-audience credential. Durable-session and live Area
   * permissions are checked again inside the pinned SQLite transaction.
   */
  deleteNote(
    sessionToken: string,
    request: TargetStagingNoteDeleteRequest,
    durableSessionTokenHash?: string,
  ): TargetStagingNoteDeleteResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingNoteDeleteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return deletePreflightedTargetNote(this.#store, credential, request, durableSessionTokenHash);
  }

  /** v19 staging-only authenticated note creation or movement.
   * HTTP may use the privateCreateOnly restriction. All ACL and session checks are
   * independently repeated under the pinned BEGIN IMMEDIATE writer lock.
   */
  changeNoteLifecycle(
    sessionToken: string,
    request: TargetStagingNoteLifecycleRequest,
    durableSessionTokenHash?: string,
    privateCreateOnly = false,
  ): TargetStagingNoteLifecycleResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok:false, reason:"unauthorized" };
    if (!validTargetStagingNoteLifecycleRequest(request))
      return {ok:false, reason:"invalid_request"};
    return changePreflightedTargetNoteLifecycle(
      this.#store,credential,request,durableSessionTokenHash,privateCreateOnly);
  }

  projectTitleRecovery(sessionToken:string,commandId:string):TargetProjectTitleRecovery{
    const credential=this.#credential(sessionToken,true);
    return credential?readPreflightedProjectTitleRecovery(this.#store,credential,commandId)
      :{ok:false,reason:"unavailable"};
  }

  /** Read-only actor-scoped recovery of a note edit after browser reload. */
  noteEditRecovery(sessionToken:string,commandId:string):TargetNoteEditRecovery{
    const credential=this.#credential(sessionToken,true);
    return credential?readPreflightedTargetNoteEditRecovery(this.#store,credential,commandId)
      :{ok:false,reason:"unavailable"};
  }

  /** R3-CAPTURE-2: one content-free CREATE receipt for its signed writer. */
  noteCreateRecovery(sessionToken:string,commandId:string):TargetNoteCreateRecovery{
    const credential=this.#credential(sessionToken,true);
    return credential
      ?readPreflightedTargetNoteCreateRecovery(this.#store,credential,commandId)
      :{ok:false,reason:"unavailable"};
  }

  /** Read-only status of the exact note edit for its current authorized writer. */
  noteEditCommandStatus(
    sessionToken: string,
    request: TargetStagingNoteEditRequest,
  ): TargetNoteEditCommandStatus | { ok: false; reason: "unauthorized" } {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    return readPreflightedTargetNoteEditCommandStatus(this.#store, credential, request);
  }

  /** Read-only, actor-scoped verification of an uncertain note deletion. */
  noteDeleteCommandStatus(
    sessionToken: string,
    request: TargetStagingNoteDeleteRequest,
  ): TargetNoteDeleteCommandStatus | { ok: false; reason: "unauthorized" } {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingNoteDeleteRequest(request))
      return { ok: false, reason: "invalid_request" };
    return readPreflightedTargetNoteDeleteCommandStatus(this.#store, credential, request);
  }

  /**
   * R3-BE-4c core-only: one standalone private task create. This is not an
   * HTTP endpoint and does not grant access to shared projects/Areas.
   * Session and Area ACL are verified again under the pinned write lock.
   */
  createPrivateTask(
    sessionToken: string,
    request: PrivateTaskCreateCommand,
    durableSessionTokenHash?: string,
  ): PrivateTaskCreateResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return {ok:false,reason:"unauthorized"};
    if (!validPrivateTaskCreateCommand(request)) return {ok:false,reason:"invalid_request"};
    return createPreflightedPrivateTask(
      this.#store,credential,request,durableSessionTokenHash);
  }

  /** Actor-bound cancellation fence, serialized with the original CREATE. */
  cancelPrivateTaskCreate(
    sessionToken:string,commandId:string,durableSessionTokenHash?:string,
  ):PrivateTaskCreateCancelResult{
    const credential=this.#credential(sessionToken,true);
    return credential
      ?cancelPreflightedPrivateTaskCreate(
        this.#store,credential,commandId,durableSessionTokenHash)
      :{ok:false,reason:"unauthorized"};
  }

  /** Exact-command, read-only reconciliation for a private task CREATE.
   * A foreign actor, inaccessible Area or reused command cannot reveal data. */
  privateTaskCreateStatus(
    sessionToken: string, command: PrivateTaskCreateCommand,
  ): PrivateTaskCreateStatus {
    const credential = this.#credential(sessionToken,true);
    return credential
      ? readPreflightedPrivateTaskCreateStatus(this.#store,credential,command)
      : {ok:false,reason:"unavailable"};
  }

  /** UUID-only private task recovery; the actor is never supplied by the client. */
  privateTaskCreateRecovery(
    sessionToken:string,commandId:string,
  ):PrivateTaskCreateRecovery{
    const credential=this.#credential(sessionToken,true);
    return credential
      ?readPreflightedPrivateTaskCreateRecovery(this.#store,credential,commandId)
      :{ok:false,reason:"unavailable"};
  }

  /**
   * R2c.1 idempotent task delete (tombstone). Same write audience, live-ACL and
   * in-transaction durable-session guarantees as updateTaskTitle.
   */
  deleteTask(
    sessionToken: string,
    request: TargetStagingTaskDeleteRequest,
    privateOnly = false,
    durableSessionTokenHash?: string,
  ): TargetStagingTaskDeleteResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTaskDeleteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return deletePreflightedTargetTask(
      this.#store, credential, request, privateOnly, durableSessionTokenHash,
    );
  }

  /** Read-only reconciliation of a delete command (see taskTitleCommandStatus). */
  taskDeleteCommandStatus(
    sessionToken: string,
    request: TargetStagingTaskDeleteRequest,
    privateOnly = false,
  ): TargetStagingTaskDeleteStatusResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTaskDeleteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return readPreflightedTargetTaskDeleteCommandStatus(this.#store, credential, request, privateOnly);
  }

  /**
   * R2-ID.2a shared-Area membership command. Needs a write-audience token; the
   * actor comes from the token, never from the command. A durable session hash
   * is re-verified inside the write transaction.
   */
  applyMembershipCommand(
    sessionToken: string,
    command: TargetStagingMembershipCommand,
    durableSessionTokenHash?: string,
  ): TargetStagingMembershipResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthenticated" };
    if (!validTargetStagingMembershipCommand(command)) return { ok: false, reason: "invalid_request" };
    return applyTargetStagingMembershipCommand(
      this.#store, credential, command, durableSessionTokenHash,
    );
  }

  /**
   * Read-only durable command reconciliation. A caller may ask whether its
   * exact authorized write was committed without issuing a second mutation.
   * The full write-audience token and live Area ACL are checked again.
   */
  taskTitleCommandStatus(
    sessionToken: string,
    request: TargetStagingTaskTitleWriteRequest,
    privateOnly = false,
  ): TargetStagingTaskTitleCommandStatusResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTaskTitleWriteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return readPreflightedTargetTaskTitleCommandStatus(this.#store, credential, request, privateOnly);
  }

  detail(
    sessionToken: string,
    request: TargetStagingTaskDetailRequest,
  ): AuthenticatedTargetTaskDetailResult {
    const credential = this.#credential(sessionToken);
    return credential ? readPreflightedIsolatedTargetTask(this.#store, credential, request) : deniedDetail();
  }

  /** Revocation affects both list and detail reads immediately, synchronously. */
  revoke(sessionToken: string): boolean {
    if (this.#closed || typeof sessionToken !== "string" ||
        sessionToken.length === 0 || sessionToken.length > MAX_TOKEN_LENGTH) return false;
    return this.#active.delete(digest(sessionToken));
  }

  /**
   * Server-side sign-out across all sessions bound to a verified actor.
   *
   * The caller must derive actorUserId from trusted server-side authentication,
   * never directly from a user-controlled sign-out or revoke request.
   * This staging-only primitive is not a public HTTP endpoint.
   */
  revokeActor(actorUserId: string): number {
    if (this.#closed || typeof actorUserId !== "string") return 0;
    let count = 0;
    for (const [key, session] of this.#active) {
      if (session.actor === actorUserId) {
        this.#active.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Make all sessions unusable and erase this authority's in-memory key. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#active.clear();
    this.#key.fill(0);
  }
}




