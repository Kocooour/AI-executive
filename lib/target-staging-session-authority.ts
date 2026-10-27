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
  TARGET_STAGING_TASK_READ_AUDIENCE,
} from "./target-task-authenticated-read";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";
import type {
  AuthenticatedTargetTaskDetailResult, AuthenticatedTargetTaskListResult,
  TargetStagingTaskDetailRequest, TargetStagingTaskListRequest,
} from "./target-task-authenticated-read";
import {
  listPreflightedIsolatedTargetTasks, listRevisionedPreflightedIsolatedTargetTasksAtOffset,
  readPreflightedIsolatedTargetTask,
} from "./target-task-staging-reader";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

const TOKEN_DOMAIN = "lumi:r2:target-task-read:staging:v1\0";
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
}

export interface IssuedTargetStagingSession {
  /** Bearer token: return only to the specifically authenticated principal. */
  readonly sessionToken: string;
  /** Unix epoch seconds. */
  readonly expiresAt: number;
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
      aud: TARGET_STAGING_TASK_READ_AUDIENCE,
      sub: actorUserId,
      gen: this.#store.expectedRestoreGeneration,
      iat: now,
      exp: expiresAt,
      jti: randomUUID(),
    };
    try {
      const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = createHmac("sha256", this.#key)
        .update(TOKEN_DOMAIN).update(payload).digest("base64url");
      const sessionToken = payload + "." + signature;

      // The staging gateway performs canonical preflight, generation validation
      // and identity lookup. It returns ok even when personal tasks are empty.
      // Do not register or return sessions for missing/corrupt/activated stores.
      const check = listPreflightedIsolatedTargetTasks(this.#store,
        { signingKey: this.#key, sessionToken },
        { scope: "personal", limit: 1 });
      if (!check.ok) return null;

      this.#active.set(digest(sessionToken), { actor: actorUserId, expiresAt });
      return { sessionToken, expiresAt };
    } catch {
      return null;
    }
  }

  #credential(sessionToken: string): { signingKey: Uint8Array; sessionToken: string } | null {
    if (this.#closed || typeof sessionToken !== "string" ||
        sessionToken.length === 0 || sessionToken.length > MAX_TOKEN_LENGTH) return null;
    const now = Math.floor(Date.now() / 1000);
    this.#pruneExpired(now);
    if (!this.#active.has(digest(sessionToken))) return null;
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

