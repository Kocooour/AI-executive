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
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
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

/**
 * Prefix verification mirrors the JSONL journal's cache: a cold process validates
 * every witness commit and its exact verified JSONL intent hash OUTSIDE the main
 * SQLite lock. Within the lock only the boundary and newly committed suffix are
 * checked. Changes at a stable high-water mark (including an edited middle row)
 * force a complete re-verification. A host operator able to rewrite historical
 * rows together with a new suffix remains outside the staging threat model.
 */
interface WitnessPrefix { readonly n: number; readonly hash: string; readonly change: string; readonly count: number }
const witnessCache = new Map<string, WitnessPrefix>();
const WITNESS_CACHE_MAX = 16;
export function clearTargetStagingWitnessCache(): void { witnessCache.clear(); }

type JournalIntentStatus = "pending" | "confirmed" | "aborted";

function readRows(
  db: DatabaseSync, name: string, generation: string, genesisHash: string,
  directoryRoot: string, intents?: ReadonlyMap<number, string>,
  statuses?: ReadonlyMap<number, JournalIntentStatus>,
): number | null {
  try {
    if (!UUID.test(generation) || !HASH.test(genesisHash)) return null;
    const genesis = db.prepare(`SELECT n,journal_hash,generation FROM ${name}.commits WHERE n=0`).get();
    const last = db.prepare(`SELECT n,journal_hash,generation FROM ${name}.commits ORDER BY n DESC LIMIT 1`).get();
    if (!validRow(genesis, generation) || genesis.journal_hash !== genesisHash ||
        !validRow(last, generation)) return null;
    if (!intents || !statuses) return last.n; // ATTACH preflight; verified after journal scan.
    if (last.n > intents.size || (last.n > 0 && intents.get(last.n) !== last.journal_hash))
      return null;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM ${name}.commits`).get() as
      { total: number } | undefined;
    if (!total || !Number.isSafeInteger(total.total)) return null;
    const stat = statSync(path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME), { bigint: true });
    if (!stat.isFile() || String(stat.nlink) !== "1") return null;
    const key = `${stat.dev}:${stat.ino}:${generation}`;
    const change = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    const old = witnessCache.get(key);
    if (old && (old.n > last.n || old.count > total.total ||
        (old.n === last.n && (old.hash !== last.journal_hash ||
          old.change !== change || old.count !== total.total)))) {
      // A change without a new committed head must be checked from genesis.
      witnessCache.delete(key);
    }
    const good = witnessCache.get(key);
    if (good && good.n === last.n && good.count === total.total) return last.n;
    if (good) {
      // Even when the head grew, verify that its previously checked boundary survives.
      const boundary = db.prepare(`SELECT journal_hash FROM ${name}.commits WHERE n=?`).get(good.n) as
        { journal_hash?: unknown } | undefined;
      if (!boundary || boundary.journal_hash !== good.hash) return null;
    }
    const start = good ? good.n + 1 : 0;
    const rows = db.prepare(`SELECT n,journal_hash,generation FROM ${name}.commits
      WHERE n >= ? ORDER BY n`).all(start);
    const found = new Set<number>();
    let previous = start - 1;
    for (const row of rows) {
      if (!validRow(row, generation) || row.n <= previous ||
          (row.n === 0 ? row.journal_hash !== genesisHash :
            intents.get(row.n) !== row.journal_hash ||
            (statuses.get(row.n) !== "confirmed" && statuses.get(row.n) !== "pending")))
        return null;
      found.add(row.n);
      previous = row.n;
    }
    if (previous !== last.n || total.total !== (good ? good.count + rows.length : rows.length))
      return null;
    // Aborted intent numbers are legitimate gaps; every CONFIRMED intent must
    // nevertheless have a matching immutable witness row. Pending can be present
    // only if its COMMIT won; the anchor check distinguishes that case.
    for (let n = Math.max(1, start); n <= intents.size; n++) {
      const status = statuses.get(n);
      if ((status === "confirmed" || (status === "pending" && n <= last.n)) &&
          !found.has(n)) return null;
    }
    if (witnessCache.size >= WITNESS_CACHE_MAX && !witnessCache.has(key)) witnessCache.clear();
    witnessCache.set(key, { n: last.n, hash: last.journal_hash, change, count: total.total });
    return last.n;
  } catch { return null; }
}

/** Validate the on-disk witness before allowing SQLite to open its pathname. */
function validWitnessFile(directoryRoot: string): { dev: number; ino: number } | null {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined ||
      typeof process.getuid !== "function") return null;
  const filename = path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME);
  let fd: number | null = null;
  try {
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const now = fstatSync(fd);
    const header = Buffer.alloc(20);
    const ok = now.isFile() && now.nlink === 1 && now.uid === process.getuid() &&
      (now.mode & 0o777) === 0o600 && now.dev === before.dev && now.ino === before.ino &&
      readSync(fd, header, 0, 20, 0) === 20 &&
      header.toString("ascii", 0, 16) === "SQLite format 3\0" &&
      header[18] === 1 && header[19] === 1;
    return ok ? { dev: now.dev, ino: now.ino } : null;
  } catch { return null; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* fail closed */ } } }
}

/** Handle of a successfully ATTACHed witness. */
export interface AttachedTargetStagingWitness {
  /** The canonical witness path still names the inode that was validated and attached
   * (no atomic replacement by rename, hard link or symlink). */
  stillAttached(): boolean;
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
): AttachedTargetStagingWitness | null {
  try {
    const identity = validWitnessFile(directoryRoot);
    if (!identity) return null;
    db.prepare(`ATTACH DATABASE ? AS ${TARGET_STAGING_WITNESS_ALIAS}`)
      .run(path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME));
    db.exec("PRAGMA main.synchronous=FULL; PRAGMA lumi_witness.synchronous=FULL");
    // ATTACH cannot be made WAL-backed: it would lose cross-file atomicity.
    const mainMode = db.prepare("PRAGMA main.journal_mode").get() as { journal_mode: string };
    const witnessMode = db.prepare("PRAGMA lumi_witness.journal_mode").get() as { journal_mode: string };
    const after = validWitnessFile(directoryRoot);
    if (mainMode.journal_mode !== "delete" || witnessMode.journal_mode !== "delete" ||
        !after || after.dev !== identity.dev || after.ino !== identity.ino) return null;
    if (readRows(db, TARGET_STAGING_WITNESS_ALIAS, generation, genesisHash, directoryRoot) === null) return null;
    const filename = path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME);
    return {
      stillAttached: () => {
        try {
          const current = lstatSync(filename);
          return current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
            current.dev === identity.dev && current.ino === identity.ino;
        } catch { return false; }
      },
    };
  } catch { return null; }
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
  intents: ReadonlyMap<number, string>, statuses: ReadonlyMap<number, JournalIntentStatus>,
): number | null {
  if (!validWitnessFile(directoryRoot)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(directoryRoot, TARGET_STAGING_WITNESS_FILENAME), { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000; PRAGMA query_only=ON");
    return readRows(db, "main", generation, genesisHash, directoryRoot, intents, statuses);
  } catch { return null; }
  finally { if (db) { try { db.close(); } catch { /* fail closed */ } } }
}

/** Writer's attached witness snapshot under BEGIN IMMEDIATE. */
export function readAttachedTargetStagingWitness(
  db: DatabaseSync, generation: string, genesisHash: string,
  directoryRoot: string, intents: ReadonlyMap<number, string>,
  statuses: ReadonlyMap<number, JournalIntentStatus>,
): number | null {
  return readRows(db, TARGET_STAGING_WITNESS_ALIAS, generation, genesisHash, directoryRoot, intents, statuses);
}
