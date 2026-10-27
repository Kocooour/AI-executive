/**
 * One-use read-only copy of an already opened staging SQLite database.
 *
 * Node 22's SQLite API cannot adopt an existing file descriptor. In
 * particular, passing /proc/self/fd/N to SQLite is NOT a pinned open: SQLite
 * may resolve and reopen its original pathname. Instead, read exclusively
 * through the verified source fd and open the copy under a newly created,
 * process-private directory. On Linux copies live on private tmpfs; all
 * platforms use a controlled per-user root with stale-process cleanup.
 * No SQLite connection ever opens the staging path.
 *
 * Staging-only: a copy is deliberately more expensive than ordinary reads.
 * Replace this with a proven fd-backed VFS before enabling production reads.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readSync, rmSync, statfsSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { TARGET_STORE_FILENAME, verifyTargetStagingPath } from "./target-store-bootstrap";

const CHUNK_BYTES = 64 * 1024;
/** Fail closed on unexpectedly large files rather than exhaust staging disk. */
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const TMPFS_MAGIC = 0x01021994;
const SNAPSHOT_ROOT = "lumi-r2-target-read-snapshots-v1";
const SNAPSHOT_NAME = /^snapshot-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function currentUid(): number {
  if (!process.getuid) throw new Error("Cannot establish snapshot directory ownership");
  return process.getuid();
}

/**
 * Linux copies must reside on memory-backed tmpfs, not persistent /tmp.
 * macOS uses its OS-managed temp directory, but always beneath a private root.
 * This is a staging-only read path: if tmpfs is unavailable or too small,
 * refusing the request is preferable to leaving sensitive copies on disk.
 */
export function targetReadSnapshotRoot(): string {
  const base = process.platform === "linux" ? "/dev/shm" : os.tmpdir();
  if (process.platform === "linux" && statfsSync(base).type !== TMPFS_MAGIC) {
    throw new Error("Staging snapshot requires Linux tmpfs");
  }
  return path.join(base, SNAPSHOT_ROOT + "-" + currentUid());
}

function ensurePrivateSnapshotRoot(): string {
  const root = targetReadSnapshotRoot();
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
    throw new Error("Unsafe staging snapshot root");
  }
  return root;
}

function processIsAlive(pid: number): boolean {
  // EPERM or any unexpected error must conservatively mean 'alive'.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Run on every staging snapshot request, including after a process restart.
 * Only remove strictly named, owned 0700 directories of DEAD processes.
 * Live snapshots owned by this or another process are never removed.
 * Malformed names, symlinks and unknown files are never followed/deleted.
 *
 * A crash or SIGKILL bypasses finally; the next staging request reclaims the
 * orphan. PID reuse can at worst delay cleanup, never remove a live snapshot.
 */
export function cleanupOrphanedTargetReadSnapshots(): number {
  const root = ensurePrivateSnapshotRoot();
  let removed = 0;
  for (const name of readdirSync(root)) {
    const match = SNAPSHOT_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || processIsAlive(pid)) continue;
    const candidate = path.join(root, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() ||
        info.uid !== currentUid() || (info.mode & 0o077) !== 0) continue;
    rmSync(candidate, { recursive: true, force: true });
    removed++;
  }
  return removed;
}


function unchanged(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * The callback runs after the source bytes have been copied, but before the
 * private snapshot is removed. Both snapshot path and descriptor are provided
 * so the canonical preflight can prove it inspected the same file.
 */
export function withPinnedTargetSnapshot<T>(
  sourceFd: number,
  useSnapshot: (directory: string, snapshotFd: number, revision: string) => T,
): T {
  const source = fstatSync(sourceFd);
  if (!source.isFile() || source.nlink !== 1 || source.size < 100 ||
      source.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("Unsafe staging source file");
  }
  const header = Buffer.alloc(20);
  if (readSync(sourceFd, header, 0, header.length, 0) !== header.length ||
      header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
      header[18] !== 1 || header[19] !== 1) {
    throw new Error("Unsupported staging SQLite journal mode");
  }

  // Verify isolation BEFORE creating any temporary directory. mkdirSync fails
  // if another process created the unpredictable directory in the meantime.
  // A new process reclaims directories orphaned by SIGKILL/crashes. A live
  // process always retains its own directories while SQLite may read them.
  cleanupOrphanedTargetReadSnapshots();
  const directory = verifyTargetStagingPath(
    path.join(targetReadSnapshotRoot(), `snapshot-${process.pid}-${randomUUID()}`),
  );
  mkdirSync(directory, { mode: 0o700 });
  let writeFd: number | undefined;
  let snapshotFd: number | undefined;
  try {
    const filename = path.join(directory, TARGET_STORE_FILENAME);
    if (constants.O_NOFOLLOW === undefined) throw new Error("Missing O_NOFOLLOW");
    writeFd = openSync(filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    // Hash the exact copied bytes to identify the snapshot across page requests.
    // Every page re-opens and preflights the live staging store independently.
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < source.size) {
      const length = Math.min(buffer.length, source.size - position);
      const bytesRead = readSync(sourceFd, buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error("Staging source changed during copy");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(writeFd, buffer, written, bytesRead - written, position + written);
        if (count <= 0) throw new Error("Could not copy staging data");
        written += count;
      }
      position += bytesRead;
    }
    if (!unchanged(source, fstatSync(sourceFd))) {
      throw new Error("Staging source changed during copy");
    }

    closeSync(writeFd);
    writeFd = undefined;
    snapshotFd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const snapshotInfo = fstatSync(snapshotFd);
    if (!snapshotInfo.isFile() || snapshotInfo.size !== source.size) {
      throw new Error("Invalid snapshot file");
    }
    return useSnapshot(directory, snapshotFd, hash.digest("hex"));
  } finally {
    if (snapshotFd !== undefined) closeSync(snapshotFd);
    if (writeFd !== undefined) closeSync(writeFd);
    rmSync(directory, { recursive: true, force: true });
  }
}
