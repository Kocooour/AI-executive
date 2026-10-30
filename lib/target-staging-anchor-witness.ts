/**
 * R2c.4a staging-only durable commit witness.
 *
 * A JSONL intent and a SQLite COMMIT are not an atomic pair. If the process is
 * killed after COMMIT but before JSONL confirm, a restored pre-commit DB cannot
 * be distinguished from a genuine pre-COMMIT crash. This independent SQLite
 * witness is ATTACHed to the *same* SQLite transaction as the target DB.
 *
 * SQLite's rollback-journal multi-database commit (super-journal) makes both
 * databases atomic on the same filesystem. No WAL, no in-memory main database.
 * Restoring ONLY lumi-target.sqlite leaves the witnessed commit sequence in
 * this file, even when JSONL confirm was lost. Restoring both database files
 * (or a whole host/directory snapshot) is out of scope, as documented.
 */
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TARGET_STAGING_WITNESS_FILENAME = "lumi-target-witness.sqlite";
export const TARGET_STAGING_WITNESS_ALIAS = "lumi_witness";
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DDL = `
CREATE TABLE commits (
  n INTEGER PRIMARY KEY CHECK(n >= 0),
  journal_hash TEXT NOT NULL CHECK(length(journal_hash) = 64),
  generation TEXT NOT NULL
);
CREATE TRIGGER commits_immutable_update BEFORE UPDATE ON commits
BEGIN SELECT RAISE(ABORT, 'committed witness is immutable'); END;
CREATE TRIGGER commits_immutable_delete BEFORE DELETE ON commits
BEGIN SELECT RAISE(ABORT, 'committed witness cannot be removed'); END;
CREATE TRIGGER commits_monotonic_insert BEFORE INSERT ON commits
WHEN EXISTS(SELECT 1 FROM commits WHERE n >= NEW.n)
BEGIN SELECT RAISE(ABORT, 'committed witness must increase'); END;
`;

function validRow(row: unknown, generation: string): row is { n: number; journal_hash: string; generation: string } {
  if (!row || typeof row !== "object") return false;
  const r = row as { n?: unknown; journal_hash?: unknown; generation?: unknown };
  return typeof r.n === "number" && Number.isSafeInteger(r.n) && r.n >= 0 &&
    typeof r.journal_hash === "string" && HASH.test(r.journal_hash) &&
    typeof r.generation === "string" && r.generation === generation;
}

function readRows(db: DatabaseSync, name: string, generation: string, genesisHash: string): number | null {
  try {
    if (!UUID.test(generation) || !HASH.test(genesisHash)) return null;
    const genesis = db.prepare(`SELECT n,journal_hash,generation FROM ${name}.commits WHERE n=0`).get();
    const last = db.prepare(`SELECT n,journal_hash,generation FROM ${name}.commits ORDER BY n DESC LIMIT 1`).get();
    if (!validRow(genesis, generation) || genesis.journal_hash !== genesisHash ||
        !validRow(last, generation)) return null;
    return last.n;
  } catch { return null; }
}

/** Validate the on-disk witness before allowing SQLite to open its pathname. */
function validWitnessFile(directoryRoot: string): boolean {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined ||
      typeof process.getuid !== "function") return false;
  const filename = path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME);
  let fd: number | null = null;
  try {
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const now = fstatSync(fd);
    const header = Buffer.alloc(20);
    return now.isFile() && now.nlink === 1 && now.uid === process.getuid() &&
      (now.mode & 0o777) === 0o600 && now.dev === before.dev && now.ino === before.ino &&
      readSync(fd, header, 0, 20, 0) === 20 &&
      header.toString("ascii", 0, 16) === "SQLite format 3\0" &&
      header[18] === 1 && header[19] === 1;
  } catch { return false; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* fail closed */ } } }
}

/** Bootstrap exclusively, with a private file on the same filesystem as main. */
export function bootstrapTargetStagingWitness(
  directoryRoot: string, generation: string, genesisHash: string,
): void {
  if (!UUID.test(generation) || !HASH.test(genesisHash)) throw new Error("Invalid witness genesis");
  const filename = path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME);
  const fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    try {
      db.exec(DDL);
      db.prepare("INSERT INTO commits(n,journal_hash,generation) VALUES (0,?,?)").run(genesisHash, generation);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

/** Attach BEFORE BEGIN IMMEDIATE so the writer holds both RESERVED locks. */
export function attachTargetStagingWitness(
  db: DatabaseSync, directoryRoot: string, generation: string, genesisHash: string,
): boolean {
  try {
    if (!validWitnessFile(directoryRoot)) return false;
    db.prepare(`ATTACH DATABASE ? AS ${TARGET_STAGING_WITNESS_ALIAS}`)
      .run(path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME));
    db.exec("PRAGMA main.synchronous=FULL; PRAGMA lumi_witness.synchronous=FULL");
    // ATTACH cannot be made WAL-backed: it would lose cross-file atomicity.
    const mainMode = db.prepare("PRAGMA main.journal_mode").get() as { journal_mode: string };
    const witnessMode = db.prepare("PRAGMA lumi_witness.journal_mode").get() as { journal_mode: string };
    if (mainMode.journal_mode !== "delete" || witnessMode.journal_mode !== "delete" ||
        !validWitnessFile(directoryRoot)) return false;
    return readRows(db, TARGET_STAGING_WITNESS_ALIAS, generation, genesisHash) !== null;
  } catch { return false; }
}

/** Use inside the same transaction as UPDATE metadata.anchor_seq. */
export function recordTargetStagingWitnessCommit(
  db: DatabaseSync, n: number, hash: string, generation: string,
): void {
  if (!Number.isSafeInteger(n) || n < 1 || !HASH.test(hash) || !UUID.test(generation)) throw new Error();
  db.prepare("INSERT INTO lumi_witness.commits(n,journal_hash,generation) VALUES (?,?,?)")
    .run(n, hash, generation);
}

/** Read-only witness check while the caller holds its source SQLite SHARED lock. */
export function readTargetStagingWitness(
  directoryRoot: string, generation: string, genesisHash: string,
): number | null {
  if (!validWitnessFile(directoryRoot)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME), { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    return readRows(db, "main", generation, genesisHash);
  } catch { return null; }
  finally { if (db) { try { db.close(); } catch { /* fail closed */ } } }
}

/** Writer's attached witness snapshot under BEGIN IMMEDIATE. */
export function readAttachedTargetStagingWitness(
  db: DatabaseSync, generation: string, genesisHash: string,
): number | null {
  return readRows(db, TARGET_STAGING_WITNESS_ALIAS, generation, genesisHash);
}
