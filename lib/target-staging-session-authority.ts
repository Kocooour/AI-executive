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
  TARGET_STAGING_TASK_READ_AUDIENCE, TARGET_STAGING_TASK_WRITE_AUDIENCE,
} from "./target-task-authenticated-read";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";
import type {
  AuthenticatedTargetTaskDetailResult, AuthenticatedTargetTaskListResult,
  TargetStagingTaskDetailRequest, TargetStagingTaskListRequest,
} from "./target-task-authenticated-read";
import {
  listPreflightedIsolatedTargetTasks, listRevisionedPreflightedIsolatedTargetTasksAtOffset,
  previewPreflightedTargetTaskTitleEdit, readPreflightedIsolatedTargetTask,
  readPreflightedIsolatedPersonalTargetTask, readPreflightedTargetTaskTitleCommandStatus,
  listPreflightedPrivateProjectsAtOffset, readPreflightedPrivateProjectDetail,
  readPreflightedPrivateTaskTitleAudit,
} from "./target-task-staging-reader";
import type { TargetStagingReadStore, TargetPreflightedPrivateProjectDetail } from "./target-task-staging-reader";
import type { TargetPrivateProjectPage } from "./target-project-read-model";
import type { TargetPrivateTaskTitleAuditResult } from "./target-task-read-model";
import type { TargetStagingTaskTitleCommandStatusResult } from "./target-task-staging-reader";
import { validTargetTaskTitleEditPreviewRequest } from "./target-task-write-preflight";
import { writePreflightedTargetTaskTitle, validTargetStagingTaskTitleWriteRequest } from "./target-task-staging-writer";
import type { TargetStagingTaskTitleWriteRequest, TargetStagingTaskTitleWriteResult } from "./target-task-staging-writer";
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
  ): TargetStagingTaskTitleWriteResult {
    const credential = this.#credential(sessionToken, true);
    if (!credential) return { ok: false, reason: "unauthorized" };
    if (!validTargetStagingTaskTitleWriteRequest(request)) {
      return { ok: false, reason: "invalid_request" };
    }
    return writePreflightedTargetTaskTitle(this.#store, credential, request, privateOnly);
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



