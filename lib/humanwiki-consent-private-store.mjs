/**
 * H1-real.4a: dedicated private file-backed SQLite for non-authorizing
 * consent intents. Caller must prove a live owner-private Area before opening.
 * This is NOT a witness, import capability, or atomic Area+intent transaction.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHumanWikiConsentIntentSchema } from "./humanwiki-consent-intents.mjs";

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
 * Read mode never creates or migrates a database. Write mode creates a new
 * content-free registry only inside an operator-provisioned 0700 directory,
 * using O_EXCL|O_NOFOLLOW and restrictive 0600 permissions. File/inode and
 * journal checks are repeated before reporting success.
 *
 * Directory trust is operator-configured; a process with permission to modify
 * this directory can replace files between checks. Production authorization
 * requires a separately pinned file handle and independent witness; this code
 * records only non-authorizing intents and cannot grant import permission.
 */
export function withHumanWikiConsentPrivateLedger(directory, mode, fn) {
  if (!["read", "write"].includes(mode) || typeof fn !== "function" ||
      !safeDirectory(directory)) throw Error("unavailable");
  const file = path.join(directory, FILENAME);
  if (!noSidecars(file)) throw Error("unavailable");
  let created = false;
  try { fileIdentity(file); }
  catch (error) {
    if (error?.code !== "ENOENT" || mode !== "write") throw Error("unavailable");
    const fd = openSync(file,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
    closeSync(fd);
    created = true;
  }
  const original = fileIdentity(file);
  const db = new DatabaseSync(file, { readOnly: mode === "read" });
  try {
    const journal = db.prepare("PRAGMA journal_mode").get();
    if (journal?.journal_mode !== "delete") throw Error("unavailable");
    if (mode === "write") {
      db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000");
      if (created) createHumanWikiConsentIntentSchema(db);
    }
    const result = fn(db);
    if (created) syncPrivateDirectory(directory);
    const after = fileIdentity(file);
    if (original.dev !== after.dev || original.ino !== after.ino ||
        !noSidecars(file) || !safeDirectory(directory)) throw Error("unavailable");
    return result;
  } finally {
    db.close();
  }
}
