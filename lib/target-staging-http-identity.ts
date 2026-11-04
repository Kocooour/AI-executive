/**
 * R2-ID.1 staging-only HTTP identity for /api/target-staging/* routes.
 *
 * Two proofs exist and never mix:
 *  - the existing owner cookie (maps to AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID), and
 *  - a durable staging session cookie, resolved to a userId against the LIVE
 *    staging store (not revoked, not expired, epoch current).
 * If a staging session cookie is present it alone decides the identity: a
 * missing, malformed or revoked session never falls back to the owner cookie.
 * There is no endpoint which issues this cookie; issuance is operator-only.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { TargetTaskBacklinkLiveGuard } from "./target-parent-backlinks";
import type { TargetTemporalTaskLiveGuard } from "./target-task-temporal-read-model";
import type { HomeSummaryAreaEpoch } from "./target-my-plan-home-summary";
import type { TargetHomeScope } from "./target-scoped-home-summary";
import { getAuthState, requestCookie } from "./auth";
import { enforceRateLimit } from "./http-security";
import { logStagingFailure } from "./target-staging-failure-log";
import {
  TARGET_STAGING_SESSION_COOKIE, hashTargetStagingSessionToken,
  isTargetStagingSessionToken, verifyDurableTargetStagingSessionLiveCoded, verifyTargetStagingReadLive,
  checkTargetStagingAnchorLive,
} from "./target-staging-durable-session";
import type { TargetReadLinearization } from "./target-task-read-model";
import type { TargetProjectReadLiveGuard, TargetProjectIndexLiveGuard, TargetNoteReadLiveGuard, TargetNoteSyncLiveGuard } from "./target-staging-durable-session";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

export type StagingHttpIdentity =
  | { readonly kind: "owner" }
  | { readonly kind: "session"; readonly tokenHash: string };

/**
 * "unauthorized" is an owner-cookie failure (or a misconfigured server): 401 with the
 * unchanged, code-less body. The R2c.2b codes only ever describe the durable session
 * token which the caller itself presented.
 */
export type StagingIdentityCheck =
  | "ok" | "unauthorized" | "unavailable" | "session_expired" | "session_revoked" | "session_restored";

/** Null means: no valid proof of any kind was presented (HTTP 401). */
export function resolveStagingHttpIdentity(request: Request): StagingHttpIdentity | null {
  const sessionCookie = requestCookie(request, TARGET_STAGING_SESSION_COOKIE);
  if (sessionCookie !== undefined) {
    // Session identity still requires real, configured server authentication
    // (the cursor signing secret); the insecure development bypass never applies.
    const auth = getAuthState(request);
    if (!auth.enabled || !auth.configured || !isTargetStagingSessionToken(sessionCookie)) return null;
    return { kind: "session", tokenHash: hashTargetStagingSessionToken(sessionCookie) };
  }
  // isAuthenticated alone accepts an insecure development bypass. These routes
  // deliberately require real, configured owner-cookie authentication.
  const auth = getAuthState(request);
  return auth.enabled && auth.configured && auth.authenticated ? { kind: "owner" } : null;
}

/** Child-process configuration fragment; only the token HASH ever leaves this process. */
export function stagingChildSessionConfig(
  identity: StagingHttpIdentity,
): { sessionTokenHash?: string } {
  return identity.kind === "session" ? { sessionTokenHash: identity.tokenHash } : {};
}

/**
 * Cursor binding. An owner cursor keeps its existing binding (owner actor +
 * owner-cookie hash). A session cursor is bound to the session itself, so it
 * cannot transfer to another identity, session or the owner path.
 */
export function stagingCursorIdentity(
  identity: StagingHttpIdentity, ownerUserId: string, ownerBinding: string,
): { actorUserId: string; authenticationBinding: string } {
  if (identity.kind === "owner") {
    return { actorUserId: ownerUserId, authenticationBinding: ownerBinding };
  }
  return {
    actorUserId: "staging-session",
    authenticationBinding: createHash("sha256")
      .update("lumi:r2-id:staging-session-cursor\0" + identity.tokenHash).digest("base64url"),
  };
}

/**
 * Read-side linearization point: call this synchronously immediately before a
 * response body is released (after any child-process read returned). A durable
 * session is re-verified against the authoritative LIVE store, not against any
 * snapshot; revoked or expired yields "unauthorized" and the caller returns 401
 * with no data. Deliberately a standalone export so tests can interleave a
 * revocation from another process between "read finished" and "release".
 */
export function verifyStagingIdentityBeforeRelease(
  request: Request, identity: StagingHttpIdentity, store: TargetStagingReadStore,
  stage: "admission" | "release" = "release",
): StagingIdentityCheck {
  if (identity.kind === "owner") {
    const auth = getAuthState(request);
    return auth.enabled && auth.configured && auth.authenticated ? "ok" : "unauthorized";
  }
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured) return "unauthorized";
  const live = verifyDurableTargetStagingSessionLiveCoded(store, identity.tokenHash);
  if (live.ok === true) return "ok";
  if (live.reason === "unavailable") logStagingFailure(stage === "admission" ? "identity_admission" : "identity_release", "live_read_unavailable");
  return live.reason === "invalid" ? live.code : "unavailable";
}

export type StagingReadCheck = StagingIdentityCheck | "stale";

/**
 * R2-ID.2b read linearization point for shared / my-plan lists and shared
 * detail. Same position as verifyStagingIdentityBeforeRelease, but additionally
 * proves, in the same single live read transaction, that every Area which
 * contributed to the child's snapshot is still readable by the actor with the
 * observed role and policy_revision. "unauthorized" (dead session, 401) is
 * evaluated before "stale" (membership moved, 409 list / 404 detail). The
 * owner-cookie identity gets the same Area check for its configured owner user.
 */
export function verifyStagingReadBeforeRelease(
  request: Request, identity: StagingHttpIdentity, store: TargetStagingReadStore,
  ownerUserId: string, observed: TargetReadLinearization,
  projectGuard?: TargetProjectReadLiveGuard,
  projectIndexGuard?: TargetProjectIndexLiveGuard,
  noteGuard?: TargetNoteReadLiveGuard,
  noteSyncGuard?: TargetNoteSyncLiveGuard,
  taskBacklinkGuard?: TargetTaskBacklinkLiveGuard,
  homeSummaryGuard?: { areas: HomeSummaryAreaEpoch[]; scope?: TargetHomeScope | "global-all" },
  temporalTaskGuard?: TargetTemporalTaskLiveGuard,
  /** Server-derived actor-private epoch; never accept it from HTTP input. */
  personalPlanGuard?: {privateEpoch:number},
): StagingReadCheck {
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured) return "unauthorized";
  if (identity.kind === "owner" && !auth.authenticated) return "unauthorized";
  const live = verifyTargetStagingReadLive(store,
    identity.kind === "owner" ? { ownerUserId } : { tokenHash: identity.tokenHash },
    observed, Date.now(), projectGuard, projectIndexGuard, noteGuard, noteSyncGuard,
    taskBacklinkGuard, homeSummaryGuard, temporalTaskGuard, personalPlanGuard);
  if (live.ok === true) return "ok";
  if (live.reason === "unavailable") logStagingFailure("scoped_release", "live_read_unavailable");
  return live.reason === "invalid" ? live.code : live.reason === "stale" ? "stale" : "unavailable";
}

/**
 * Mandatory note-specific release entry point for a future note HTTP route.
 * Unlike the generic project/list read helper, callers must supply the exact
 * server-derived note/parent revision guard from the preflighted snapshot.
 * A null/undefined or client-provided guard is never an authorization proof.
 */
export function verifyStagingNoteBeforeRelease(
  request: Request, identity: StagingHttpIdentity, store: TargetStagingReadStore,
  ownerUserId: string, observed: TargetReadLinearization,
  noteGuard: TargetNoteReadLiveGuard,
): StagingReadCheck {
  if (!noteGuard) return "unavailable";
  return verifyStagingReadBeforeRelease(
    request, identity, store, ownerUserId, observed,
    undefined, undefined, noteGuard,
  );
}

const headers = { "cache-control": "no-store" };
const unavailableMessage = "Staging unavailable";

const answer = (status: number, message: string): Response =>
  Response.json({ error: message }, { status, headers });
const coded = (code: "session_expired" | "session_revoked" | "session_restored"): Response =>
  Response.json({ error: "Authentication required", code }, { status: 401, headers });

/** Content-free refusal for a failed identity check; always no-store. */
export function stagingIdentityRefusal(check: Exclude<StagingIdentityCheck, "ok">): Response {
  if (check === "session_expired" || check === "session_revoked" || check === "session_restored") {
    return coded(check);
  }
  return check === "unauthorized"
    ? answer(401, "Authentication required")
    : answer(503, "Staging unavailable");
}

/**
 * R2c.4a anti-rollback gate: call right after the feature-flag 404 and BEFORE identity
 * resolution. A store whose anchor is behind the irreversible journal (`restore_pending`) or whose
 * journal cannot be verified (`journal_invalid`) answers 503 with a stable code and no
 * data on every target-staging route. Missing/invalid configuration is handled
 * by each route. By default an unreadable store is also delegated to the route;
 * note HTTP uses failOnUnavailable=true to fail with 503 before reading content.
 * Content-free and independent of any credential.
 */
export function stagingAnchorRefusal(
  request: Request, failOnUnavailable = false,
): Response | null {
  try {
    const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
    const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
    if (!stagingDirectory || !path.isAbsolute(stagingDirectory) || !expectedRestoreGeneration) return null;
    // The check costs a SQLite open plus the journal verification: a client floods only
    // its own bucket (separate from every per-route bucket).
    const limited = enforceRateLimit(request, "target-staging-anchor-gate", 1200, 10 * 60_000);
    if (limited) return Response.json({ error: "Too many requests" }, {
      status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
    const verdict = checkTargetStagingAnchorLive({ stagingDirectory, expectedRestoreGeneration });
    // Ordinary staging routes retain their existing child/live-check behavior.
    // Note HTTP opts into strict readiness: if the live source cannot be verified,
    // return a content-free 503 before any child read or note-existence lookup.
    // This distinguishes server misconfiguration from unauthorized/missing notes.
    if (verdict === "ok" || (verdict === "unavailable" && !failOnUnavailable)) return null;
    if (verdict === "unavailable") return answer(503, unavailableMessage);
    return Response.json({ error: unavailableMessage, code: verdict }, { status: 503, headers });
  } catch {
    return answer(503, "Staging unavailable");
  }
}

/**
 * 401 for a request which resolved to NO identity. A staging session cookie which
 * is present but malformed is a dead credential (`session_revoked`); no session
 * cookie, or an owner-cookie failure, keeps the unchanged code-less body.
 */
export function stagingUnauthenticatedRefusal(request: Request): Response {
  try {
    if (requestCookie(request, TARGET_STAGING_SESSION_COOKIE) !== undefined) {
      const auth = getAuthState(request);
      if (auth.enabled && auth.configured) return coded("session_revoked");
    }
  } catch { /* fall through to the code-less body */ }
  return answer(401, "Authentication required");
}

/**
 * 401 after a write child reported the session as unauthorized inside its own
 * transaction: the live store (not the child) classifies the presented token.
 * Owner-cookie and unclassifiable cases keep the code-less body.
 */
export function stagingUnauthorizedRefusal(
  request: Request, identity: StagingHttpIdentity, store: TargetStagingReadStore,
): Response {
  if (identity.kind === "session") {
    try {
      const check = verifyStagingIdentityBeforeRelease(request, identity, store, "release");
      if (check === "session_expired" || check === "session_revoked" || check === "session_restored") {
        return coded(check);
      }
    } catch { /* fall through to the code-less body */ }
  }
  return answer(401, "Authentication required");
}

/**
 * Admission gate run before any rate-limited work or child dispatch. A durable
 * session costs an fd enumeration plus a synchronous SQLite open per check, so
 * it is throttled per client first (600 per 10 minutes, a bucket separate from
 * the per-route ones; a blocked client stops charging the global budget, so a
 * forged-cookie flooder only blocks itself). The owner path does no database
 * work and is unchanged. Returns a refusal Response, or null to proceed. An
 * unexpected throw maps to the existing 503 instead of a framework 500.
 */
export function admitStagingIdentity(
  request: Request, identity: StagingHttpIdentity, store: TargetStagingReadStore,
): Response | null {
  try {
    if (identity.kind === "session") {
      const limited = enforceRateLimit(request, "target-staging-session-check", 600, 10 * 60_000);
      if (limited) return Response.json({ error: "Too many requests" }, {
        status: 429, headers: { ...headers, "retry-after": String(limited.retryAfter) },
      });
    }
    const check = verifyStagingIdentityBeforeRelease(request, identity, store, "admission");
    return check === "ok" ? null : stagingIdentityRefusal(check);
  } catch (error) {
    logStagingFailure("identity_admission", "exception", error);
    return stagingIdentityRefusal("unavailable");
  }
}
