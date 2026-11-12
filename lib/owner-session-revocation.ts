/**
 * Global owner-cookie cutoff (not the separate target durable sessions).
 *
 * One persistent revocation value in a dedicated SQLite database in
 * AI_EXECUTIVE_DATA_DIR. Readers NEVER initialize/repair it. Initialization
 * is an explicit one-off operator action before the first deployment.
 *
 * BEGIN IMMEDIATE serializes issuers/logout across processes. SQLite's
 * rollback journal releases locks automatically after crashes and commits
 * monotonically; unlike a mkdir lock, no orphan lock needs manual removal.
 */
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "./data-dir";

const FILE = "owner-session-valid-from.sqlite";
const MAX_ISSUANCE_WAIT_MS = 500;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export class OwnerSessionStateUnavailable extends Error {
  constructor() {
    super("Owner session revocation state unavailable");
    this.name = "OwnerSessionStateUnavailable";
  }
}

function statePath() {
  // Do not normalize a configured directory containing a symlink before "..".
  const dir = resolveDataDirectory();
  return dir.endsWith(path.sep) ? dir + FILE : dir + path.sep + FILE;
}

function fileIdentity(file: string) {
  const stat = lstatSync(file); // no implicit creation and no symlink following
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new OwnerSessionStateUnavailable();
  }
  return { dev: stat.dev, ino: stat.ino };
}

function openExisting(readOnly: boolean): DatabaseSync {
  const file = statePath();
  try {
    const before = fileIdentity(file);
    const db = new DatabaseSync(file, { readOnly });
    try {
      const after = fileIdentity(file);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new OwnerSessionStateUnavailable();
      }
      db.exec("PRAGMA busy_timeout = " + SQLITE_BUSY_TIMEOUT_MS);
      if (!readOnly) db.exec("PRAGMA synchronous = FULL");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch {
    throw new OwnerSessionStateUnavailable();
  }
}

function cutoff(db: DatabaseSync): number {
  const value = db.prepare(
    "SELECT version, valid_from_ms FROM owner_session_cutoff WHERE id = 1",
  ).get() as { version: number; valid_from_ms: number } | undefined;
  if (!value || value.version !== 1 ||
      !Number.isSafeInteger(value.valid_from_ms) || value.valid_from_ms <= 0) {
    throw new OwnerSessionStateUnavailable();
  }
  return value.valid_from_ms;
}

function inTransaction<T>(readOnly: boolean, body: (db: DatabaseSync) => T): T {
  const db = openExisting(readOnly);
  let active = false;
  try {
    const expectedIdentity = fileIdentity(statePath());
    db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    active = true;
    const result = body(db);
    // A file swap during the transaction never authenticates an old handle.
    const check = fileIdentity(statePath());
    if (check.dev !== expectedIdentity.dev || check.ino !== expectedIdentity.ino) {
      throw new OwnerSessionStateUnavailable();
    }
    db.exec("COMMIT");
    active = false;
    return result;
  } catch {
    if (active) { try { db.exec("ROLLBACK"); } catch { /* fail closed */ } }
    throw new OwnerSessionStateUnavailable();
  } finally {
    db.close();
  }
}

/**
 * Explicit and irreversible provisioning command: creates the one state file.
 * Refuses to overwrite an existing (including corrupt/symlink) path. If lost
 * after a real deployment, rotate SESSION_SECRET before reprovisioning:
 * a copied cookie must never be revalidated after restoring from backup.
 */
export function initializeOwnerSessionRevocationState(): void {
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = statePath();
  let fd: number;
  try {
    fd = openSync(file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch {
    throw new OwnerSessionStateUnavailable();
  }
  // Deliberately leave any partially initialized file in place. A crash while
  // provisioning must require manual inspection, never silently retry/reset.
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "CREATE TABLE owner_session_cutoff (" +
      "id INTEGER PRIMARY KEY CHECK (id = 1), " +
      "version INTEGER NOT NULL CHECK (version = 1), " +
      "valid_from_ms INTEGER NOT NULL CHECK (valid_from_ms > 0))",
    );
    db.prepare("INSERT INTO owner_session_cutoff(id, version, valid_from_ms) VALUES (1, 1, ?)")
      .run(Date.now());
    db.exec("COMMIT");
    fileIdentity(file);
  } catch {
    try { db?.exec("ROLLBACK"); } catch { /* incomplete file fails closed */ }
    throw new OwnerSessionStateUnavailable();
  } finally {
    db?.close();
  }
}

export function ownerSessionIssuedAtIsValid(issuedAtMs: unknown, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(issuedAtMs) || (issuedAtMs as number) <= 0 ||
      (issuedAtMs as number) > nowMs) return false;
  try {
    return inTransaction(true, db => (issuedAtMs as number) > cutoff(db));
  } catch {
    return false;
  }
}

/** Call only after a password or WebAuthn assertion has been verified. */
export function issueOwnerSessionIssuedAt(): number {
  return inTransaction(false, db => {
    const validFrom = cutoff(db);
    const start = Date.now();
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() <= validFrom) {
      if (Date.now() - start > MAX_ISSUANCE_WAIT_MS) {
        throw new OwnerSessionStateUnavailable();
      }
      Atomics.wait(pause, 0, 0, 1);
    }
    return Date.now();
  });
}

/** A committed logout invalidates every earlier owner-cookie on all workers. */
export function revokeAllOwnerSessions(): void {
  inTransaction(false, db => {
    const previous = cutoff(db);
    const next = Math.max(Date.now(), previous + 1);
    if (!Number.isSafeInteger(next)) throw new OwnerSessionStateUnavailable();
    const updated = db.prepare(
      "UPDATE owner_session_cutoff SET valid_from_ms = ? WHERE id = 1 AND valid_from_ms = ?",
    ).run(next, previous);
    if (updated.changes !== 1) throw new OwnerSessionStateUnavailable();
  });
}

/** Check one existing, safe and fully initialized cutoff without changing it. */
export function verifyOwnerSessionRevocationState(): void {
  inTransaction(true, db => { cutoff(db); });
}
