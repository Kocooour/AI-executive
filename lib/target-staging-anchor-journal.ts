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
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, writeSync,
} from "node:fs";
import { readTargetStagingWitness } from "./target-staging-anchor-witness";
import type { TargetStagingWitnessJournalView } from "./target-staging-anchor-witness";

export const TARGET_STAGING_JOURNAL_FILENAME = "lumi-target.journal";
export const TARGET_STAGING_JOURNAL_GENESIS_PREV = "0".repeat(64);
/** Staging bound for full-chain verification per request (~250 B per record). */
export const TARGET_STAGING_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 2048;

export type TargetStagingJournalType = "genesis" | "intent" | "confirm" | "abort";
export type TargetStagingJournalKind =
  | "title" | "delete" | "membership" | "session_issue" | "session_revoke"
  | "session_revoke_all" | "compaction" | "restore" | "note_edit" | "note_delete"
  | "note_create" | "note_move" | "task_create" | "temporal_status" | "temporal_due_on" | "personal_when"
  | "personal_attention" | "personal_notification";
const KINDS = new Set<string>([
  "title", "delete", "membership", "session_issue", "session_revoke",
  "session_revoke_all", "compaction", "restore", "note_edit", "note_delete",
  "note_create", "note_move", "task_create", "temporal_status", "temporal_due_on", "personal_when",
  "personal_attention","personal_notification",
]);
export type TargetStagingJournalValue = string | number | null | readonly number[] | readonly (readonly string[])[];
export type TargetStagingJournalPayload = { readonly [key: string]: TargetStagingJournalValue };

export interface TargetStagingJournalRecord {
  /** Intent number (confirm/abort carry the number of the intent they resolve). */
  readonly n: number;
  readonly t: TargetStagingJournalType;
  readonly k: TargetStagingJournalKind | null;
  readonly p: TargetStagingJournalPayload | null;
  /**
   * restore_generation the record was written under. It changes ONLY at a `restore` intent (R2c.4b):
   * that intent, and its confirm/abort, carry the NEW generation; `p.previousGeneration` names the
   * generation in effect before it. After a confirm every record uses the new generation, after an
   * abort the previous one again. Any other change is a broken chain.
   */
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
  /** Generation in effect after the last RESOLVED record (a pending restore does not count yet). */
  readonly generation: string;
  readonly records: number;
  /** A trailing unresolved `restore` intent (its resolution carries `to`), else null. */
  readonly pendingRestore: { readonly n: number; readonly from: string; readonly to: string } | null;
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

/**
 * The same field rules the verifier applies, so a record the verifier would reject can never be
 * appended (an invalid line would turn the store journal_invalid for good).
 */
function validRecordShape(record: TargetStagingJournalRecord): boolean {
  const { n, t, k, p, g, prev } = record;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
      (t !== "genesis" && t !== "intent" && t !== "confirm" && t !== "abort") ||
      typeof g !== "string" || !UUID.test(g) || typeof prev !== "string" || !HEX64.test(prev) ||
      !validPayload(p)) return false;
  if (t === "intent") return n >= 1 && typeof k === "string" && KINDS.has(k) && p !== null && kindPayloadOk(k, p);
  if (t === "genesis") return n === 0 && k === null && p === null && prev === TARGET_STAGING_JOURNAL_GENESIS_PREV;
  return n >= 1 && k === null && p === null;
}

/** The complete line (with trailing newline) and its hash. */
export function serializeTargetStagingJournalLine(
  record: TargetStagingJournalRecord,
): { text: string; hash: string } {
  if (!validRecordShape(record)) throw new Error();
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
/** R2c.4b: operator --grant-admin decisions, readable as ID pairs; the cap keeps the line below MAX_LINE_BYTES. */
export const TARGET_STAGING_RESTORE_MAX_GRANTS = 16;
const GRANT_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
/** [[areaId, userId], ...] strictly ascending by (areaId, userId): sorted, no duplicate. */
const validGrantPairs = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length > TARGET_STAGING_RESTORE_MAX_GRANTS) return false;
  let before = "";
  for (const [index, pair] of value.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(id => typeof id === "string" && GRANT_ID.test(id))) return false;
    const key = `${pair[0]}\0${pair[1]}`;
    if (index > 0 && !(key > before)) return false;
    before = key;
  }
  return true;
};
const validPayload = (value: unknown): boolean => {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 8 && entries.every(([key, item]) =>
    key.length <= 32 && (key === "grantAdmin" ? validGrantPairs(item) : validValue(item)));
};
/** `grantAdmin` is a restore-only key, and every restore intent carries it. */
const kindPayloadOk = (k: unknown, p: unknown): boolean => {
  const has = p !== null && typeof p === "object" && Object.prototype.hasOwnProperty.call(p, "grantAdmin");
  return k === "restore" ? has : !has;
};

/** Chain-verification context; resumable (per-process prefix cache, see verifyTargetStagingJournalFd). */
interface VerifyContext {
  prev: string;
  records: number;
  lastIntent: number;
  confirmed: number;
  pending: number | null;
  status: Map<number, "pending" | "confirmed" | "aborted">;
  /** Validated intent hashes, including pending intents, for matching the durable witness. */
  intents: Map<number, string>;
  /** R2c.4b: generation in effect after the last resolved record. */
  gen: string;
  genesisHash: string;
  /** `g` of the genesis (0) and of every intent: the generation the witness row must carry. */
  gens: Map<number, string>;
  /** Intent number -> the generation a `restore` intent introduces. */
  restoreTo: Map<number, string>;
  /** Every generation ever in effect or introduced (lower case): a generation is never reused. */
  used: Set<string>;
  /** Number of the last CONFIRMED restore (0 = none). */
  lastRestore: number;
  pendingRestore: { n: number; from: string; to: string } | null;
}
const newContext = (): VerifyContext => ({
  prev: "", records: 0, lastIntent: 0, confirmed: 0, pending: null,
  status: new Map(), intents: new Map(), gen: "", genesisHash: "", gens: new Map(),
  restoreTo: new Map(), used: new Set(), lastRestore: 0, pendingRestore: null,
});
const cloneContext = (ctx: VerifyContext): VerifyContext => ({
  ...ctx, status: new Map(ctx.status), intents: new Map(ctx.intents), gens: new Map(ctx.gens),
  restoreTo: new Map(ctx.restoreTo), used: new Set(ctx.used),
  pendingRestore: ctx.pendingRestore === null ? null : { ...ctx.pendingRestore },
});

const lower = (value: string): string => value.toLowerCase();

/** Verify one complete line (without its newline) and advance the context; false = invalid. */
function verifyLine(raw: string, ctx: VerifyContext): boolean {
  if (raw.length === 0 || raw.length > MAX_LINE_BYTES) return false;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (Object.keys(parsed).sort().join(",") !== "g,h,k,n,p,prev,t") return false;
  const { n, t, k, p, g, prev: linkedPrev, h } = parsed as {
    n: unknown; t: unknown; k: unknown; p: unknown; g: unknown; prev: unknown; h: unknown };
  if (canonicalJournalJson(parsed) !== raw) return false;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
      (t !== "genesis" && t !== "intent" && t !== "confirm" && t !== "abort") ||
      typeof g !== "string" || !UUID.test(g) ||
      typeof linkedPrev !== "string" || !HEX64.test(linkedPrev) ||
      typeof h !== "string" || !HEX64.test(h) || !validPayload(p)) return false;
  const first = ctx.records === 0;
  if (first ? linkedPrev !== TARGET_STAGING_JOURNAL_GENESIS_PREV : linkedPrev !== ctx.prev) return false;
  const record = { n, t, k, p, g, prev: linkedPrev } as TargetStagingJournalRecord;
  if (chainHash(record) !== h) return false;
  if (t === "genesis") {
    if (!first || n !== 0 || k !== null || p !== null) return false;
    ctx.gen = g;
    ctx.genesisHash = h;
    ctx.gens.set(0, g);
    ctx.used.add(lower(g));
  } else {
    if (first) return false;
    if (t === "intent") {
      if (n !== ctx.lastIntent + 1 || typeof k !== "string" || !KINDS.has(k) || p === null ||
          !kindPayloadOk(k, p)) return false;
      // The previous intent must be resolved before the next one is appended.
      if (ctx.pending !== null) return false;
      if (k === "restore") {
        const payload = p as Record<string, unknown>;
        const { from, through, previousGeneration } = payload;
        // The ONLY place where the generation may change: it must name the generation in effect,
        // introduce a generation never used before, and replay exactly up to the highest confirmed
        // intent, starting at or after the previous restore (a backup older than it is refused).
        if (typeof previousGeneration !== "string" || lower(previousGeneration) !== lower(ctx.gen) ||
            lower(g) === lower(ctx.gen) || ctx.used.has(lower(g)) ||
            typeof from !== "number" || typeof through !== "number" ||
            !Number.isSafeInteger(from) || !Number.isSafeInteger(through) ||
            from < 0 || from >= through || through !== ctx.confirmed || from < ctx.lastRestore) return false;
        ctx.pendingRestore = { n, from: ctx.gen, to: g };
        ctx.restoreTo.set(n, g);
        ctx.used.add(lower(g));
      } else if (lower(g) !== lower(ctx.gen)) return false;
      ctx.lastIntent = n;
      ctx.pending = n;
      ctx.status.set(n, "pending");
      ctx.intents.set(n, h);
      ctx.gens.set(n, g);
    } else {
      if (k !== null || p !== null) return false;
      const status = ctx.status.get(n);
      // A restore resolution carries the NEW generation (also an abort); everything else the
      // generation in effect now.
      const restoredTo = ctx.restoreTo.get(n);
      if (lower(g) !== lower(restoredTo ?? ctx.gen)) return false;
      if (t === "abort") {
        if (status !== "pending") return false;
        ctx.status.set(n, "aborted");
        if (ctx.pendingRestore !== null && ctx.pendingRestore.n === n) ctx.pendingRestore = null;
      } else {
        if (status !== "pending" && status !== "confirmed") return false;
        ctx.status.set(n, "confirmed");
        if (n > ctx.confirmed) ctx.confirmed = n;
        if (ctx.pendingRestore !== null && ctx.pendingRestore.n === n) {
          ctx.gen = ctx.pendingRestore.to;
          ctx.lastRestore = n;
          ctx.pendingRestore = null;
        }
      }
      if (ctx.pending === n) ctx.pending = null;
    }
  }
  ctx.prev = h;
  ctx.records += 1;
  return true;
}

const stateOf = (ctx: VerifyContext): TargetStagingJournalState => ({
  lastIntent: ctx.lastIntent, confirmed: ctx.confirmed, pending: ctx.pending,
  lastHash: ctx.prev, generation: ctx.gen, records: ctx.records,
  pendingRestore: ctx.pendingRestore === null ? null : { ...ctx.pendingRestore },
});

/**
 * The configured generation must be the one in effect, or the one a trailing UNRESOLVED restore
 * introduces (its commit changed the DB metadata; the DB metadata check ties the choice to the
 * store). Anything else, in particular a genesis of another store, is not this store's journal.
 */
const acceptsGeneration = (ctx: VerifyContext, expected: string): boolean =>
  UUID.test(expected) && ctx.records > 0 && (lower(expected) === lower(ctx.gen) ||
    (ctx.pendingRestore !== null && lower(expected) === lower(ctx.pendingRestore.to)));

export interface TargetStagingJournalScan {
  readonly state: TargetStagingJournalState;
  /** Byte length of the terminated (complete) part of the file. */
  readonly completeBytes: number;
  /** An unterminated trailing fragment follows (a writer's append in flight or torn). */
  readonly torn: boolean;
  /** Hashes from verified intent records (the witness must match each committed one). */
  readonly intentHashes: ReadonlyMap<number, string>;
  /** The final verified state of each journal intent (abort does not commit). */
  readonly intentStatuses: ReadonlyMap<number, "pending" | "confirmed" | "aborted">;
  /** Hash of the genesis record (the witness row 0 must carry it). */
  readonly genesisHash: string;
  /** Generation of the genesis (0) and of every intent record, for the witness rows. */
  readonly generations: ReadonlyMap<number, string>;
}

/**
 * Verify `buffer` (the file from byte `base`, or all of it) line by line, continuing `ctx`.
 * ONLY an unterminated fragment after the last newline is tolerated, and only when it is a
 * (possibly cut-off) line: it does not parse as JSON, or parses to exactly its canonical text
 * (just the newline missing). A parseable but non-canonical fragment is invalid. Every
 * terminated line must be canonical and chained. Returns the bytes consumed or null.
 */
function scanBuffer(
  buffer: Buffer, ctx: VerifyContext,
): { completeBytes: number; torn: boolean; lastLineStart: number } | null {
  const lastNewline = buffer.lastIndexOf(10);
  const complete = lastNewline + 1;
  let lastLineStart = 0;
  if (complete > 0) {
    const lines = buffer.subarray(0, complete).toString("utf8").slice(0, -1).split("\n");
    let offset = 0;
    for (const line of lines) {
      lastLineStart = offset;
      if (!verifyLine(line, ctx)) return null;
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
  }
  const rest = buffer.subarray(complete);
  let torn = false;
  if (rest.length > 0) {
    if (rest.length > MAX_LINE_BYTES) return null;
    const fragment = rest.toString("utf8");
    let parsed: unknown;
    let parses = true;
    try { parsed = JSON.parse(fragment); } catch { parses = false; }
    if (parses && canonicalJournalJson(parsed) !== fragment) return null;
    torn = true;
  }
  return { completeBytes: complete, torn, lastLineStart };
}

/**
 * Verify the whole chain and derive the state, or null when ANYTHING is wrong:
 * unparsable or non-canonical line, hash or prev mismatch, wrong shape, non-consecutive
 * intent numbers, a resolution which does not match an intent, an intent appended while the
 * previous one is still unresolved, or a generation which differs from `generation`.
 * An unterminated trailing fragment is ignored (see scanBuffer).
 *
 * A `confirm` may repeat or arrive late (two processes may race to confirm the same
 * committed intent; both are true statements), but never for an aborted intent, and
 * an `abort` only for a still unresolved intent.
 */
export function verifyTargetStagingJournal(
  text: string, generation: string,
): TargetStagingJournalState | null {
  try {
    if (typeof text !== "string" || !UUID.test(generation)) return null;
    const ctx = newContext();
    const scanned = scanBuffer(Buffer.from(text, "utf8"), ctx);
    return scanned && acceptsGeneration(ctx, generation) ? stateOf(ctx) : null;
  } catch { return null; }
}

/**
 * Identify a journal WITHOUT knowing the configured generation (operator diagnosis only): the chain
 * must verify on its own. Returns the generation in effect, the one a trailing unresolved restore
 * introduces (or null) and every generation the journal ever used (lower case).
 */
export function describeTargetStagingJournalGenerations(
  text: string,
): { inEffect: string; pendingTo: string | null; used: ReadonlySet<string> } | null {
  try {
    if (typeof text !== "string") return null;
    const ctx = newContext();
    const scanned = scanBuffer(Buffer.from(text, "utf8"), ctx);
    if (!scanned || ctx.records === 0) return null;
    return { inEffect: ctx.gen, pendingTo: ctx.pendingRestore ? ctx.pendingRestore.to : null, used: new Set(ctx.used) };
  } catch { return null; }
}

/**
 * Per-process verified-prefix cache keyed by (dev, ino): the context after the last
 * terminated line, its byte end and start. A later check requires size >= the cached end,
 * re-reads and re-verifies the cached last line at the boundary (it must still hash to the
 * cached value) and verifies only the appended bytes. Any mismatch, shrink or inode change
 * drops the entry and falls back to a FULL verification, so the verdict stays fail-closed.
 * Trade-off: an in-place edit of an EARLIER line is not noticed by a process which already
 * verified it; a fresh process (restart) always verifies the full chain once.
 */
interface CachedPrefix { end: number; lastLineStart: number; ctx: VerifyContext }
const prefixCache = new Map<string, CachedPrefix>();
const PREFIX_CACHE_MAX = 16;

/**
 * Read up to `size` bytes from `start`; stops at EOF and returns the bytes actually read. A
 * writer may truncate a torn fragment (only the unterminated tail can shrink) between our fstat
 * and this read, which must not look like corruption: the complete lines stay intact.
 */
export function readTargetStagingJournalRange(fd: number, start: number, size: number): Buffer | null {
  const buffer = Buffer.alloc(Math.max(0, size - start));
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
    if (read < 0) return null;
    if (read === 0) break;
    offset += read;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}
const readRange = readTargetStagingJournalRange;

/**
 * Verify (and cache) the journal prefix WITHOUT holding any SQLite lock. Every request runs in a
 * fresh child process with an empty cache; doing the full verification inside RESERVED/SHARED would
 * hold the lock for the whole chain (hundreds of ms at 20 000 writes). The in-lock check then only
 * re-verifies the boundary line and the appended bytes, with the same verdict rules. Best effort.
 */
export function warmTargetStagingJournal(directoryRoot: string, generation: string): void {
  const fd = openTargetStagingJournal(directoryRoot, false);
  if (fd === null) return;
  try {
    const scanned = scanTargetStagingJournalFd(fd, generation);
    if (scanned) {
      // Cold validation of the witness is done outside the SQLite main lock.
      // Under the actual read/write lock the witness can then verify the
      // unchanged prefix plus any newly committed suffix incrementally.
      readTargetStagingWitness(directoryRoot, generation, witnessViewOf(scanned));
    }
  } finally {
    try { closeSync(fd); } catch { /* fail closed */ }
  }
}

/** What the witness needs from a verified journal to check its rows (R2c.4b: generations may change). */
export function witnessViewOf(scan: TargetStagingJournalScan): TargetStagingWitnessJournalView {
  return {
    genesisHash: scan.genesisHash, generations: scan.generations,
    intents: scan.intentHashes, statuses: scan.intentStatuses,
  };
}

/** A fresh process starts empty; tests call this to simulate a restart. */
export function clearTargetStagingJournalCache(): void { prefixCache.clear(); }

export function scanTargetStagingJournalFd(fd: number, generation: string): TargetStagingJournalScan | null {
  try {
    if (!UUID.test(generation)) return null;
    const info = fstatSync(fd);
    const size = info.size;
    if (size === 0 || size > TARGET_STAGING_JOURNAL_MAX_BYTES) return null;
    const key = info.dev + ":" + info.ino;
    const cached = prefixCache.get(key);
    const result = (ctx: VerifyContext, completeBytes: number, torn: boolean): TargetStagingJournalScan | null =>
      acceptsGeneration(ctx, generation) ? {
        state: stateOf(ctx), completeBytes, torn, intentHashes: ctx.intents, intentStatuses: ctx.status,
        genesisHash: ctx.genesisHash, generations: ctx.gens,
      } : null;
    if (cached && size >= cached.end) {
      const tail = readRange(fd, cached.lastLineStart, size);
      const boundary = tail === null ? -1 : tail.indexOf(10);
      if (tail !== null && boundary >= 0 && cached.lastLineStart + boundary + 1 === cached.end) {
        // Re-verify the cached last line (content must still hash to the cached chain value).
        const lineText = tail.subarray(0, boundary).toString("utf8");
        let sameLine = false;
        try {
          const { h, ...record } = JSON.parse(lineText) as Record<string, unknown>;
          sameLine = canonicalJournalJson({ ...record, h }) === lineText && h === cached.ctx.prev &&
            chainHash(record as unknown as TargetStagingJournalRecord) === h;
        } catch { sameLine = false; }
        if (sameLine) {
          const appended = tail.subarray(boundary + 1);
          // Copy the context only when something was appended (it is mutated by the scan).
          const ctx: VerifyContext = appended.length === 0 ? cached.ctx : cloneContext(cached.ctx);
          const scanned = scanBuffer(appended, ctx);
          if (scanned) {
            const end = cached.end + scanned.completeBytes;
            if (scanned.completeBytes > 0) {
              prefixCache.set(key, { end, ctx, lastLineStart: cached.end + scanned.lastLineStart });
            }
            return result(ctx, end, scanned.torn);
          }
        }
      }
    }
    prefixCache.delete(key);
    const buffer = readRange(fd, 0, size);
    if (buffer === null) return null;
    const ctx = newContext();
    const scanned = scanBuffer(buffer, ctx);
    if (!scanned || ctx.records === 0) return null;
    if (prefixCache.size >= PREFIX_CACHE_MAX) prefixCache.clear();
    prefixCache.set(key, { end: scanned.completeBytes, ctx, lastLineStart: scanned.lastLineStart });
    return result(ctx, scanned.completeBytes, scanned.torn);
  } catch { return null; }
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
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined || !process.getuid) return null;
  let fd: number | null = null;
  try {
    const target = directoryRoot + "/" + TARGET_STAGING_JOURNAL_FILENAME;
    // lstat first, and O_NONBLOCK below: a FIFO (or device) planted at the path must be refused,
    // never block the event loop of the pre-auth gate waiting for a peer.
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = openSync(target, (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) |
      constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() ||
        info.dev !== before.dev || info.ino !== before.ino ||
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

/** A confirmed intent of the kinds a restore replays or reasons about (R2c.4b). */
export interface TargetStagingJournalFact {
  readonly n: number;
  readonly k: TargetStagingJournalKind;
  readonly p: TargetStagingJournalPayload;
}
const FACT_KINDS = new Set<string>([
  "membership", "session_issue", "session_revoke", "session_revoke_all",
  "restore", "note_delete",
]);

/**
 * Restore-only, under the SQLite write lock, AFTER the chain was verified (and a torn fragment cut):
 * the confirmed intents of the security kinds, in journal order. `statuses` is the final resolution of
 * every intent. Returns null when the file cannot be read as complete lines.
 */
export function readTargetStagingJournalFacts(
  fd: number, statuses: ReadonlyMap<number, "pending" | "confirmed" | "aborted">,
): TargetStagingJournalFact[] | null {
  const text = readTargetStagingJournalText(fd);
  if (text === null || !text.endsWith("\n")) return null;
  try {
    const facts: TargetStagingJournalFact[] = [];
    for (const line of text.slice(0, -1).split("\n")) {
      const record = JSON.parse(line) as TargetStagingJournalRecord;
      if (record.t !== "intent" || statuses.get(record.n) !== "confirmed" || record.k === null ||
          !FACT_KINDS.has(record.k) || record.p === null) continue;
      facts.push({ n: record.n, k: record.k, p: record.p });
    }
    return facts;
  } catch { return null; }
}

/**
 * Writer-only, under the SQLite write lock: cut a torn trailing fragment back to the last newline
 * (fsync). Safe: an intent is fully fsynced before its COMMIT, so a fragment is always an
 * unfinished intent (DB not committed) or an unfinished confirm (resolved again from anchor == n).
 */
export function truncateTargetStagingJournal(fd: number, bytes: number): void {
  ftruncateSync(fd, bytes);
  fsyncSync(fd);
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
    const scan = scanTargetStagingJournalFd(fd, generation);
    const anchor = parseTargetStagingAnchor(anchorRaw);
    if (!scan || anchor === null) return "journal_invalid";
    // The witness is committed atomically with the main DB (SQLite super-journal).
    // In particular it distinguishes a genuine pre-COMMIT crash (witness stays
    // at the old n) from an older DB restored after COMMIT without JSONL confirm.
    const witnessed = readTargetStagingWitness(directoryRoot, generation, witnessViewOf(scan));
    if (witnessed === null) return "journal_invalid";
    if (anchor < witnessed) return "restore_pending";
    if (anchor > witnessed) return "journal_invalid";
    return evaluateTargetStagingAnchor(scan.state, anchor);
  } finally {
    try { closeSync(fd); } catch { /* fail closed */ }
  }
}
