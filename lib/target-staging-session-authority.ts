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
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  TARGET_STAGING_TASK_READ_AUDIENCE,
} from "./target-task-authenticated-read";
import type {
  AuthenticatedTargetTaskDetailResult, AuthenticatedTargetTaskListResult,
  TargetStagingTaskDetailRequest, TargetStagingTaskListRequest,
} from "./target-task-authenticated-read";
import {
  listPreflightedIsolatedTargetTasks, readPreflightedIsolatedTargetTask,
} from "./target-task-staging-reader";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

const TOKEN_DOMAIN = "lumi:r2:target-task-read:staging:v1\0";
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

  /** Both read methods enforce revocation/expiry before the existing gateway. */
  list(
    sessionToken: string,
    request: TargetStagingTaskListRequest,
  ): AuthenticatedTargetTaskListResult {
    const credential = this.#credential(sessionToken);
    return credential ? listPreflightedIsolatedTargetTasks(this.#store, credential, request) : deniedList();
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
