/**
 * Global owner-cookie cutoff. Separate from target-staging durable sessions.
 * Reads never bootstrap a missing marker. Only a successful password/passkey
 * login initializes it. Invalid/missing state always fails authentication closed.
 *
 * Issuance and logout share a cross-process mkdir lock; a stale lock is an
 * operational error requiring manual intervention, never automatically stolen.
 * Cutoff writes use fsync + atomic rename + directory fsync.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmdirSync, unlinkSync, writeSync, constants,
} from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "./data-dir";

const STATE_NAME = "owner-session-valid-from.json";
const LOCK_NAME = ".owner-session-valid-from.lock";
const pauseWord = new Int32Array(new SharedArrayBuffer(4));

function paths() {
  const directory = resolveDataDirectory();
  return { directory, state: path.join(directory, STATE_NAME), lock: path.join(directory, LOCK_NAME) };
}

/** A null result means ENOENT only; any malformed/unreadable state throws. */
function readCutoff(file: string): number | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0 ||
        stats.size < 1 || stats.size > 128) {
      throw new Error("Owner-session revocation state is invalid");
    }
    let data: unknown;
    try { data = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error("Owner-session revocation state is corrupt"); }
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).length !== 2 ||
        (data as { version?: unknown }).version !== 1 ||
        !Number.isSafeInteger((data as { validFromMs?: unknown }).validFromMs) ||
        (data as { validFromMs: number }).validFromMs < 0) {
      throw new Error("Owner-session revocation state is corrupt");
    }
    return (data as { validFromMs: number }).validFromMs;
  } finally { closeSync(fd); }
}

function publishCutoff(directory: string, state: string, validFromMs: number) {
  const temporary = path.join(directory, `.owner-session-${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const value = Buffer.from(JSON.stringify({ version: 1, validFromMs }) + "\n");
    let offset = 0;
    while (offset < value.length) {
      const written = writeSync(fd, value, offset, value.length - offset);
      if (written <= 0) throw new Error("Owner-session revocation write failed");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, state);
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function withWriterLock<T>(operation: (directory: string, state: string) => T): T {
  const { directory, state, lock } = paths();
  // Only writes (login/logout) may create a missing data directory.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Atomics.wait(pauseWord, 0, 0, 5);
    }
  }
  if (!acquired) throw new Error("Owner-session revocation lock unavailable");
  try { return operation(directory, state); }
  finally { rmdirSync(lock); }
}

/** Strict, live disk read for every authenticated request. Never self-heals. */
export function ownerSessionIssuedAtIsValid(issuedAtMs: unknown, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(issuedAtMs) || (issuedAtMs as number) <= 0 ||
      (issuedAtMs as number) > nowMs) return false;
  try {
    const cutoff = readCutoff(paths().state);
    return cutoff !== null && (issuedAtMs as number) > cutoff;
  } catch { return false; }
}

/** Only call after validating password or a WebAuthn assertion. */
export function issueOwnerSessionIssuedAt(): number {
  return withWriterLock((directory, state) => {
    let cutoff = readCutoff(state);
    if (cutoff === null) {
      cutoff = Date.now();
      publishCutoff(directory, state, cutoff);
    }
    // A logout can advance cutoff within the same millisecond. Never mint a
    // future issuedAt; otherwise an older token could survive a later logout.
    for (let attempt = 0; attempt < 200; attempt++) {
      const issuedAt = Date.now();
      if (issuedAt > cutoff) return issuedAt;
      Atomics.wait(pauseWord, 0, 0, 1);
    }
    throw new Error("Owner-session clock is behind the revocation cutoff");
  });
}

/** Invalidate every already-issued owner cookie, across all server processes. */
export function revokeAllOwnerSessions(): void {
  withWriterLock((directory, state) => {
    const previous = readCutoff(state);
    if (previous === null) throw new Error("Owner-session revocation state missing");
    const next = Math.max(Date.now(), previous + 1);
    if (!Number.isSafeInteger(next)) throw new Error("Owner-session revocation overflow");
    publishCutoff(directory, state, next);
  });
}
