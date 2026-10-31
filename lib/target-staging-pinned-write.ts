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
  readFileSync, readdirSync, realpathSync,
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
import { logStagingFailure } from "./target-staging-failure-log";
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

/**
 * Best-effort, read-only distinction between an active SQLite rollback-journal
 * writer and a leftover journal after the bounded sidecar wait. On Linux,
 * SQLite's POSIX RESERVED/EXCLUSIVE write lock is visible in /proc/locks; the
 * pinned fd supplies the actual main database inode (no path-following).
 *
 * A positive result is sufficient to classify a TIMEOUT as retryable, never to
 * permit a database open. On platforms without /proc/locks the owner cannot
 * safely distinguish a stalled writer from a stale regular sidecar: return
 * unknown, and still refuse the write (retryable, not an auth denial).
 */
function activeSQLiteWriterLock(databaseFd: number): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const file = fstatSync(databaseFd, { bigint: true });
    const dev = file.dev;
    // BigInt() rather than bigint literals: the project's TS target is < ES2020.
    const major = ((dev & BigInt(0xfff00)) >> BigInt(8)) |
      ((dev >> BigInt(32)) & BigInt(0xfffff000));
    const minor = (dev & BigInt(0xff)) |
      ((dev >> BigInt(12)) & BigInt(0xffffff00));
    const ino = file.ino;
    for (const line of readFileSync("/proc/locks", "utf8").split("\n")) {
      // Ignore waiting lock requests (prefixed "->"), SHARED readers and
      // unrelated inodes. A live writer holds a POSIX WRITE byte-range lock.
      const match = /^\d+:\s+(?:POSIX|OFDLCK)\s+ADVISORY\s+WRITE\s+\S+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+\d+\s+(?:\d+|EOF)$/.exec(line);
      if (match && BigInt("0x" + match[1]) === major &&
          BigInt("0x" + match[2]) === minor && BigInt(match[3]) === ino) return true;
    }
    return false;
  } catch { return null; } // absent /proc or restricted lock visibility
}

/** A numeric fd can be reused after another file closes: prove a net-new
 * pinned-inode handle, rather than a numeric fd absent from the first scan. */
export function hasNewPinnedReadDescriptor(
  before: ReadonlyMap<number, { dev: number; ino: number }>,
  after: ReadonlyMap<number, { dev: number; ino: number }>,
  pinned: { dev: number; ino: number },
): boolean {
  const matches = (v: { dev: number; ino: number }) => v.dev === pinned.dev && v.ino === pinned.ino;
  let count = 0;
  for (const v of after.values()) if (matches(v)) count++;
  for (const v of before.values()) if (matches(v)) count--;
  return count > 0;
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
   * Open SQLite on the verified path. The read-only proof permits recycled
   * descriptor numbers; the writer retains its strict fd-set check.
   * afterSnapshotBeforeSQLiteOpen is a synchronous, internal TEST-ONLY seam,
   * never populated by staging routes or writer code.
   */
  openDatabase(options: {
    readOnly: boolean;
    afterSnapshotBeforeSQLiteOpen?: () => void;
  }): { db: DatabaseSync; verifyOpened(): boolean };
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
        // Deterministically reproduce concurrent descriptor recycling in tests.
        // No production call passes this hook; writer opens cannot supply it.
        if (options.afterSnapshotBeforeSQLiteOpen) {
          if (!options.readOnly) throw new PinDenied();
          options.afterSnapshotBeforeSQLiteOpen();
        }
        const db = new DatabaseSync(databasePath, { readOnly: options.readOnly });
        return {
          db,
          verifyOpened: () => {
            const afterOpen = regularFiles();
            const newlyOpened = [...afterOpen].filter(([fd]) => !beforeOpen.has(fd));
            // Writers keep the strict rule (exactly one new regular file, the pinned
            // inode). A read-only open in a long-lived server may see unrelated
            // concurrent opens, so it only requires that the pinned inode was opened.
            const matches = (entry: [number, { dev: number; ino: number }]) =>
              entry[1].dev === pinned.dev && entry[1].ino === pinned.ino;
            return (options.readOnly ? hasNewPinnedReadDescriptor(beforeOpen, afterOpen, pinned)
              : newlyOpened.length === 1 && matches(newlyOpened[0])) && stillPinned();
          },
        };
      },
      close: () => {
        try { closeSync(dbFd); } catch { /* fail closed */ }
        try { closeSync(dirFd); } catch { /* fail closed */ }
      },
    };
  } catch (error) {
    logStagingFailure("pin_files", error instanceof PinDenied ? "boundary_denied" : "exception", error);
    if (databaseFd !== null) { try { closeSync(databaseFd); } catch { /* fail closed */ } }
    if (directoryFd !== null) { try { closeSync(directoryFd); } catch { /* fail closed */ } }
    return null;
  }
}

/**
 * The single trust rule of every journal-modifying step (pre-write tail resolution AND the
 * post-COMMIT confirm). Must run inside a write transaction on a connection with the witness
 * ATTACHed (the attachment lives until the connection closes). Returns the complete-line scan
 * and the anchor only when the journal, the main `anchor_seq` and the atomic SQLite witness
 * agree (anchor === witness, verdict "ok"); otherwise null and the caller must not modify
 * the store. A restored main DB may equal the last JSONL confirm yet trail a COMMITTED
 * unconfirmed intent: only the witness detects that.
 */
export function trustedTargetStagingTail(
  connection: DatabaseSync, journal: number, generation: string, genesisHash: string, directoryFdPath: string,
): { scan: NonNullable<ReturnType<typeof scanTargetStagingJournalFd>>; anchor: number } | null {
  const anchor = parseTargetStagingAnchor((connection.prepare("SELECT value FROM metadata WHERE key='anchor_seq'")
    .get() as { value: unknown } | undefined)?.value);
  const scan = scanTargetStagingJournalFd(journal, generation);
  if (!scan || anchor === null) return null;
  const witnessed = readAttachedTargetStagingWitness(connection, generation, genesisHash, directoryFdPath,
    scan.intentHashes, scan.intentStatuses);
  if (witnessed === null || anchor !== witnessed ||
      evaluateTargetStagingAnchor(scan.state, anchor) !== "ok") return null;
  return { scan, anchor };
}

/**
 * Post-COMMIT step, inside a fresh write transaction: append `confirm n` only for a TRUSTED
 * store (same verdict as before the write, including the witness) whose tail is still the
 * pending intent n. An untrusted store (e.g. restored in place since the COMMIT) is left
 * byte-for-byte untouched, fragment included; the next writer refuses it.
 */
export function appendTargetStagingConfirmIfTrusted(
  connection: DatabaseSync, journal: number, generation: string, genesisHash: string,
  directoryFdPath: string, n: number, pathsStillTrusted: () => boolean,
): boolean {
  // The canonical main/witness paths must still name the inodes this connection holds
  // (an atomic rename of an older copy leaves the open connection on the old inode).
  if (!pathsStillTrusted()) return false;
  const trusted = trustedTargetStagingTail(connection, journal, generation, genesisHash, directoryFdPath);
  if (!trusted || !pathsStillTrusted()) return false;
  if (trusted.scan.torn) truncateTargetStagingJournal(journal, trusted.scan.completeBytes);
  if (trusted.scan.state.pending !== n) return false;
  appendTargetStagingJournalLine(journal, serializeTargetStagingJournalLine({
    n, t: "confirm", k: null, p: null, g: generation, prev: trusted.scan.state.lastHash,
  }).text);
  return true;
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
    if (!files) return denied();
    // A *different* writer creates a SQLite -journal while committing. This check
    // precedes our SQLite lock (opening a DB with an untrusted sidecar could perform
    // crash recovery), so a single observation must not become an auth/trust denial.
    // Give a legitimate in-flight writer the same bounded grace as busy_timeout.
    // A sidecar that does not disappear is still refused WITHOUT opening SQLite:
    // the operator must handle a stale or hot journal, never this writer.
    const sidecarDeadline = Date.now() + busyTimeoutMs;
    const sidecarSleep = new Int32Array(new SharedArrayBuffer(4));
    while (!noTargetStagingSidecars(files.databasePath, ["-journal"])) {
      // WAL/SHM are never part of this rollback-mode store; neither is a
      // replaced main DB or a non-regular/symlinked rollback sidecar.
      if (!files.stillPinned() ||
          !noTargetStagingSidecars(files.databasePath, ["-wal", "-shm"])) return denied();
      try {
        const sidecar = lstatSync(files.databasePath + "-journal");
        if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1) return denied();
      } catch (error) {
        // ENOENT means the journal disappeared between observations. All
        // other filesystem errors are trust/boundary failures, not contention.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return denied();
        continue;
      }
      const remaining = sidecarDeadline - Date.now();
      if (remaining <= 0) {
        // A verified active SQLite writer is contention, not an untrusted
        // store. Without a reliable lock probe remain fail-closed, but classify
        // a bounded wait as retryable. A confirmed stale journal stays denied.
        return activeSQLiteWriterLock(files.databaseFd) === false ? denied() : failed();
      }
      Atomics.wait(sidecarSleep, 0, 0, Math.min(5, remaining));
    }
    if (!noTargetStagingSidecars(files.databasePath, ["-wal", "-shm"]) ||
        !files.stillPinned()) return denied();
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
    const witness = attachTargetStagingWitness(db, files.directory,
        store.expectedRestoreGeneration, genesisHash);
    if (!witness) return denied();
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    transaction = true;
    db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    const pathsStillTrusted = (): boolean => files !== null && files.stillPinned() &&
      witness.stillAttached() && noTargetStagingSidecars(files.databasePath);
    if (!pathsStillTrusted()) return denied();

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
    const trustedTail = trustedTargetStagingTail(connection, journal, store.expectedRestoreGeneration,
      genesisHash, pinnedFiles.directoryFdPath);
    // Verdict first, on the complete lines: an untrusted store is never modified.
    if (!trustedTail || !pathsStillTrusted()) return denied();
    const { scan, anchor } = trustedTail;
    let state = scan.state;
    if (scan.torn) {
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
          appendTargetStagingConfirmIfTrusted(connection, journal, generation, genesisHash,
            pinnedFiles.directoryFdPath, n, pathsStillTrusted);
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
