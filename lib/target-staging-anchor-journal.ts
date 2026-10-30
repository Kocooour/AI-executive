/**
 * R2c.4a staging-only irreversible journal ("anti-rollback anchor"). Mechanism
 * proposed for owner approval, see docs/ARCHITECTURE.md (R2c.4a).
 *
 * `lumi-target.journal` sits next to the SQLite file. It is an append-only
 * JSON-lines hash chain whose records are content-free. Every committed staging
 * write is bracketed by an `intent` record (fsynced BEFORE the SQLite COMMIT) and
 * a `confirm` record (after it); the DB metadata key `anchor_seq` carries the
 * intent number in the same transaction. A DB which was replaced by an older copy
 * therefore shows `anchor_seq` BELOW the highest confirmed journal number.
 *
 * This module is pure (no SQLite): format, hash chain, verification and the
 * detection rules. File I/O lives in the pinned helpers and the bootstrap.
 *
 * Limitation (documented, not detectable): restoring the WHOLE staging directory
 * or a host snapshot rolls back the journal together with the DB.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync,
} from "node:fs";

export const TARGET_STAGING_JOURNAL_FILENAME = "lumi-target.journal";
export const TARGET_STAGING_JOURNAL_GENESIS_PREV = "0".repeat(64);
/** Staging bound for full-chain verification per request (~250 B per record). */
export const TARGET_STAGING_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 2048;

export type TargetStagingJournalType = "genesis" | "intent" | "confirm" | "abort";
export type TargetStagingJournalKind =
  | "title" | "delete" | "membership" | "session_issue" | "session_revoke"
  | "session_revoke_all" | "compaction";
const KINDS = new Set<string>([
  "title", "delete", "membership", "session_issue", "session_revoke",
  "session_revoke_all", "compaction",
]);
export type TargetStagingJournalValue = string | number | null | readonly number[];
export type TargetStagingJournalPayload = { readonly [key: string]: TargetStagingJournalValue };

export interface TargetStagingJournalRecord {
  /** Intent number (confirm/abort carry the number of the intent they resolve). */
  readonly n: number;
  readonly t: TargetStagingJournalType;
  readonly k: TargetStagingJournalKind | null;
  readonly p: TargetStagingJournalPayload | null;
  /** restore_generation the record was written under (R2c.4b extends this). */
  readonly g: string;
  readonly prev: string;
}
export interface TargetStagingJournalLine extends TargetStagingJournalRecord { readonly h: string }

/** Verified chain summary. */
export interface TargetStagingJournalState {
  /** Highest intent number ever appended (0 = genesis only). */
  readonly lastIntent: number;
  /** Highest confirmed number; genesis counts as confirmed 0. */
  readonly confirmed: number;
  /** Trailing intent without confirm/abort (crashed or in-flight write), else null. */
  readonly pending: number | null;
  readonly lastHash: string;
  readonly generation: string;
  readonly records: number;
}

export type TargetStagingAnchorVerdict = "ok" | "restore_pending" | "journal_invalid";
export type TargetStagingJournalResolution =
  | { readonly action: "none" } | { readonly action: "confirm" | "abort"; readonly n: number };

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,14})$/;

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJournalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error();
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJournalJson).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort()
      .map(key => JSON.stringify(key) + ":" + canonicalJournalJson(record[key])).join(",") + "}";
  }
  throw new Error();
}

const chainHash = (record: TargetStagingJournalRecord): string =>
  createHash("sha256").update(record.prev + canonicalJournalJson(record)).digest("hex");

/** The complete line (with trailing newline) and its hash. */
export function serializeTargetStagingJournalLine(
  record: TargetStagingJournalRecord,
): { text: string; hash: string } {
  const hash = chainHash(record);
  const text = canonicalJournalJson({ ...record, h: hash }) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) throw new Error();
  return { text, hash };
}

export function targetStagingJournalGenesis(generation: string): { text: string; hash: string } {
  return serializeTargetStagingJournalLine({
    n: 0, t: "genesis", k: null, p: null, g: generation, prev: TARGET_STAGING_JOURNAL_GENESIS_PREV,
  });
}

const validValue = (value: unknown): boolean =>
  value === null || (typeof value === "string" && value.length <= 256) ||
  (typeof value === "number" && Number.isSafeInteger(value)) ||
  (Array.isArray(value) && value.length <= 4 && value.every(item => Number.isSafeInteger(item)));
const validPayload = (value: unknown): boolean => {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 8 && entries.every(([key, item]) => key.length <= 32 && validValue(item));
};

/**
 * Verify the whole chain and derive the state, or null when ANYTHING is wrong:
 * unparsable or non-canonical line, missing final newline (truncation), hash or
 * prev mismatch, wrong shape, non-consecutive intent numbers, a resolution which
 * does not match an intent, an intent appended while the previous one is still
 * unresolved, or a generation which differs from `generation`.
 *
 * A `confirm` may repeat or arrive late (two processes may race to confirm the same
 * committed intent; both are true statements), but never for an aborted intent, and
 * an `abort` only for a still unresolved intent.
 */
export function verifyTargetStagingJournal(
  text: string, generation: string,
): TargetStagingJournalState | null {
  try {
    if (typeof text !== "string" || text.length === 0 || !text.endsWith("\n") ||
        !UUID.test(generation)) return null;
    const lines = text.slice(0, -1).split("\n");
    let prev = "";
    let lastIntent = 0;
    let confirmed = 0;
    let pending: number | null = null;
    const state = new Map<number, "pending" | "confirmed" | "aborted">();
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (raw.length === 0 || raw.length > MAX_LINE_BYTES) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (Object.keys(parsed).sort().join(",") !== "g,h,k,n,p,prev,t") return null;
      const { n, t, k, p, g, prev: linkedPrev, h } = parsed as {
        n: unknown; t: unknown; k: unknown; p: unknown; g: unknown; prev: unknown; h: unknown };
      if (canonicalJournalJson(parsed) !== raw) return null;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
          (t !== "genesis" && t !== "intent" && t !== "confirm" && t !== "abort") ||
          typeof g !== "string" || !UUID.test(g) || g.toLowerCase() !== generation.toLowerCase() ||
          typeof linkedPrev !== "string" || !HEX64.test(linkedPrev) ||
          typeof h !== "string" || !HEX64.test(h) || !validPayload(p)) return null;
      if (index === 0 ? linkedPrev !== TARGET_STAGING_JOURNAL_GENESIS_PREV : linkedPrev !== prev) return null;
      const record = { n, t, k, p, g, prev: linkedPrev } as TargetStagingJournalRecord;
      if (chainHash(record) !== h) return null;
      prev = h;
      if (t === "genesis") {
        if (index !== 0 || n !== 0 || k !== null || p !== null) return null;
        continue;
      }
      if (index === 0) return null;
      if (t === "intent") {
        if (n !== lastIntent + 1 || typeof k !== "string" || !KINDS.has(k) || p === null) return null;
        // The previous intent must be resolved before the next one is appended.
        if (pending !== null) return null;
        lastIntent = n;
        pending = n;
        state.set(n, "pending");
      } else {
        if (k !== null || p !== null) return null;
        const status = state.get(n);
        if (t === "abort") {
          if (status !== "pending") return null;
          state.set(n, "aborted");
        } else {
          if (status !== "pending" && status !== "confirmed") return null;
          state.set(n, "confirmed");
          if (n > confirmed) confirmed = n;
        }
        if (pending === n) pending = null;
      }
    }
    if (lines.length === 0) return null;
    // A late duplicate confirm can never re-open a resolved tail.
    return { lastIntent, confirmed, pending, lastHash: prev, generation, records: lines.length };
  } catch {
    return null;
  }
}

/** Canonical decimal anchor, or null when absent or malformed. */
export function parseTargetStagingAnchor(raw: unknown): number | null {
  return typeof raw === "string" && CANONICAL_DECIMAL.test(raw) ? Number(raw) : null;
}

/**
 * Detection rule. `anchor` is the DB `anchor_seq`, read under the SAME SQLite lock
 * (writer transaction or SHARED snapshot) as the journal: no commit can interleave
 * between the two reads, so there is no tolerance window other than the one stated.
 *   anchor < confirmed                                -> restore_pending (DB older than the journal)
 *   anchor == confirmed                               -> ok
 *   anchor == trailing unconfirmed intent             -> ok (committed, confirm not written yet:
 *                                                       crash after COMMIT or another process mid-confirm)
 *   anything else above confirmed (incl. > lastIntent) -> journal_invalid
 * An unconfirmed trailing intent whose number is above the anchor is a write in
 * flight on another process (it holds the write lock) or a crash before COMMIT:
 * also ok; the next writer resolves it.
 */
export function evaluateTargetStagingAnchor(
  state: TargetStagingJournalState | null, anchor: number | null,
): TargetStagingAnchorVerdict {
  if (!state || anchor === null) return "journal_invalid";
  if (anchor < state.confirmed) return "restore_pending";
  if (anchor === state.confirmed) return "ok";
  if (anchor > state.lastIntent) return "journal_invalid";
  return state.pending !== null && anchor === state.pending ? "ok" : "journal_invalid";
}

/** What a writer holding the write lock must append before its own intent. */
export function resolveTargetStagingJournalTail(
  state: TargetStagingJournalState, anchor: number,
): TargetStagingJournalResolution {
  if (state.pending === null) return { action: "none" };
  return { action: anchor === state.pending ? "confirm" : "abort", n: state.pending };
}

/**
 * Open the journal below an already verified directory path or `/proc|/dev/fd/N`
 * root, never through a symlink. The file must be a regular file with a single link,
 * owned by this uid, mode exactly 0600. Returns the fd (caller closes) or null.
 */
export function openTargetStagingJournal(directoryRoot: string, writable: boolean): number | null {
  if (constants.O_NOFOLLOW === undefined || !process.getuid) return null;
  let fd: number | null = null;
  try {
    fd = openSync(directoryRoot + "/" + TARGET_STAGING_JOURNAL_FILENAME,
      (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o600 || info.size > TARGET_STAGING_JOURNAL_MAX_BYTES) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch { /* fail closed */ } }
    return null;
  }
}

export function readTargetStagingJournalText(fd: number): string | null {
  try {
    const size = fstatSync(fd).size;
    if (size === 0 || size > TARGET_STAGING_JOURNAL_MAX_BYTES) return null;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    return buffer.toString("utf8");
  } catch { return null; }
}

/** Append one line (O_APPEND fd) and fsync; throws on any failure. */
export function appendTargetStagingJournalLine(fd: number, text: string): void {
  const data = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error();
    offset += written;
  }
  fsyncSync(fd);
}

/**
 * Read-side convenience: verify the journal under `directoryRoot` against `anchor`
 * (raw metadata value) and `generation`. The caller must hold a SQLite lock under
 * which `anchor` was read (see evaluateTargetStagingAnchor). Strictly read-only:
 * only a holder of the SQLite write lock may append (see the pinned writer), because
 * the hash chain is linear and an append must be computed from the tail it reads.
 */
export function checkTargetStagingJournal(
  directoryRoot: string, anchorRaw: unknown, generation: string,
): TargetStagingAnchorVerdict {
  const fd = openTargetStagingJournal(directoryRoot, false);
  if (fd === null) return "journal_invalid";
  try {
    const text = readTargetStagingJournalText(fd);
    const state = text === null ? null : verifyTargetStagingJournal(text, generation);
    return evaluateTargetStagingAnchor(state, parseTargetStagingAnchor(anchorRaw));
  } finally {
    try { closeSync(fd); } catch { /* fail closed */ }
  }
}
