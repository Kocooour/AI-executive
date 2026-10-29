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
import { getAuthState, requestCookie } from "./auth";
import { enforceRateLimit } from "./http-security";
import {
  TARGET_STAGING_SESSION_COOKIE, hashTargetStagingSessionToken,
  isTargetStagingSessionToken, verifyDurableTargetStagingSessionLive, verifyTargetStagingReadLive,
} from "./target-staging-durable-session";
import type { TargetReadLinearization } from "./target-task-read-model";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

export type StagingHttpIdentity =
  | { readonly kind: "owner" }
  | { readonly kind: "session"; readonly tokenHash: string };

export type StagingIdentityCheck = "ok" | "unauthorized" | "unavailable";

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
): StagingIdentityCheck {
  if (identity.kind === "owner") {
    const auth = getAuthState(request);
    return auth.enabled && auth.configured && auth.authenticated ? "ok" : "unauthorized";
  }
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured) return "unauthorized";
  const live = verifyDurableTargetStagingSessionLive(store, identity.tokenHash);
  if (live.ok === true) return "ok";
  return live.reason === "invalid" ? "unauthorized" : "unavailable";
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
): StagingReadCheck {
  const auth = getAuthState(request);
  if (!auth.enabled || !auth.configured) return "unauthorized";
  if (identity.kind === "owner" && !auth.authenticated) return "unauthorized";
  const live = verifyTargetStagingReadLive(store,
    identity.kind === "owner" ? { ownerUserId } : { tokenHash: identity.tokenHash }, observed);
  if (live.ok === true) return "ok";
  return live.reason === "invalid" ? "unauthorized" : live.reason === "stale" ? "stale" : "unavailable";
}

const headers = { "cache-control": "no-store" };

const answer = (status: number, message: string): Response =>
  Response.json({ error: message }, { status, headers });

/** Content-free refusal for a failed identity check; always no-store. */
export function stagingIdentityRefusal(check: Exclude<StagingIdentityCheck, "ok">): Response {
  return check === "unauthorized"
    ? answer(401, "Authentication required")
    : answer(503, "Staging unavailable");
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
    const check = verifyStagingIdentityBeforeRelease(request, identity, store);
    return check === "ok" ? null : stagingIdentityRefusal(check);
  } catch {
    return stagingIdentityRefusal("unavailable");
  }
}
