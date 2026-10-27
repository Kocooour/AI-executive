/**
 * One-use read-only copy of an already opened staging SQLite database.
 *
 * Node 22's SQLite API cannot adopt an existing file descriptor. In
 * particular, passing /proc/self/fd/N to SQLite is NOT a pinned open: SQLite
 * may resolve and reopen its original pathname. Instead, read exclusively
 * through the verified source fd and open the copy under a newly created,
 * process-private directory. No SQLite connection ever opens the staging path.
 *
 * Staging-only: a copy is deliberately more expensive than ordinary reads.
 * Replace this with a proven fd-backed VFS before enabling production reads.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { TARGET_STORE_FILENAME, verifyTargetStagingPath } from "./target-store-bootstrap";

const CHUNK_BYTES = 64 * 1024;
/** Fail closed on unexpectedly large files rather than exhaust staging disk. */
const MAX_SNAPSHOT_BYTES = 1024n * 1024n * 1024n;

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
  useSnapshot: (directory: string, snapshotFd: number) => T,
): T {
  const source = fstatSync(sourceFd);
  if (!source.isFile() || source.nlink !== 1 || source.size < 100 ||
      BigInt(source.size) > MAX_SNAPSHOT_BYTES) {
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
  const directory = verifyTargetStagingPath(
    path.join(os.tmpdir(), `lumi-r2-read-${randomUUID()}`),
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
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < source.size) {
      const length = Math.min(buffer.length, source.size - position);
      const bytesRead = readSync(sourceFd, buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error("Staging source changed during copy");
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
    return useSnapshot(directory, snapshotFd);
  } finally {
    if (snapshotFd !== undefined) closeSync(snapshotFd);
    if (writeFd !== undefined) closeSync(writeFd);
    rmSync(directory, { recursive: true, force: true });
  }
}
