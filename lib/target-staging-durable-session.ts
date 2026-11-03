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
import { DatabaseSync } from "node:sqlite";
import {
  TARGET_STAGING_SESSION_MAX_LIFETIME_MS, TARGET_STAGING_SESSION_MAX_ROWS,
  TARGET_STORE_SCHEMA_VERSION,
} from "./target-store-bootstrap";
import {
  noTargetStagingSidecars, pinTargetStagingFiles, withPinnedTargetStagingWrite,
} from "./target-staging-pinned-write";
import { checkPinnedTargetStagingAnchor } from "./target-staging-pinned-write";
import type { PinnedTargetStagingFiles } from "./target-staging-pinned-write";
import { warmTargetStagingJournal } from "./target-staging-anchor-journal";
import type { TargetStagingAnchorVerdict } from "./target-staging-anchor-journal";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { evaluateTargetAreaPolicy } from "./target-area-policy";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import { logStagingFailure } from "./target-staging-failure-log";
import type { TargetReadLinearization } from "./target-task-read-model";
import type { TargetTaskBacklinkLiveGuard } from "./target-parent-backlinks";
import type { TargetTemporalTaskLiveGuard } from "./target-task-temporal-read-model";
import { eligibleMyPlanSummaryAreas, type HomeSummaryAreaEpoch } from "./target-my-plan-home-summary";
import { eligibleScopedHomeSummaryAreas, type TargetHomeScope } from "./target-scoped-home-summary";

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
  | { ok: false; reason: "invalid_request" | "unknown_user" | "unavailable" | "write_failed" | "capacity" };
export type TargetStagingDurableSessionRevoke =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "invalid_request" | "not_found" | "unavailable" | "write_failed" };
export type TargetStagingDurableUserRevoke =
  | { ok: true; revocationEpoch: number; revokedSessions: number }
  | { ok: false; reason: "invalid_request" | "not_found" | "unavailable" | "write_failed" };
export type TargetStagingLiveSession =
  | { ok: true; sessionId: string; userId: string }
  | { ok: false; reason: "invalid" | "unavailable" };
/**
 * R2c.2b distinct 401 reasons, derived ONLY from the presented token (its holder
 * alone learns them). Revocation takes precedence over expiry. R2c.4b adds
 * `session_restored`: the token was live under the irreversible source when an operator restore
 * replaced the store (only such tokens are listed by the restore, see classify below).
 */
export type TargetStagingSessionDenial = "session_expired" | "session_revoked" | "session_restored";
export type TargetStagingCodedLiveSession =
  | { ok: true; sessionId: string; userId: string }
  | { ok: false; reason: "invalid"; code: TargetStagingSessionDenial }
  | { ok: false; reason: "unavailable" };

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
 * R2c.2b pure classification of a session which is NOT live (call it on the same
 * snapshot/transaction after lookupLiveTargetStagingSession returned null).
 * `session_expired`: the row exists, is not revoked, carries the identity's current
 * epoch and is merely past its expiry. Everything else is `session_revoked`: a
 * revoked row, a stale epoch (sign-out everywhere), an unknown token (including a
 * row deleted after the retention window) or a token whose identity is gone.
 */
export function classifyTargetStagingSessionDenial(
  db: DatabaseSync, tokenHash: string, nowMs: number,
): TargetStagingSessionDenial {
  if (!TOKEN_HASH.test(tokenHash) || !Number.isSafeInteger(nowMs) || nowMs <= 0) return "session_revoked";
  if (db.prepare("SELECT 1 AS ok FROM restore_superseded_sessions WHERE token_hash = ?").get(tokenHash)) {
    return "session_restored";
  }
  const row = db.prepare(`
    SELECT s.revoked_at_ms AS revoked, s.expires_at_ms AS expires,
           s.revocation_epoch AS epoch, i.revocation_epoch AS current
      FROM staging_sessions s LEFT JOIN identities i ON i.id = s.user_id
     WHERE s.token_hash = ?
  `).get(tokenHash) as
    { revoked: number | null; expires: number; epoch: number; current: number | null } | undefined;
  if (!row || row.revoked !== null || row.current === null || row.epoch !== row.current) {
    return "session_revoked";
  }
  return row.expires <= nowMs ? "session_expired" : "session_revoked";
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
    // An identity without its personal workspace and private Unassigned Area
    // would make the store fail preflight (personal_workspace_invalid) once a
    // session row exists; refuse before writing anything.
    const personal = db.prepare(`SELECT 1 AS ok FROM workspaces w WHERE w.kind='personal' AND w.owner_user_id=?
      AND EXISTS (SELECT 1 FROM areas a WHERE a.workspace_id=w.id AND a.owner_user_id=w.owner_user_id
        AND a.kind='private' AND a.system_key='unassigned')`).get(userId);
    if (!personal) return { ok: false, reason: "unknown_user" };
    // Before the first write: afterwards SQLite's own -journal legitimately exists.
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const createdAt = Date.now();
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return { ok: false, reason: "write_failed" };
    const expiresAt = createdAt + lifetimeSeconds * 1000;
    // The 4096-row cap trigger is a distinct, operator-visible outcome (the
    // staging remedy is a fresh bootstrap); the open transaction rolls back.
    const full = db.prepare("SELECT COUNT(*) AS n FROM staging_sessions").get() as { n: number };
    if (full.n >= TARGET_STAGING_SESSION_MAX_ROWS) return { ok: false, reason: "capacity" };
    const inserted = db.prepare(`
      INSERT INTO staging_sessions(
        id, user_id, token_hash, created_at_ms, expires_at_ms, revoked_at_ms, revocation_epoch
      ) VALUES (?,?,?,?,?,NULL,?)
    `).run(sessionId, userId, hashTargetStagingSessionToken(token), createdAt, expiresAt,
      identity.revocation_epoch);
    if (inserted.changes !== 1 || !context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit({ kind: "session_issue", payload: {
      userId, tokenHash: hashTargetStagingSessionToken(token), epoch: identity.revocation_epoch,
    } });
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
    const row = db.prepare(
      "SELECT revoked_at_ms, user_id, token_hash, revocation_epoch FROM staging_sessions WHERE id = ?",
    ).get(sessionId) as { revoked_at_ms: number | null; user_id: string; token_hash: string;
      revocation_epoch: number } | undefined;
    if (!row) return { ok: false, reason: "not_found" };
    if (row.revoked_at_ms !== null) return { ok: true, changed: false };
    if (!context.stillPinned() || !context.noSidecars()) return { ok: false, reason: "write_failed" };
    const revokedAt = Date.now();
    if (!Number.isSafeInteger(revokedAt) || revokedAt <= 0) return { ok: false, reason: "write_failed" };
    const updated = db.prepare(
      "UPDATE staging_sessions SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL",
    ).run(revokedAt, sessionId);
    if (updated.changes !== 1 || !context.stillPinned()) return { ok: false, reason: "write_failed" };
    context.commit({ kind: "session_revoke", payload: {
      userId: row.user_id, tokenHash: row.token_hash, epoch: row.revocation_epoch,
    } });
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
    context.commit({ kind: "session_revoke_all", payload: { userId, epochAfter: after.revocation_epoch } });
    return { ok: true, revocationEpoch: after.revocation_epoch, revokedSessions: Number(stamped.changes) };
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }),
  CONTROL_WRITE_BUSY_MS);
}

/**
 * Resolve a token hash against the LIVE store. This is the read-side linearization
 * primitive: HTTP routes call it before rate limiting and dispatching a child reader and again
 * immediately before releasing a response body, so a revocation committed by any
 * other process in between is observed. Every failure is fail-closed; "invalid"
 * (unknown, revoked, expired, stale epoch) is distinct from "unavailable"
 * (store/IO problem) only so that callers can choose 401 versus 503.
 */
export function verifyDurableTargetStagingSessionLive(
  store: TargetStagingReadStore, tokenHash: string, nowMs = Date.now(),
): TargetStagingLiveSession {
  const result = verifyDurableTargetStagingSessionLiveCoded(store, tokenHash, nowMs);
  return result.ok === false && result.reason === "invalid" ? { ok: false, reason: "invalid" } : result;
}

/** Same check, additionally classifying a dead session (R2c.2b 401 code) in the same snapshot. */
export function verifyDurableTargetStagingSessionLiveCoded(
  store: TargetStagingReadStore, tokenHash: string, nowMs = Date.now(),
): TargetStagingCodedLiveSession {
  const unavailable: TargetStagingCodedLiveSession = { ok: false, reason: "unavailable" };
  if (!isTargetStagingSessionTokenHash(tokenHash)) {
    return { ok: false, reason: "invalid", code: "session_revoked" };
  }
  return withLiveStagingReadTransaction<TargetStagingCodedLiveSession>(store, db => {
    const live = lookupLiveTargetStagingSession(db, tokenHash, nowMs);
    return live ? { ok: true, sessionId: live.sessionId, userId: live.userId }
      : { ok: false, reason: "invalid", code: classifyTargetStagingSessionDenial(db, tokenHash, nowMs) };
  }, unavailable);
}

/**
 * One short read transaction on the LIVE staging store, opened exclusively via
 * the pinned read-only helper (never by path): directory fd, uid/mode, fd-relative
 * open, dev/ino/nlink identity re-proven after the first statement and after the
 * read, metadata (schema, not activated, restore generation) from the same
 * snapshot. `body` runs inside that snapshot; any failure is `unavailable`.
 */
function withLiveStagingReadTransaction<T>(
  store: TargetStagingReadStore, body: (db: DatabaseSync) => T, unavailable: T,
  onAnchorFailure?: (verdict: Exclude<TargetStagingAnchorVerdict, "ok">) => T,
): T {
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string") return unavailable;
  let files: PinnedTargetStagingFiles | null = null;
  let db: DatabaseSync | null = null;
  let snapshot = false;
  try {
    // Same pinned access as the writers: directory fd, uid/mode, fd-relative
    // open, dev/ino/nlink identity. A rollback journal of a concurrent writer is
    // normal for a reader; WAL/shm sidecars are refused exactly like preflight.
    files = pinTargetStagingFiles(store.stagingDirectory);
    if (!files) {
      logStagingFailure("live_read", "pin_failed");
      return unavailable;
    }
    if (!noTargetStagingSidecars(files.databasePath, ["-wal", "-shm"])) {
      logStagingFailure("live_read", "sidecar_present");
      return unavailable;
    }
    warmTargetStagingJournal(files.directoryFdPath, store.expectedRestoreGeneration);
    const opened = files.openDatabase({ readOnly: true });
    db = opened.db;
    db.exec(`PRAGMA busy_timeout=${LIVE_READ_BUSY_MS}`);
    db.exec("BEGIN");
    snapshot = true;
    // SQLite opens the file lazily: after the first statement prove the handle
    // is the pinned inode, and prove it again after the read.
    db.prepare("SELECT 1 FROM metadata LIMIT 1").get();
    if (!opened.verifyOpened()) {
      logStagingFailure("live_read", "sqlite_inode_proof_failed");
      return unavailable;
    }
    // Metadata, identity and session rows come from one SQLite snapshot.
    const metadata = db.prepare(
      "SELECT key, value FROM metadata WHERE key IN ('schema_version','activated','restore_generation')",
    ).all() as { key: string; value: string }[];
    const values = new Map(metadata.map(row => [row.key, row.value]));
    if (metadata.length !== 3 || values.size !== 3 ||
        values.get("schema_version") !== String(TARGET_STORE_SCHEMA_VERSION) ||
        values.get("activated") !== "false" ||
        values.get("restore_generation") !== store.expectedRestoreGeneration) {
      logStagingFailure("live_read", "metadata_mismatch");
      return unavailable;
    }
    // R2c.4a: the SHARED lock taken above excludes any commit, so the anchor and the journal
    // read here are exact; a rolled-back or invalid store never serves a live check.
    const anchor = checkPinnedTargetStagingAnchor(files, db, store.expectedRestoreGeneration);
    if (anchor !== "ok") return onAnchorFailure ? onAnchorFailure(anchor) : unavailable;
    const result = body(db);
    db.exec("ROLLBACK");
    snapshot = false;
    if (!files.stillPinned() || !noTargetStagingSidecars(files.databasePath, ["-wal", "-shm"])) {
      logStagingFailure("live_read", "post_read_binding_changed");
      return unavailable;
    }
    return result;
  } catch (error) {
    logStagingFailure("live_read", "exception", error);
    return unavailable;
  } finally {
    if (db) {
      if (snapshot) {
        try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
      }
      try { db.close(); } catch { /* fail closed */ }
    }
    if (files) files.close();
  }
}

/**
 * R2c.4a gate run by every target-staging route BEFORE identity resolution (so no
 * session check runs against an untrusted store): the DB anchor against the irreversible
 * journal. "unavailable" means the store could not be checked at all (fail closed).
 */
export function checkTargetStagingAnchorLive(
  store: TargetStagingReadStore,
): "ok" | "restore_pending" | "journal_invalid" | "unavailable" {
  return withLiveStagingReadTransaction<"ok" | "restore_pending" | "journal_invalid" | "unavailable">(
    store, () => "ok", "unavailable", verdict => verdict);
}

export type TargetStagingReadLive =
  | { ok: true }
  /** Session not live (unknown, revoked, expired, stale epoch): HTTP 401 with its R2c.2b code. */
  | { ok: false; reason: "invalid"; code: TargetStagingSessionDenial }
  /** Membership / role / private ownership / policy_revision moved since the snapshot. */
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "unavailable" };

/**
 * R2-ID.2b read linearization point. Immediately before a body is released, in
 * ONE short read transaction on the LIVE store: (1) the durable session is live
 * (skipped for the owner-cookie subject), then (2) for every Area which
 * contributed to the snapshot read, the actor's CURRENT membership/role (or
 * private ownership) still grants read, equals the role observed in the snapshot
 * and the Area's policy_revision equals the snapshot's. Order matters: a dead
 * session is "invalid" (401) even if memberships also changed. Everything else
 * which fails is "stale" (the caller reloads) or "unavailable" (fail closed).
 *
 * Task reassignment does NOT bump policy_revision, so a my-plan response may
 * lag one request behind a reassignment away from the actor; that is accepted.
 */
/** Optional R2d.1a project/child row guard checked INSIDE the Area ACL transaction. */
export type TargetProjectReadLiveGuard = {
  projectId: string;
  areaId: string;
  taskIds: string[];
};
/** Project list guard also covers the lookahead row (which influences hasMore). */
export type TargetProjectIndexLiveGuard = {
  projects: Array<{ id: string; areaId: string }>;
  /** My-plan only: all contributing Area monotonic epochs, not a client selector. */
  myPlan?: {
    areas: Array<{ areaId: string; projectContentRevision: number; contentRevision: number }>;
  };
};

/**
 * R2d.2c.2b: Exact note snapshot guard, never a client DTO.
 * Check note identity, one canonical parent, effective Area and BOTH revisions
 * in the SAME live transaction as actor/session and Area permission.
 */
export type TargetNoteReadLiveGuard = {
  noteId: string;
  projectId: string | null;
  areaId: string;
  noteRevision: number;
  parentRevision: number | null;
};
export type TargetNoteSyncLiveGuard = {
  areaId: string; epoch: number; contentRevision: number; head: number;
};
const validNoteGuardId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && Buffer.byteLength(value, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export function verifyTargetStagingReadLive(
  store: TargetStagingReadStore,
  subject: { readonly tokenHash: string } | { readonly ownerUserId: string },
  observed: TargetReadLinearization,
  nowMs = Date.now(),
  projectGuard?: TargetProjectReadLiveGuard,
  projectIndexGuard?: TargetProjectIndexLiveGuard,
  noteGuard?: TargetNoteReadLiveGuard,
  noteSyncGuard?: TargetNoteSyncLiveGuard,
  taskBacklinkGuard?: TargetTaskBacklinkLiveGuard,
  homeSummaryGuard?: { areas: HomeSummaryAreaEpoch[]; scope?: TargetHomeScope },
  temporalTaskGuard?: TargetTemporalTaskLiveGuard,
): TargetStagingReadLive {
  const unavailable: TargetStagingReadLive = { ok: false, reason: "unavailable" };
  if (!observed || typeof observed.actorUserId !== "string" || !USER_ID.test(observed.actorUserId) ||
      !Array.isArray(observed.areas) || observed.areas.length > MAX_SCOPED_READ_AREAS) return unavailable;
  if (projectGuard && (typeof projectGuard.projectId !== "string" || !projectGuard.projectId ||
      typeof projectGuard.areaId !== "string" || !projectGuard.areaId ||
      !Array.isArray(projectGuard.taskIds) || projectGuard.taskIds.length > 100 ||
      projectGuard.taskIds.some(id => typeof id !== "string" || !id) ||
      new Set(projectGuard.taskIds).size !== projectGuard.taskIds.length)) return unavailable;
  if (projectIndexGuard && (
      !Array.isArray(projectIndexGuard.projects) ||
      projectIndexGuard.projects.length > 101 ||
      projectIndexGuard.projects.some(project =>
        !project || typeof project.id !== "string" || !project.id ||
        typeof project.areaId !== "string" || !project.areaId ||
        !observed.areas.some(area => area.areaId === project.areaId)) ||
      new Set(projectIndexGuard.projects.map(project => project.id)).size !==
        projectIndexGuard.projects.length ||
      (projectIndexGuard.myPlan !== undefined && (
        !projectIndexGuard.myPlan ||
        !Array.isArray(projectIndexGuard.myPlan.areas) ||
        projectIndexGuard.myPlan.areas.length !== observed.areas.length ||
        projectIndexGuard.myPlan.areas.some((row, i) =>
          !row || row.areaId !== observed.areas[i]?.areaId ||
          !Number.isSafeInteger(row.projectContentRevision) ||
          row.projectContentRevision < 0 ||
          !Number.isSafeInteger(row.contentRevision) ||
          row.contentRevision < 0) ||
        observed.areas.some(area => area.areaKind === "shared" &&
          area.access !== "editor" && area.access !== "admin")
      )))) return unavailable;
  if (homeSummaryGuard && (
      (homeSummaryGuard.scope !== undefined &&
        homeSummaryGuard.scope !== "personal" &&
        homeSummaryGuard.scope !== "shared" &&
        homeSummaryGuard.scope !== "my-plan") ||
      !Array.isArray(homeSummaryGuard.areas) ||
      homeSummaryGuard.areas.length > MAX_SCOPED_READ_AREAS ||
      homeSummaryGuard.areas.length !== observed.areas.length ||
      homeSummaryGuard.areas.some((row, i) =>
        !row || !validNoteGuardId(row.areaId) ||
        row.areaId !== observed.areas[i]?.areaId ||
        row.areaKind !== observed.areas[i]?.areaKind ||
        row.access !== observed.areas[i]?.access ||
        row.policyRevision !== observed.areas[i]?.policyRevision ||
        !Number.isSafeInteger(row.contentRevision) || row.contentRevision < 0 ||
        !Number.isSafeInteger(row.projectContentRevision) ||
          row.projectContentRevision < 0) ||
      new Set(homeSummaryGuard.areas.map(a => a.areaId)).size !==
        homeSummaryGuard.areas.length
    )) return unavailable;
  if (noteGuard && (
      !validNoteGuardId(noteGuard.noteId) || !validNoteGuardId(noteGuard.areaId) ||
      (noteGuard.projectId !== null && !validNoteGuardId(noteGuard.projectId)) ||
      !Number.isSafeInteger(noteGuard.noteRevision) || noteGuard.noteRevision < 0 ||
      (noteGuard.projectId === null ? noteGuard.parentRevision !== null :
        !Number.isSafeInteger(noteGuard.parentRevision) || (noteGuard.parentRevision as number) < 0) ||
      observed.areas.length !== 1 || observed.areas[0]?.areaId !== noteGuard.areaId)) {
    return unavailable;
  }
  // A task-backlink's existence and exact parent are authorization-sensitive.
  // Validate the server-snapshot witness before opening the live read.
  if (taskBacklinkGuard && (
      !validNoteGuardId(taskBacklinkGuard.taskId) ||
      !validNoteGuardId(taskBacklinkGuard.areaId) ||
      (taskBacklinkGuard.projectId !== null &&
        !validNoteGuardId(taskBacklinkGuard.projectId)) ||
      !Number.isSafeInteger(taskBacklinkGuard.taskRevision) ||
      taskBacklinkGuard.taskRevision < 0 ||
      (taskBacklinkGuard.projectId === null
        ? taskBacklinkGuard.parentRevision !== null
        : !Number.isSafeInteger(taskBacklinkGuard.parentRevision) ||
          (taskBacklinkGuard.parentRevision as number) < 0) ||
      observed.areas.length !== 1 ||
      observed.areas[0]?.areaId !== taskBacklinkGuard.areaId)) return unavailable;
  // R2d.3g: raw SQLite TEXT task IDs are legal, including "" and Unicode.
  // The server-generated guard binds the exact task and inherited Area,
  // task revision (status/date/assignee/title ABA) and parent revision.
  if (temporalTaskGuard && (
      typeof temporalTaskGuard.taskId !== "string" ||
      Buffer.byteLength(temporalTaskGuard.taskId,"utf8") > 4096 ||
      temporalTaskGuard.taskId.includes("\0") ||
      typeof temporalTaskGuard.areaId !== "string" || !temporalTaskGuard.areaId ||
      (temporalTaskGuard.projectId !== null &&
        typeof temporalTaskGuard.projectId !== "string") ||
      !Number.isSafeInteger(temporalTaskGuard.taskRevision) ||
      temporalTaskGuard.taskRevision < 0 ||
      (temporalTaskGuard.projectId === null
        ? temporalTaskGuard.parentRevision !== null
        : !Number.isSafeInteger(temporalTaskGuard.parentRevision) ||
          (temporalTaskGuard.parentRevision as number) < 0) ||
      observed.areas.length !== 1 ||
      observed.areas[0]?.areaId !== temporalTaskGuard.areaId)) return unavailable;
  if (noteSyncGuard && (observed.areas.length !== 1 ||
      observed.areas[0]?.areaId !== noteSyncGuard.areaId ||
      !validNoteGuardId(noteSyncGuard.areaId) ||
      !Number.isSafeInteger(noteSyncGuard.epoch) || noteSyncGuard.epoch < 0 ||
      !Number.isSafeInteger(noteSyncGuard.contentRevision) || noteSyncGuard.contentRevision < 0 ||
      !Number.isSafeInteger(noteSyncGuard.head) || noteSyncGuard.head < 0 ||
      noteSyncGuard.head > noteSyncGuard.contentRevision)) return unavailable;
  if ("tokenHash" in subject && !isTargetStagingSessionTokenHash(subject.tokenHash)) {
    return { ok: false, reason: "invalid", code: "session_revoked" };
  }
  return withLiveStagingReadTransaction<TargetStagingReadLive>(store, db => {
    let actorUserId: string;
    if ("tokenHash" in subject) {
      const live = lookupLiveTargetStagingSession(db, subject.tokenHash, nowMs);
      if (!live) {
        return { ok: false, reason: "invalid", code: classifyTargetStagingSessionDenial(db, subject.tokenHash, nowMs) };
      }
      actorUserId = live.userId;
    } else {
      if (typeof subject.ownerUserId !== "string" || !USER_ID.test(subject.ownerUserId)) return unavailable;
      actorUserId = subject.ownerUserId;
    }
    // The snapshot must have been read for this very actor.
    if (actorUserId !== observed.actorUserId) return unavailable;
    if (noteSyncGuard) {
      const row = db.prepare(`SELECT i.revocation_epoch AS epoch,
        a.note_sync_revision AS contentRevision,
        COALESCE((SELECT MAX(j.seq) FROM note_change_journal j WHERE j.area_id=a.id),0) AS head
        FROM identities i JOIN areas a ON a.id=? WHERE i.id=?`)
        .get(noteSyncGuard.areaId, actorUserId) as
        { epoch: number; contentRevision: number; head: number } | undefined;
      if (!row || row.epoch !== noteSyncGuard.epoch ||
          row.contentRevision !== noteSyncGuard.contentRevision || row.head !== noteSyncGuard.head)
        return { ok: false, reason: "stale" };
    }
    for (const area of observed.areas) {
      if (!area || typeof area.areaId !== "string" || !Number.isSafeInteger(area.policyRevision)) {
        return unavailable;
      }
      const decision = evaluateTargetAreaPolicy(db, { actorUserId, areaId: area.areaId, permission: "read" });
      if (!decision.allowed) {
        return decision.reason === "query_failed" ? unavailable : { ok: false, reason: "stale" };
      }
      const current = db.prepare(`SELECT a.kind AS kind, a.policy_revision AS policy_revision, m.role AS role
        FROM areas a LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = ?
        WHERE a.id = ?`).get(actorUserId, area.areaId) as
        { kind: string; policy_revision: number; role: string | null } | undefined;
      if (!current) return { ok: false, reason: "stale" };
      const access = current.kind === "private" ? "private-owner" : current.role;
      if (access !== area.access || current.policy_revision !== area.policyRevision) {
        return { ok: false, reason: "stale" };
      }
    }
    if (homeSummaryGuard) {
      // Re-evaluate the FULL currently eligible Area set, not only Areas
      // contributing nonempty rows. This catches newly granted shared Areas
      // and first assignments between the snapshot and the HTTP release.
      const current = homeSummaryGuard.scope
        ? eligibleScopedHomeSummaryAreas(db, actorUserId, homeSummaryGuard.scope)
        : eligibleMyPlanSummaryAreas(db, actorUserId);
      if (!current || current.length !== homeSummaryGuard.areas.length)
        return { ok: false, reason: "stale" };
      for (let i = 0; i < current.length; i++) {
        const before = homeSummaryGuard.areas[i];
        const after = current[i];
        if (!before || !after || before.areaId !== after.areaId ||
            before.areaKind !== after.areaKind || before.access !== after.access ||
            before.policyRevision !== after.policyRevision ||
            before.contentRevision !== after.contentRevision ||
            before.projectContentRevision !== after.projectContentRevision)
          return { ok: false, reason: "stale" };
      }
    }
    if (projectGuard) {
      // Membership-only checks are insufficient when task or project rows
      // leave the old Area after the snapshot. Verify all returned child IDs
      // inside the SAME live transaction that checked actor and Area policy.
      const project = db.prepare("SELECT area_id AS areaId FROM projects WHERE id = ?")
        .get(projectGuard.projectId) as { areaId: string } | undefined;
      if (!project || project.areaId !== projectGuard.areaId) {
        return { ok: false, reason: "stale" };
      }
      const child = db.prepare(`SELECT id FROM tasks
        WHERE id = ? AND project_id = ? AND area_id IS NULL`);
      for (const id of projectGuard.taskIds) {
        if (!child.get(id, projectGuard.projectId)) return { ok: false, reason: "stale" };
      }
    }
    if (projectIndexGuard?.myPlan) {
      // A newly assigned project or a withdrawn assignment can change the
      // membership and order of this view without moving any project.
      // Area content/project epochs are monotonic in the canonical staging
      // schema, and checked with current session/ACL in ONE live transaction.
      // Private project visibility does not depend on tasks: do not make a
      // private task-only edit spuriously invalidate an unchanged project list.
      const epochs = db.prepare(`SELECT project_content_revision AS projectContentRevision,
        content_revision AS contentRevision FROM areas WHERE id=?`);
      for (const area of projectIndexGuard.myPlan.areas) {
        const live = epochs.get(area.areaId) as {
          projectContentRevision: number; contentRevision: number;
        } | undefined;
        const scoped = observed.areas.find(a => a.areaId === area.areaId);
        if (!live || !scoped ||
            live.projectContentRevision !== area.projectContentRevision ||
            (scoped.areaKind === "shared" &&
              live.contentRevision !== area.contentRevision))
          return { ok: false, reason: "stale" };
      }
      const ownsTask = db.prepare(`SELECT 1 FROM tasks
        WHERE project_id=? AND area_id IS NULL AND assignee_user_id=? LIMIT 1`);
      for (const row of projectIndexGuard.projects) {
        const area = observed.areas.find(a => a.areaId === row.areaId);
        if (!area || (area.areaKind === "shared" &&
            !ownsTask.get(row.id, actorUserId)))
          return { ok: false, reason: "stale" };
      }
    }
    if (projectIndexGuard) {
      // Membership/role are checked above; also rebind every released project
      // and the lookahead row to the same accessible Area in this LIVE txn.
      const lookup = db.prepare("SELECT area_id AS areaId FROM projects WHERE id = ?");
      for (const row of projectIndexGuard.projects) {
        const current = lookup.get(row.id) as { areaId: string } | undefined;
        if (!current || current.areaId !== row.areaId)
          return { ok: false, reason: "stale" };
      }
    }
    if (noteGuard) {
      // A policy-only check is NOT enough: content ABA, reparenting, an Area
      // move of its parent project and parent-title ABA must all invalidate.
      const row = db.prepare(`SELECT n.id AS noteId, n.project_id AS projectId,
        n.area_id AS directAreaId, n.revision AS noteRevision,
        p.area_id AS parentAreaId, p.revision AS parentRevision
        FROM notes n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.id = ? LIMIT 1`).get(noteGuard.noteId) as {
          noteId: string; projectId: string | null; directAreaId: string | null;
          noteRevision: number; parentAreaId: string | null; parentRevision: number | null;
        } | undefined;
      if (!row || row.noteId !== noteGuard.noteId ||
          row.projectId !== noteGuard.projectId ||
          row.noteRevision !== noteGuard.noteRevision ||
          (noteGuard.projectId === null
            ? row.directAreaId !== noteGuard.areaId || row.parentAreaId !== null ||
              row.parentRevision !== null
            : row.directAreaId !== null || row.parentAreaId !== noteGuard.areaId ||
              row.parentRevision !== noteGuard.parentRevision)) {
        return { ok: false, reason: "stale" };
      }
    }
    if (temporalTaskGuard) {
      const current = db.prepare(`SELECT t.project_id AS projectId,
        t.area_id AS directAreaId, t.revision AS taskRevision,
        p.area_id AS parentAreaId, p.revision AS parentRevision
        FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
        WHERE t.id=? LIMIT 1`).get(temporalTaskGuard.taskId) as {
          projectId: string | null; directAreaId: string | null;
          taskRevision: number; parentAreaId: string | null;
          parentRevision: number | null;
        } | undefined;
      if (!current || current.projectId !== temporalTaskGuard.projectId ||
          current.taskRevision !== temporalTaskGuard.taskRevision ||
          (temporalTaskGuard.projectId === null
            ? current.directAreaId !== temporalTaskGuard.areaId ||
              current.parentAreaId !== null || current.parentRevision !== null
            : current.directAreaId !== null ||
              current.parentAreaId !== temporalTaskGuard.areaId ||
              current.parentRevision !== temporalTaskGuard.parentRevision))
        return { ok: false, reason: "stale" };
    }
    if (taskBacklinkGuard) {
      // Same LIVE transaction as session/Area ACL: a moved task or parent,
      // or any revision change, makes the observed relation stale even
      // when the final public response contains zero relations.
      const row = db.prepare(`SELECT t.project_id AS projectId,
        t.area_id AS directAreaId, t.revision AS taskRevision,
        p.area_id AS parentAreaId, p.revision AS parentRevision
        FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
        WHERE t.id=? LIMIT 1`).get(taskBacklinkGuard.taskId) as {
          projectId: string | null; directAreaId: string | null;
          taskRevision: number; parentAreaId: string | null;
          parentRevision: number | null;
        } | undefined;
      if (!row || row.projectId !== taskBacklinkGuard.projectId ||
          row.taskRevision !== taskBacklinkGuard.taskRevision ||
          (taskBacklinkGuard.projectId === null
            ? row.directAreaId !== taskBacklinkGuard.areaId ||
              row.parentAreaId !== null || row.parentRevision !== null
            : row.directAreaId !== null ||
              row.parentAreaId !== taskBacklinkGuard.areaId ||
              row.parentRevision !== taskBacklinkGuard.parentRevision))
        return { ok: false, reason: "stale" };
    }
    return { ok: true };
  }, unavailable);
}
