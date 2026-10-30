/**
 * R2 staging-only pinned-file write transaction, shared by every staging writer
 * (task title, durable session issuance and revocation). Not a route and not a
 * production VFS.
 *
 * Node SQLite cannot attach to a pinned fd. Hold a no-follow source fd and
 * fail closed unless the SQLite open adds exactly one regular-file descriptor
 * matching that inode. This is only a staging best-effort check, not a
 * production-safe fd-backed VFS or protection against hostile FD/path races.
 * BEGIN IMMEDIATE serializes writers; canonical preflight runs inside it.
 * Any failure or an un-committed body rolls back.
 */
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  readdirSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TARGET_STORE_FILENAME, verifyExistingTargetStagingPath } from "./target-store-bootstrap";
import {
  appendTargetStagingJournalLine, checkTargetStagingJournal, evaluateTargetStagingAnchor,
  openTargetStagingJournal, parseTargetStagingAnchor, scanTargetStagingJournalFd, warmTargetStagingJournal,
  resolveTargetStagingJournalTail, serializeTargetStagingJournalLine, targetStagingJournalGenesis,
  truncateTargetStagingJournal,
} from "./target-staging-anchor-journal";
import type {
  TargetStagingAnchorVerdict, TargetStagingJournalKind, TargetStagingJournalPayload,
} from "./target-staging-anchor-journal";
import {
  attachTargetStagingWitness, readAttachedTargetStagingWitness, recordTargetStagingWitnessCommit,
} from "./target-staging-anchor-witness";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

/** Internal control-flow marker: every boundary failure collapses to null. */
class PinDenied extends Error {}

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingPinnedWriteContext {
  readonly db: DatabaseSync;
  readonly databaseFd: number;
  readonly directory: string;
  readonly databasePath: string;
  /** Path still names the pinned inode (no swap, hard link or symlink). */
  stillPinned(): boolean;
  /** No -journal/-shm/-wal sidecar exists next to the pinned database. */
  noSidecars(): boolean;
  /**
   * Commit. A body that returns without calling this is rolled back. R2c.4a: `entry`
   * is the content-free journal record of this write; the intent is appended and
   * fsynced just before COMMIT (a failure rolls the transaction back), `anchor_seq` is
   * advanced in the same transaction and the confirm follows the COMMIT.
   */
  commit(entry: TargetStagingJournalEntry): void;
}

export interface TargetStagingJournalEntry {
  readonly kind: TargetStagingJournalKind;
  /** Content-free fields only (IDs, hashes, roles, numbers). Never titles or credentials. */
  readonly payload: TargetStagingJournalPayload;
}

export function noTargetStagingSidecars(
  databasePath: string, suffixes: readonly string[] = ["-journal", "-shm", "-wal"],
): boolean {
  for (const suffix of suffixes) {
    try {
      lstatSync(databasePath + suffix);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

export interface PinnedTargetStagingFiles {
  readonly directory: string;
  readonly databasePath: string;
  readonly databaseFd: number;
  /** `/proc|/dev/fd/<directory fd>`: open siblings below the pinned directory without a path walk. */
  readonly directoryFdPath: string;
  /** Path still names the pinned inode (no swap, hard link or symlink). */
  stillPinned(): boolean;
  /**
   * Open SQLite on the verified path, then (after the caller ran its first
   * statement, which is when SQLite really opens the file) prove that exactly
   * one new regular-file descriptor appeared and that it is the pinned inode.
   */
  openDatabase(options: { readOnly: boolean }): { db: DatabaseSync; verifyOpened(): boolean };
  close(): void;
}

/**
 * Shared by writers and the live read check: a no-follow directory fd owned by
 * this uid with mode 0700, whose /proc|/dev/fd realpath equals the verified
 * directory, and a database fd opened THROUGH that directory fd whose
 * dev/ino/nlink match the lstat of the path. Returns null (fail closed) on any
 * boundary failure. Same staging-only limits as the writer: this is not a
 * production fd-backed VFS.
 */
export function pinTargetStagingFiles(stagingDirectory: string): PinnedTargetStagingFiles | null {
  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd"
    : process.platform === "darwin" ? "/dev/fd" : null;
  if (!descriptorRoot || constants.O_DIRECTORY === undefined ||
      constants.O_NOFOLLOW === undefined) return null;
  let directoryFd: number | null = null;
  let databaseFd: number | null = null;
  try {
    const directory = verifyExistingTargetStagingPath(stagingDirectory);
    directoryFd = openSync(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (realpathSync(descriptorRoot + "/" + directoryFd) !== directory) throw new PinDenied();
    // Only the bootstrap-created private staging directory is accepted. Never
    // open a path shared with a different user or a legacy production store.
    const stagingStat = fstatSync(directoryFd);
    if (!process.getuid || stagingStat.uid !== process.getuid() ||
        (stagingStat.mode & 0o077) !== 0) throw new PinDenied();
    const databasePath = path.join(directory, TARGET_STORE_FILENAME);
    const info = lstatSync(databasePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new PinDenied();
    databaseFd = openSync(descriptorRoot + "/" + directoryFd + "/" + TARGET_STORE_FILENAME,
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(databaseFd);
    if (!pinned.isFile() || pinned.nlink !== 1 ||
        pinned.dev !== info.dev || pinned.ino !== info.ino) throw new PinDenied();
    // A WAL-mode source may create -wal/-shm even on a read-only SQLite open.
    // Reject it from the pinned header first.
    const header = Buffer.alloc(20);
    if (readSync(databaseFd, header, 0, header.length, 0) !== header.length ||
        header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
        header[18] !== 1 || header[19] !== 1) throw new PinDenied();

    // Observe newly opened *regular-file descriptors*, rather than accepting
    // a rising count of ANY descriptors pointing to the pinned inode. An
    // unexpected concurrent file open makes the operation fail closed.
    const regularFiles = (): Map<number, { dev: number; ino: number }> => {
      const result = new Map<number, { dev: number; ino: number }>();
      for (const name of readdirSync(descriptorRoot)) {
        if (!/^[0-9]+$/.test(name)) continue;
        try {
          const fd = Number(name);
          const stat = fstatSync(fd);
          if (stat.isFile()) result.set(fd, { dev: stat.dev, ino: stat.ino });
        } catch { /* directory enumeration FD may close before fstat */ }
      }
      return result;
    };
    const stillPinned = (): boolean => {
      try {
        const current = lstatSync(databasePath);
        return current.isFile() && !current.isSymbolicLink() &&
          current.nlink === 1 && current.dev === pinned.dev && current.ino === pinned.ino;
      } catch { return false; }
    };
    const dirFd = directoryFd;
    const dbFd = databaseFd;
    directoryFd = null;
    databaseFd = null;
    return {
      directory, databasePath, databaseFd: dbFd, stillPinned,
      directoryFdPath: descriptorRoot + "/" + dirFd,
      openDatabase: options => {
        const beforeOpen = regularFiles();
        const db = new DatabaseSync(databasePath, { readOnly: options.readOnly });
        return {
          db,
          verifyOpened: () => {
            const newlyOpened = [...regularFiles()].filter(([fd]) => !beforeOpen.has(fd));
            // Writers keep the strict rule (exactly one new regular file, the pinned
            // inode). A read-only open in a long-lived server may see unrelated
            // concurrent opens, so it only requires that the pinned inode was opened.
            const matches = (entry: [number, { dev: number; ino: number }]) =>
              entry[1].dev === pinned.dev && entry[1].ino === pinned.ino;
            return (options.readOnly ? newlyOpened.some(matches)
              : newlyOpened.length === 1 && matches(newlyOpened[0])) && stillPinned();
          },
        };
      },
      close: () => {
        try { closeSync(dbFd); } catch { /* fail closed */ }
        try { closeSync(dirFd); } catch { /* fail closed */ }
      },
    };
  } catch {
    if (databaseFd !== null) { try { closeSync(databaseFd); } catch { /* fail closed */ } }
    if (directoryFd !== null) { try { closeSync(directoryFd); } catch { /* fail closed */ } }
    return null;
  }
}

/**
 * Establish the pinned connection, take the RESERVED write lock, run the
 * canonical r2-model preflight on that very connection, then call body. The
 * caller cannot supply a DatabaseSync, file descriptor or generation.
 * `denied` is returned for every boundary failure, `failed` for any exception.
 */
export function withPinnedTargetStagingWrite<T>(
  store: TargetStagingReadStore,
  body: (context: TargetStagingPinnedWriteContext) => T,
  denied: () => T,
  failed: () => T,
  /**
   * Bounded lock wait (default 200 ms). Every pinned writer, INCLUDING the title
   * writer which previously failed immediately, now blocks synchronously (the
   * thread sleeps inside SQLite) for up to this long when another connection
   * holds a lock. COMMIT needs an exclusive lock and can briefly race with the
   * SHARED locks of live session checks; waiting a little avoids failing a
   * correct command, while the bound keeps a stuck holder from hanging the
   * process. A holder longer than the bound still fails the write (write_failed).
   */
  busyTimeoutMs = 200,
): T {
  if (!store || typeof store.stagingDirectory !== "string" ||
      typeof store.expectedRestoreGeneration !== "string" ||
      !GENERATION.test(store.expectedRestoreGeneration) ||
      !Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 10_000) return denied();

  let files: PinnedTargetStagingFiles | null = null;
  let db: DatabaseSync | null = null;
  let transaction = false;
  let journalFd: number | null = null;
  try {
    files = pinTargetStagingFiles(store.stagingDirectory);
    if (!files || !noTargetStagingSidecars(files.databasePath)) return denied();
    // R2c.4a: the (possibly long) cold chain verification happens BEFORE the write lock.
    warmTargetStagingJournal(files.directoryFdPath, store.expectedRestoreGeneration);
    const opened = files.openDatabase({ readOnly: false });
    db = opened.db;
    // Set the bounded wait BEFORE the first SQLite read and ATTACH: a short
    // EXCLUSIVE lock held by another connection must not fail immediately.
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    // Prove that SQLite opened the pinned main inode BEFORE ATTACH adds the
    // second (witness) database descriptor.
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (!opened.verifyOpened()) return denied();
    const genesisHash = targetStagingJournalGenesis(store.expectedRestoreGeneration).hash;
    // ATTACH before BEGIN IMMEDIATE: the two durable SQLite files commit as one
    // rollback-journal transaction (no WAL). A lost JSONL confirm is no longer
    // ambiguous after a restore of just the main DB.
    // ATTACH MUST use the durable canonical filesystem pathname, not the
    // /proc/self/fd/N alias: SQLite records attached journal paths in its
    // crash-recovery super-journal, which must remain valid after process exit.
    if (!attachTargetStagingWitness(db, files.directory,
        store.expectedRestoreGeneration, genesisHash)) return denied();
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    transaction = true;
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (!files.stillPinned() || !noTargetStagingSidecars(files.databasePath)) return denied();

    // All checks, including current roles and the pinned source integrity check,
    // occur under the same SQLite RESERVED write lock.
    const preflight = inspectIsolatedTargetStore({
      stagingDirectory: files.directory,
      expectedRestoreGeneration: store.expectedRestoreGeneration,
      mode: "r2-model",
    }, { db, fd: files.databaseFd });
    if (!preflight.ok) return denied();
    const connection = db;
    const pinnedFiles = files;

    // R2c.4a: verify the journal against the DB anchor under the write lock (no commit
    // can interleave) and resolve a trailing unconfirmed intent of a crashed writer.
    journalFd = openTargetStagingJournal(pinnedFiles.directoryFdPath, true);
    if (journalFd === null) return denied();
    const journal = journalFd;
    const anchorRaw = (connection.prepare("SELECT value FROM metadata WHERE key='anchor_seq'")
      .get() as { value: unknown } | undefined)?.value;
    const anchor = parseTargetStagingAnchor(anchorRaw);
    const scan = scanTargetStagingJournalFd(journal, store.expectedRestoreGeneration);
    let state = scan ? scan.state : null;
    const witnessed = readAttachedTargetStagingWitness(connection,
      store.expectedRestoreGeneration, genesisHash);
    // Verdict first, on the complete lines: an untrusted store is never modified.
    // A restored main DB may have the same number as the last JSONL confirm but
    // be behind a COMMITTED unconfirmed intent. The atomic witness detects it.
    if (!state || anchor === null || witnessed === null || anchor !== witnessed ||
        evaluateTargetStagingAnchor(state, anchor) !== "ok") return denied();
    if (scan && scan.torn) {
      // Under the write lock nobody else appends: cut the unfinished fragment (a failed or
      // killed append) back to the last complete line before resolving the tail.
      truncateTargetStagingJournal(journal, scan.completeBytes);
    }
    const generation = state.generation;
    if (state.pending !== null) {
      const tail = resolveTargetStagingJournalTail(state, anchor);
      if (tail.action !== "none") {
        const line = serializeTargetStagingJournalLine({
          n: tail.n, t: tail.action, k: null, p: null, g: generation, prev: state.lastHash,
        });
        appendTargetStagingJournalLine(journal, line.text);
        state = { ...state, confirmed: tail.action === "confirm" ? Math.max(state.confirmed, tail.n) : state.confirmed,
          pending: null, lastHash: line.hash, records: state.records + 1 };
      }
    }
    let tailState = state;
    const seqBefore = Number((connection.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM change_log")
      .get() as { n: number }).n);
    let committed = false;
    return body({
      db: connection, databaseFd: pinnedFiles.databaseFd, directory: pinnedFiles.directory,
      databasePath: pinnedFiles.databasePath, stillPinned: pinnedFiles.stillPinned,
      noSidecars: () => noTargetStagingSidecars(pinnedFiles.databasePath),
      commit: entry => {
        if (committed || !entry || typeof entry.kind !== "string") throw new Error();
        committed = true;
        const seqAfter = Number((connection.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM change_log")
          .get() as { n: number }).n);
        const n = tailState.lastIntent + 1;
        const intent = serializeTargetStagingJournalLine({
          n, t: "intent", k: entry.kind,
          p: { ...entry.payload, ...(seqAfter > seqBefore ? { seq: [seqBefore + 1, seqAfter] } : {}) },
          g: generation, prev: tailState.lastHash,
        });
        // Durable BEFORE the commit: a thrown error here rolls the transaction back.
        appendTargetStagingJournalLine(journal, intent.text);
        tailState = { ...tailState, lastIntent: n, pending: n, lastHash: intent.hash, records: tailState.records + 1 };
        const advanced = connection.prepare("UPDATE metadata SET value = ? WHERE key = 'anchor_seq'")
          .run(String(n));
        if (advanced.changes !== 1) throw new Error();
        // This insert and the main anchor update are one SQLite ATTACH commit.
        // Without it a crash after COMMIT, before JSONL confirm, is ambiguous.
        recordTargetStagingWitnessCommit(connection, n, intent.hash, generation);
        connection.exec("COMMIT");
        transaction = false;
        // After the commit, under a FRESH write lock (the chain is linear: an append must be
        // computed from the tail read while holding the lock, because another writer may have
        // resolved this very intent already): append the confirm unless it is there. A failure
        // here only leaves a trailing intent which the next writer resolves (anchor == intent).
        try {
          connection.exec("BEGIN IMMEDIATE");
          transaction = true;
          const fresh = scanTargetStagingJournalFd(journal, generation);
          if (fresh && fresh.torn) truncateTargetStagingJournal(journal, fresh.completeBytes);
          const current = fresh ? fresh.state : null;
          if (current && current.pending === n) {
            appendTargetStagingJournalLine(journal, serializeTargetStagingJournalLine({
              n, t: "confirm", k: null, p: null, g: generation, prev: current.lastHash,
            }).text);
          }
          connection.exec("ROLLBACK");
          transaction = false;
        } catch { /* resolved by the next writer */ }
      },
    });
  } catch {
    return failed();
  } finally {
    if (db) {
      if (transaction) {
        try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
      }
      try { db.close(); } catch { /* fail closed */ }
    }
    if (journalFd !== null) { try { closeSync(journalFd); } catch { /* fail closed */ } }
    if (files) files.close();
  }
}

/**
 * Journal verdict for the connection the caller already holds a SQLite lock on (a SHARED
 * read snapshot of the live store). The anchor is read from `db`, the journal is opened
 * below the pinned directory fd; see evaluateTargetStagingAnchor for the rules.
 */
export function checkPinnedTargetStagingAnchor(
  files: PinnedTargetStagingFiles, db: DatabaseSync, generation: string,
): TargetStagingAnchorVerdict {
  try {
    const raw = (db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'")
      .get() as { value: unknown } | undefined)?.value;
    return checkTargetStagingJournal(files.directoryFdPath, raw, generation);
  } catch { return "journal_invalid"; }
}
