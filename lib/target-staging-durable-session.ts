/**
 * R2-ID.1 staging-only DURABLE session store: issuance, revocation and live
 * verification inside the same isolated staging SQLite as the task data.
 *
 * This is a server-side library, NOT an HTTP route. There is deliberately no
 * issuance endpoint: a route that mints a credential for a userId would be an
 * authentication bypass. Only a trusted operator (scripts/target-staging-session.mjs)
 * or test may call issue(), for synthetic test identities only.
 *
 * The raw token is returned exactly once and only its SHA-256 hash is stored.
 * Unlike the process-local TargetStagingSessionAuthority tokens, validity is
 * decided by the live store on every check, so revocation applies immediately
 * to every server process and survives restarts. A session is live only while
 * it is not revoked, not expired and its issue-time epoch still equals the
 * identity's revocation_epoch (sign-out everywhere).
 *
 * Writes reuse the pinned-fd + BEGIN IMMEDIATE discipline of the title writer.
 * Checks on the read side open the staging file read-only per call.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TARGET_STAGING_SESSION_MAX_LIFETIME_MS, TARGET_STORE_FILENAME,
  TARGET_STORE_SCHEMA_VERSION, verifyExistingTargetStagingPath,
} from "./target-store-bootstrap";
import { noTargetStagingSidecars, withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

export const TARGET_STAGING_SESSION_COOKIE = "lumi_target_staging_session";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH = /^[a-f0-9]{64}$/;
const USER_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIFETIME_SECONDS = 5 * 60;
const CONTROL_WRITE_BUSY_MS = 2_000;
const LIVE_READ_BUSY_MS = 2_000;

export type TargetStagingDurableSessionIssue =
  | { ok: true; sessionId: string; sessionToken: string; expiresAtMs: number }
  | { ok: false; reason: "invalid_request" | "unknown_user" | "unavailable" | "write_failed" };
export type TargetStagingDurableSessionRevoke =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "invalid_request" | "not_found" | "unavailable" | "write_failed" };
export type TargetStagingDurableUserRevoke =
  | { ok: true; revocationEpoch: number; revokedSessions: number }
  | { ok: false; reason: "invalid_request" | "not_found" | "unavailable" | "write_failed" };
export type TargetStagingLiveSession =
  | { ok: true; sessionId: string; userId: string }
  | { ok: false; reason: "invalid" | "unavailable" };

/** The only stored form of a session credential. */
export function hashTargetStagingSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap shape check before any hashing or store access. */
export function isTargetStagingSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function isTargetStagingSessionTokenHash(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HASH.test(value);
}

/**
 * Authoritative liveness predicate, shared by the HTTP release check, the
 * child readers and the title writer's in-transaction check. Run it on a
 * connection which already holds a consistent view (read snapshot or the
 * writer's BEGIN IMMEDIATE transaction).
 */
export function lookupLiveTargetStagingSession(
  db: DatabaseSync, tokenHash: string, nowMs: number,
): { sessionId: string; userId: string } | null {
  if (!TOKEN_HASH.test(tokenHash) || !Number.isSafeInteger(nowMs) || nowMs <= 0) return null;
  const row = db.prepare(`
    SELECT s.id AS id, s.user_id AS user_id
      FROM staging_sessions s JOIN identities i ON i.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
       AND s.revocation_epoch = i.revocation_epoch
  `).get(tokenHash, nowMs) as { id: string; user_id: string } | undefined;
  return row ? { sessionId: row.id, userId: row.user_id } : null;
}

/**
 * Issue a session for an existing synthetic identity. `userId` MUST come from
 * a trusted operator decision, never from a request. Lifetime is capped at 15
 * minutes. Returns the raw token once; it cannot be recovered afterwards.
 */
export function issueDurableTargetStagingSession(
  store: TargetStagingReadStore, userId: string,
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
): TargetStagingDurableSessionIssue {
  if (typeof userId !== "string" || !USER_ID.test(userId) ||
      !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 ||
      lifetimeSeconds * 1000 > TARGET_STAGING_SESSION_MAX_LIFETIME_MS) {
    return { ok: false, reason: "invalid_request" };
  }
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  return withPinnedTargetStagingWrite<TargetStagingDurableSessionIssue>(store, context => {
    const { db } = context;
    const identity = db.prepare("SELECT revocation_epoch FROM identities WHERE id = ?")
      .get(userId) as { revocation_epoch: number } | undefined;
    if (!identity) return { ok: false, reason: "unknown_user" };
    // Before the first write: afterwards SQLite's own -journal legitimately exists.
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const createdAt = Date.now();
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return { ok: false, reason: "write_failed" };
    const expiresAt = createdAt + lifetimeSeconds * 1000;
    const inserted = db.prepare(`
      INSERT INTO staging_sessions(
        id, user_id, token_hash, created_at_ms, expires_at_ms, revoked_at_ms, revocation_epoch
      ) VALUES (?,?,?,?,?,NULL,?)
    `).run(sessionId, userId, hashTargetStagingSessionToken(token), createdAt, expiresAt,
      identity.revocation_epoch);
    if (inserted.changes !== 1 || !context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit();
    return { ok: true, sessionId, sessionToken: token, expiresAtMs: expiresAt };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }),
  CONTROL_WRITE_BUSY_MS);
}

/** Irreversibly revoke one session. Repeating a revocation is a no-op success. */
export function revokeDurableTargetStagingSession(
  store: TargetStagingReadStore, sessionId: string,
): TargetStagingDurableSessionRevoke {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return { ok: false, reason: "invalid_request" };
  }
  return withPinnedTargetStagingWrite<TargetStagingDurableSessionRevoke>(store, context => {
    const { db } = context;
    const row = db.prepare("SELECT revoked_at_ms FROM staging_sessions WHERE id = ?")
      .get(sessionId) as { revoked_at_ms: number | null } | undefined;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.revoked_at_ms !== null) return { ok: true, changed: false };
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const revokedAt = Date.now();
    if (!Number.isSafeInteger(revokedAt) || revokedAt <= 0) return { ok: false, reason: "write_failed" };
    const updated = db.prepare(
      "UPDATE staging_sessions SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL",
    ).run(revokedAt, sessionId);
    if (updated.changes !== 1 || !context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit();
    return { ok: true, changed: true };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }),
  CONTROL_WRITE_BUSY_MS);
}

/**
 * Sign out everywhere: increment the identity's monotonic revocation epoch
 * (which invalidates every session issued earlier, even rows we cannot
 * enumerate) and stamp the still-open rows for operator visibility.
 */
export function revokeAllDurableTargetStagingSessionsForUser(
  store: TargetStagingReadStore, userId: string,
): TargetStagingDurableUserRevoke {
  if (typeof userId !== "string" || !USER_ID.test(userId)) return { ok: false, reason: "invalid_request" };
  return withPinnedTargetStagingWrite<TargetStagingDurableUserRevoke>(store, context => {
    const { db } = context;
    const identity = db.prepare("SELECT revocation_epoch FROM identities WHERE id = ?")
      .get(userId) as { revocation_epoch: number } | undefined;
    if (!identity) return { ok: false, reason: "not_found" };
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const revokedAt = Date.now();
    if (!Number.isSafeInteger(revokedAt) || revokedAt <= 0) return { ok: false, reason: "write_failed" };
    const bumped = db.prepare(
      "UPDATE identities SET revocation_epoch = revocation_epoch + 1 WHERE id = ?",
    ).run(userId);
    const stamped = db.prepare(
      "UPDATE staging_sessions SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL",
    ).run(revokedAt, userId);
    const after = db.prepare("SELECT revocation_epoch FROM identities WHERE id = ?")
      .get(userId) as { revocation_epoch: number } | undefined;
    if (bumped.changes !== 1 || !after || after.revocation_epoch !== identity.revocation_epoch + 1 ||
        !context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit();
    return { ok: true, revocationEpoch: after.revocation_epoch, revokedSessions: Number(stamped.changes) };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }),
  CONTROL_WRITE_BUSY_MS);
}

/**
 * Resolve a token hash against the LIVE store. This is the read-side linearization
 * primitive: HTTP routes call it before dispatching a child reader and again
 * immediately before releasing a response body, so a revocation committed by any
 * other process in between is observed. Every failure is fail-closed; "invalid"
 * (unknown, revoked, expired, stale epoch) is distinct from "unavailable"
 * (store/IO problem) only so that callers can choose 401 versus 503.
 */
export function verifyDurableTargetStagingSessionLive(
  store: TargetStagingReadStore, tokenHash: string, nowMs = Date.now(),
): TargetStagingLiveSession {
  const unavailable: TargetStagingLiveSession = { ok: false, reason: "unavailable" };
  if (!isTargetStagingSessionTokenHash(tokenHash)) return { ok: false, reason: "invalid" };
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string") return unavailable;
  let db: DatabaseSync | null = null;
  let snapshot = false;
  try {
    const directory = verifyExistingTargetStagingPath(store.stagingDirectory);
    const databasePath = path.join(directory, TARGET_STORE_FILENAME);
    // Never follow a database-file symlink; reject sidecars exactly like preflight.
    const info = statSync(databasePath);
    if (lstatSync(databasePath).isSymbolicLink() || !info.isFile() || info.nlink !== 1 ||
        !noTargetStagingSidecars(databasePath)) return unavailable;
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${LIVE_READ_BUSY_MS}`);
    db.exec("BEGIN");
    snapshot = true;
    // Metadata, identity and session rows come from one SQLite snapshot.
    const metadata = db.prepare(
      "SELECT key, value FROM metadata WHERE key IN ('schema_version','activated','restore_generation')",
    ).all() as { key: string; value: string }[];
    const values = new Map(metadata.map(row => [row.key, row.value]));
    if (metadata.length !== 3 || values.size !== 3 ||
        values.get("schema_version") !== String(TARGET_STORE_SCHEMA_VERSION) ||
        values.get("activated") !== "false" ||
        values.get("restore_generation") !== store.expectedRestoreGeneration) return unavailable;
    const live = lookupLiveTargetStagingSession(db, tokenHash, nowMs);
    db.exec("ROLLBACK");
    snapshot = false;
    return live ? { ok: true, sessionId: live.sessionId, userId: live.userId }
      : { ok: false, reason: "invalid" };
  } catch {
    return unavailable;
  } finally {
    if (db) {
      if (snapshot) {
        try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
      }
      try { db.close(); } catch { /* fail closed */ }
    }
  }
}
