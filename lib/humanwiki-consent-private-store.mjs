/**
 * H1-real.4a: dedicated private file-backed SQLite for non-authorizing
 * consent intents. Caller must prove a live owner-private Area before opening.
 * This is NOT a witness, import capability, or atomic Area+intent transaction.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertHumanWikiConsentIntentSchema, createHumanWikiConsentIntentSchema,
} from "./humanwiki-consent-intents.mjs";

const FILENAME = "humanwiki-consent-intents.sqlite";
const ownUid = () => typeof process.getuid === "function" ? process.getuid() : null;

const safeDirectory = directory => {
  if (typeof directory !== "string" || !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory || ownUid() === null) return false;
  const st = lstatSync(directory);
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === ownUid() &&
    (st.mode & 0o077) === 0 && realpathSync(directory) === directory;
};
const fileIdentity = file => {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      st.uid !== ownUid() || (st.mode & 0o177) !== 0 ||
      realpathSync(file) !== file) throw Error("unavailable");
  return { dev: st.dev, ino: st.ino };
};
// A new SQLite file's directory entry is not guaranteed crash-durable until
// the containing directory is fsynced, regardless of synchronous=FULL.
const syncPrivateDirectory = directory => {
  const fd = openSync(directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const noSidecars = file => {
  for (const suffix of ["-wal", "-shm"]) {
    try { lstatSync(file + suffix); return false; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return true;
};

/** Distinct from the session signing key and any Ed25519 witness secret. */
export function humanWikiConsentLedgerKey(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
    return null;
  const key = Buffer.from(encoded, "base64url");
  return key.length === 32 && key.toString("base64url") === encoded ? key : null;
}

/**
 * Explicit operator-only, one-time registry creation; never called from HTTP.
 * This refuses existing files (including a partial/crashed bootstrap) and
 * never overwrites them. A lost database requires operator recovery and an
 * independent external witness before any effective revocation can be trusted.
 *
 * A failure after O_EXCL creation may leave a partial *file* behind, but schema
 * creation is transactional and every HTTP open verifies its exact contents.
 * The operator must investigate/recover instead of retrying over that file.
 */
export function bootstrapHumanWikiConsentPrivateLedger(directory) {
  if (!safeDirectory(directory)) throw Error("unavailable");
  const file = path.join(directory, FILENAME);
  if (!noSidecars(file)) throw Error("unavailable");
  // Even on an empty path, never bootstrap when SQLite sidecars are present.
  const fd = openSync(file,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  closeSync(fd);
  let db;
  try {
    const original = fileIdentity(file);
    db = new DatabaseSync(file);
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000");
    const journal = db.prepare("PRAGMA journal_mode").get();
    if (journal?.journal_mode !== "delete") throw Error("unavailable");
    createHumanWikiConsentIntentSchema(db);
    assertHumanWikiConsentIntentSchema(db);
    db.close();
    db = null;
    // Persist the new directory entry only after the complete SQLite schema
    // was committed. An interrupted bootstrap is never retried by HTTP.
    syncPrivateDirectory(directory);
    const after = fileIdentity(file);
    if (original.dev !== after.dev || original.ino !== after.ino ||
        !noSidecars(file) || !safeDirectory(directory)) throw Error("unavailable");
    return { ok: true, importAuthorized: false, withdrawalComplete: false };
  } finally {
    if (db) db.close();
  }
}

/**
 * HTTP reader/writer for an already bootstrapped private registry. BOTH modes
 * require an existing file with the exact verified append-only schema.
 * Missing or partially initialized databases always fail closed; there is
 * NO auto-bootstrap or silent replacement of a lost intent history.
 *
 * Directory trust is operator-configured; same-UID changes to a file between
 * path checks still require future descriptor pinning + independent witness.
 */
export function withHumanWikiConsentPrivateLedger(directory, mode, fn) {
  if (!["read", "write"].includes(mode) || typeof fn !== "function" ||
      !safeDirectory(directory)) throw Error("unavailable");
  const file = path.join(directory, FILENAME);
  if (!noSidecars(file)) throw Error("unavailable");
  // A missing file is a fatal ledger state, not an initialization request.
  const original = fileIdentity(file);
  const db = new DatabaseSync(file, { readOnly: mode === "read" });
  try {
    const journal = db.prepare("PRAGMA journal_mode").get();
    if (journal?.journal_mode !== "delete") throw Error("unavailable");
    if (mode === "write") db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000");
    assertHumanWikiConsentIntentSchema(db);
    const result = fn(db);
    const after = fileIdentity(file);
    if (original.dev !== after.dev || original.ino !== after.ino ||
        !noSidecars(file) || !safeDirectory(directory)) throw Error("unavailable");
    return result;
  } finally {
    db.close();
  }
}

/**
 * H1-real.4b: keep the validated private ledger open across bounded remote
 * witness I/O, so both before/after HMAC history reads use a live database.
 * Read-only mode forbids this transport from creating or changing consent.
 * The callback is constrained to use the 2s AbortSignal verifier deadline.
 */
export async function withHumanWikiConsentPrivateLedgerAsync(directory, fn) {
  if (typeof fn !== "function" || !safeDirectory(directory))
    throw Error("unavailable");
  const file = path.join(directory, FILENAME);
  if (!noSidecars(file)) throw Error("unavailable");
  const original = fileIdentity(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const journal = db.prepare("PRAGMA journal_mode").get();
    if (journal?.journal_mode !== "delete") throw Error("unavailable");
    assertHumanWikiConsentIntentSchema(db);
    const result = await fn(db);
    const after = fileIdentity(file);
    if (original.dev !== after.dev || original.ino !== after.ino ||
        !noSidecars(file) || !safeDirectory(directory)) throw Error("unavailable");
    return result;
  } finally {
    db.close();
  }
}
