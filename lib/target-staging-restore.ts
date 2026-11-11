/**
 * R2c.4b staging-only, OPERATOR-ONLY restore of an isolated staging store from a backup of
 * `lumi-target.sqlite` (see scripts/target-staging-restore.mjs; no HTTP endpoint). Mechanism proposed
 * for owner approval, documented in docs/ARCHITECTURE.md (R2c.4b).
 *
 * The operator replaced ONLY the main SQLite file by a consistent backup; the irreversible journal
 * and the witness stayed. The store is therefore `restore_pending` (503) until this tool commits ONE
 * transaction which
 *   - replays the security-relevant intents confirmed after the backup (membership changes, session
 *     revocations) so a restore never brings back a removed member, a reduced role, a revoked session or
 *     a lower revocation epoch,
 *   - raises the revocation epoch of EVERY identity above everything the journal ever recorded
 *     (all pre-restore sessions die),
 *   - lists the tokens which were live under the irreversible source (`session_restored`, never an
 *     unknown token),
 *   - writes a fresh restore_generation (cursors, CAS tokens and offline commands of the old one
 *     answer `resync_required`),
 *   - keeps the last-admin invariant of every shared Area (otherwise nothing is committed), and
 *   - journals the restore as a `restore` intent (two-phase, like every other writer).
 * A refusal or failure rolls the restore transaction back: the database is unchanged and the store stays
 * `restore_pending`. The only thing which may persist is the tail resolution every writer performs first
 * (cutting a torn journal fragment, confirming/aborting a trailing intent, decided by the witness). A failed restore may leave its own
 * unconfirmed intent: a normal writer on the still-restore_pending store is denied and leaves it; only the
 * next run of this tool aborts it (per the witness).
 */
import { closeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  describeTargetStagingJournalGenerations, openTargetStagingJournal, readTargetStagingJournalText,
  TARGET_STAGING_RESTORE_MAX_GRANTS,
} from "./target-staging-anchor-journal";
import { pinTargetStagingFiles, withPinnedTargetStagingRestore } from "./target-staging-pinned-write";
import type { TargetStagingPinnedRestoreContext } from "./target-staging-pinned-write";
import { isSupportedTargetSchemaVersion } from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

const ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLES = new Set(["viewer", "editor", "admin"]);
/** The identity epoch grows by exactly one per UPDATE (trigger); bound the work per identity. */
const MAX_EPOCH_STEPS = 100_000;
const MAX_GRANTS = TARGET_STAGING_RESTORE_MAX_GRANTS;
/** Canonical JSON of the sorted grant pairs which still fits the 2048-byte journal line with the other fields. */
const MAX_GRANT_JSON = 1200;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TargetStagingRestoreGrant { readonly areaId: string; readonly userId: string }

export type TargetStagingRestoreFailure =
  /** Bad arguments, including a malformed `--generation` (not a UUID) and too many/too long grants. */
  | "invalid_request"
  /**
   * A well-formed `--generation` which is not the generation of this store's journal (the journal
   * verifies on its own and the backup belongs to it, but the configuration names another generation).
   */
  | "generation_mismatch"
  /** Store not restorable: not restore_pending, journal/witness invalid or missing, backup not a valid store. */
  | "unavailable"
  /** The backup was made at another schema version (older stores are never migrated). */
  | "unsupported_backup"
  /** The backup is not the state of this journal at the backup's `anchor_seq`. */
  | "backup_provenance"
  /** A restore already happened after the backup: use a newer backup. */
  | "backup_predates_restore"
  /** A confirmed note deletion after the backup cannot be replayed without content; refuse restore. */
  | "backup_predates_note_delete"
  /** A shared Area would have no admin: decide with --grant-admin. `blockedAreas` names them. */
  | "last_admin"
  /** An operator grant names an unknown Area or identity. */
  | "grant_invalid"
  /** A grant names an Area which the last-admin invariant does NOT block without it: refused, nothing changed. */
  | "grant_unneeded"
  /**
   * A grant names a user whom the journal (confirmed intents in (A,H]) finally removed from that Area or
   * lowered below admin: a restore never brings back a removed membership or a lowered role. Nothing changes.
   */
  | "grant_removed_by_journal"
  /** restore_generations or restore_superseded_sessions is full: a new staging store is needed. */
  | "capacity_exhausted"
  /** The journal holds a payload the replay does not understand, or the replay hit an unexpected error. */
  | "replay_failed"
  /**
   * The restore COMMITTED (the witness has it; the result carries `restoreGeneration` and
   * `previousGeneration`) but its `confirm` could not be appended safely: a path was replaced or changed
   * during the run, or the append failed. Do NOT start the server until the staging directory has been
   * inspected (only the expected files, nothing replaced). Then the operator may set the new generation
   * and start: the gate verifies the store on every request; if trusted, the first writer appends the
   * confirm; if not, everything stays 503 and recovery needs a DB copy taken AFTER this restore (a backup
   * from before it is refused with backup_predates_restore). Rerunning this tool closes nothing: the store is no longer
   * restore_pending, so it refuses with `unavailable` and leaves the tail; the first trusted writer under
   * the new generation appends the confirm.
   */
  | "confirm_untrusted"
  | "write_failed";

export type TargetStagingRestoreResult =
  | {
    ok: true; restoreGeneration: string; previousGeneration: string;
    backupAnchor: number; confirmedThrough: number;
    replayedMembership: number; revokedTokens: number; supersededTokens: number;
    skipped: number; epochsBumped: number; grantedAdmins: number; grantAdmin: [string, string][];
    stampedSessions: number;
  }
  | { ok: false; reason: TargetStagingRestoreFailure; blockedAreas?: string[];
      restoreGeneration?: string; previousGeneration?: string };

const lower = (value: string): string => value.toLowerCase();
const text = (value: unknown, max = 120): value is string =>
  typeof value === "string" && ID.test(value) && value.length <= max;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Read the backup's schema version (read-only, pinned), so an old backup is refused clearly. */
function backupSchemaVersion(store: TargetStagingReadStore): string | null {
  const files = pinTargetStagingFiles(store.stagingDirectory);
  if (!files) return null;
  let db: DatabaseSync | null = null;
  try {
    const opened = files.openDatabase({ readOnly: true });
    db = opened.db;
    db.exec("PRAGMA busy_timeout=2000");
    const row = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as
      { value: unknown } | undefined;
    return opened.verifyOpened() && typeof row?.value === "string" ? row.value : null;
  } catch { return null; }
  finally {
    if (db) { try { db.close(); } catch { /* fail closed */ } }
    files.close();
  }
}

class ReplayAbort extends Error {
  readonly reason: TargetStagingRestoreFailure;
  readonly blockedAreas: string[] | undefined;
  constructor(reason: TargetStagingRestoreFailure, blockedAreas?: string[]) {
    super(reason);
    this.reason = reason;
    this.blockedAreas = blockedAreas;
  }
}

/** CLI exit code: 0 success; 1 refusal (nothing changed except a possible trailing-intent close);
 *  2 committed but unconfirmed (confirm_untrusted: the new generation exists, inspect before starting). */
export function restoreExitCode(result: { readonly ok: boolean; readonly reason?: string }): 0 | 1 | 2 {
  if (result.ok) return 0;
  return result.reason === "confirm_untrusted" ? 2 : 1;
}

export function restoreTargetStagingFromBackup(
  store: TargetStagingReadStore,
  options: { readonly grantAdmin?: readonly TargetStagingRestoreGrant[]; readonly now?: number } = {},
): TargetStagingRestoreResult {
  const given = options.grantAdmin ?? [];
  const now = options.now ?? Date.now();
  if (!Array.isArray(given) || given.length > MAX_GRANTS || !Number.isSafeInteger(now) || now <= 0 ||
      given.some(grant => !grant || !text(grant.areaId) || !text(grant.userId)) ||
      typeof store?.expectedRestoreGeneration !== "string" || !GENERATION.test(store.expectedRestoreGeneration)) {
    return { ok: false, reason: "invalid_request" };
  }
  // Sorted, duplicate-free pairs: the journal records exactly these.
  const grants = [...new Map(given.map(grant => [`${grant.areaId}\0${grant.userId}`,
    { areaId: grant.areaId, userId: grant.userId }] as const)).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, grant]) => grant);
  if (JSON.stringify(grants.map(grant => [grant.areaId, grant.userId])).length > MAX_GRANT_JSON) {
    return { ok: false, reason: "invalid_request" };
  }
  const version = typeof store?.stagingDirectory === "string" ? backupSchemaVersion(store) : null;
  if (version !== null && !isSupportedTargetSchemaVersion(version)) {
    return { ok: false, reason: "unsupported_backup" };
  }
  const result = withPinnedTargetStagingRestore<TargetStagingRestoreResult>(store, context => {
    try {
      return restoreBody(context, grants, now);
    } catch (error) {
      if (error instanceof ReplayAbort) {
        return { ok: false, reason: error.reason, ...(error.blockedAreas ? { blockedAreas: error.blockedAreas } : {}) };
      }
      if (/(restore history|superseded session) capacity reached/.test(String((error as Error | null)?.message ?? ""))) {
        return { ok: false, reason: "capacity_exhausted" };
      }
      return { ok: false, reason: "write_failed" };
    }
  }, () => ({ ok: false, reason: "unavailable" }), () => ({ ok: false, reason: "write_failed" }));
  // Operator diagnosis only, after the store was refused and nothing was changed by this call.
  return result.ok === false && result.reason === "unavailable" && generationMismatch(store)
    ? { ok: false, reason: "generation_mismatch" } : result;
}

/**
 * The configured generation is well-formed but not this store's: the journal verifies on its own, the
 * backup's restore_generation is one this journal used, and the configuration is neither the generation in
 * effect nor the one a trailing unresolved restore introduces. Anything else stays `unavailable`
 * (another store's directory is never identified as this store).
 */
function generationMismatch(store: TargetStagingReadStore): boolean {
  const files = pinTargetStagingFiles(store.stagingDirectory);
  if (!files) return false;
  let db: DatabaseSync | null = null;
  let fd: number | null = null;
  try {
    const opened = files.openDatabase({ readOnly: true });
    db = opened.db;
    db.exec("PRAGMA busy_timeout=2000");
    const row = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get() as
      { value: unknown } | undefined;
    if (!opened.verifyOpened() || typeof row?.value !== "string" || !GENERATION.test(row.value)) return false;
    fd = openTargetStagingJournal(files.directoryFdPath, false);
    const journalText = fd === null ? null : readTargetStagingJournalText(fd);
    const described = journalText === null ? null : describeTargetStagingJournalGenerations(journalText);
    if (!described || !described.used.has(lower(row.value))) return false;
    const configured = lower(store.expectedRestoreGeneration);
    return configured !== lower(described.inEffect) && configured !== (described.pendingTo === null ? "" : lower(described.pendingTo));
  } catch { return false; }
  finally {
    if (db) { try { db.close(); } catch { /* fail closed */ } }
    if (fd !== null) { try { closeSync(fd); } catch { /* fail closed */ } }
    files.close();
  }
}

function restoreBody(
  context: TargetStagingPinnedRestoreContext, grants: readonly TargetStagingRestoreGrant[], now: number,
): TargetStagingRestoreResult {
  const { db } = context;
  const A = context.backupAnchor;
  const H = context.confirmedThrough;
  // Before the first write: afterwards SQLite's own -journal legitimately exists.
  if (!context.stillPinned() || !context.noSidecars()) throw new ReplayAbort("write_failed");

  // ---- provenance of the backup --------------------------------------------------------------
  // The backup must be the state of THIS journal at its anchor: A is 0 or a confirmed intent, and the
  // backup's generation is the one the journal had in effect there. A restore after the backup makes
  // an older backup unusable (its replay window would cross the generation change).
  const atAnchor = context.generationAt(A);
  if (!(A < H) || !context.isConfirmed(A) || atAnchor === null ||
      lower(atAnchor) !== lower(context.backupGeneration)) throw new ReplayAbort("backup_provenance");
  const facts = context.facts();
  if (facts === null) throw new ReplayAbort("replay_failed");
  if (facts.some(fact => fact.k === "restore" && fact.n > A && fact.n <= H) ||
      lower(context.previousGeneration) !== lower(context.backupGeneration)) {
    throw new ReplayAbort("backup_predates_restore");
  }
  // Note deletions currently have a content-free journal intent (no note ID).
  // Unlike membership/session revocations, they cannot safely be replayed
  // from this journal. A backup older than a confirmed deletion is therefore
  // NOT restorable; accepting it would resurrect a permanently tombstoned ID.
  // This applies even if the note was deleted and later unrelated writes ran.
  if (facts.some(fact => fact.k === "note_delete" && fact.n > A && fact.n <= H)) {
    throw new ReplayAbort("backup_predates_note_delete");
  }

  // ---- facts of the whole journal --------------------------------------------------------------
  const revoked = new Set<string>();
  const journalEpoch = new Map<string, number>();
  const raise = (user: string, epoch: number) => {
    if (epoch > (journalEpoch.get(user) ?? 0)) journalEpoch.set(user, epoch);
  };
  const issued = new Map<string, { user: string; epoch: number }>();
  const membership: { area: string; user: string; op: string; role: string | null }[] = [];
  for (const fact of facts) {
    const p = fact.p as Record<string, unknown>;
    if (fact.k === "session_issue") {
      if (!text(p.userId) || typeof p.tokenHash !== "string" || !HASH.test(p.tokenHash) || !int(p.epoch)) {
        throw new ReplayAbort("replay_failed");
      }
      raise(p.userId, p.epoch);
      if (fact.n > A) issued.set(p.tokenHash, { user: p.userId, epoch: p.epoch });
    } else if (fact.k === "session_revoke") {
      if (!text(p.userId) || typeof p.tokenHash !== "string" || !HASH.test(p.tokenHash) || !int(p.epoch)) {
        throw new ReplayAbort("replay_failed");
      }
      raise(p.userId, p.epoch);
      revoked.add(p.tokenHash);
    } else if (fact.k === "session_revoke_all") {
      if (!text(p.userId) || !int(p.epochAfter)) throw new ReplayAbort("replay_failed");
      raise(p.userId, p.epochAfter);
    } else if (fact.k === "membership" && fact.n > A) {
      const op = p.op;
      const role = p.role;
      if (!text(p.area) || !text(p.user) || (op !== "add" && op !== "set_role" && op !== "remove" && op !== "noop") ||
          (op === "remove" ? role !== null : op !== "noop" && !(typeof role === "string" && ROLES.has(role)))) {
        throw new ReplayAbort("replay_failed");
      }
      membership.push({ area: p.area, user: p.user, op, role: typeof role === "string" ? role : null });
    }
  }

  // ---- tokens live under the irreversible source (listed BEFORE anything is changed) ----------
  const epochRows = db.prepare("SELECT id, revocation_epoch AS epoch FROM identities").all() as
    { id: string; epoch: number }[];
  const sourceEpoch = new Map<string, number>(); // epoch under the irreversible source, per identity
  for (const row of epochRows) sourceEpoch.set(row.id, Math.max(row.epoch, journalEpoch.get(row.id) ?? 0));
  const sourceEpochOf = (user: string) => sourceEpoch.get(user) ?? journalEpoch.get(user) ?? 0;
  const superseded = new Map<string, string>(); // token hash -> user
  const rows = db.prepare(
    "SELECT token_hash AS h, user_id AS u, revocation_epoch AS e, revoked_at_ms AS r FROM staging_sessions",
  ).all() as { h: string; u: string; e: number; r: number | null }[];
  const rowTokens = new Set<string>();
  for (const row of rows) {
    rowTokens.add(row.h);
    if (row.r === null && !revoked.has(row.h) && row.e >= sourceEpochOf(row.u)) superseded.set(row.h, row.u);
  }
  for (const [hash, info] of issued) {
    // The DB row of the backup (if any) decided above; a journal-only issue is judged by the journal.
    if (!rowTokens.has(hash) && !revoked.has(hash) && info.epoch >= sourceEpochOf(info.user)) {
      superseded.set(hash, info.user);
    }
  }
  const already = db.prepare("SELECT 1 AS ok FROM restore_superseded_sessions WHERE token_hash = ?");
  for (const hash of [...superseded.keys()]) if (already.get(hash)) superseded.delete(hash);

  // ---- operator grants, then the replay --------------------------------------------------------
  // A grant is applied BEFORE the replay (so a journal demotion of the previous admin keeps the
  // invariant triggers satisfied) and asserted again AFTER it as defense in depth: a journal op that
  // would take the grant back is already refused up front as grant_removed_by_journal, so the
  // post-replay assertion should be unreachable.
  // A grant never overrides the journal: a user whom the journal finally removed from the Area or lowered
  // below admin (last confirmed membership intent in (A,H] for the pair) refuses the restore.
  const existsForGrant = (grant: TargetStagingRestoreGrant) => {
    const area = db.prepare("SELECT 1 AS ok FROM areas WHERE id = ? AND kind = 'shared'").get(grant.areaId);
    const person = db.prepare(`SELECT 1 AS ok FROM identities i JOIN workspaces w
      ON w.owner_user_id = i.id AND w.kind = 'personal' WHERE i.id = ?`).get(grant.userId);
    if (!area || !person) throw new ReplayAbort("grant_invalid");
  };
  const grantAdmin = (grant: TargetStagingRestoreGrant) => {
    existsForGrant(grant);
    const member = db.prepare("SELECT role FROM area_members WHERE area_id = ? AND user_id = ?")
      .get(grant.areaId, grant.userId) as { role: string } | undefined;
    if (!member) {
      db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,'admin')").run(grant.areaId, grant.userId);
    } else if (member.role !== "admin") {
      db.prepare("UPDATE area_members SET role='admin' WHERE area_id = ? AND user_id = ?").run(grant.areaId, grant.userId);
    }
  };
  const unassign = db.prepare(`UPDATE tasks SET assignee_user_id=NULL
     WHERE assignee_user_id=? AND id IN (
       SELECT task_id FROM task_effective_areas WHERE effective_area_id=? AND assignee_user_id=?)`);
  /** The replay with or without the grants; returns the counts and every Area the invariant blocks. */
  const replay = (withGrants: boolean) => {
    if (withGrants) for (const grant of grants) grantAdmin(grant);
    let replayed = 0;
    let skipped = 0;
    const blocked = new Set<string>();
    for (const op of membership) {
      if (op.op === "noop") continue;
      const area = db.prepare("SELECT 1 AS ok FROM areas WHERE id = ? AND kind = 'shared'").get(op.area);
      const person = db.prepare("SELECT 1 AS ok FROM identities WHERE id = ?").get(op.user);
      if (!area || !person) { skipped++; continue; }
      const member = db.prepare("SELECT role FROM area_members WHERE area_id = ? AND user_id = ?")
        .get(op.area, op.user) as { role: string } | undefined;
      if ((op.op === "set_role" || op.op === "remove") && !member) { skipped++; continue; }
      const after = op.op === "remove" ? null : op.role;
      if (member && member.role === after) continue; // already converged: nothing to apply
      db.exec("SAVEPOINT replay_op");
      try {
        // Unassign BEFORE the membership change so the existing guards pass (same as the live command).
        if (after === null || after === "viewer") unassign.run(op.user, op.area, op.user);
        if (after === null) db.prepare("DELETE FROM area_members WHERE area_id = ? AND user_id = ?").run(op.area, op.user);
        else if (member) db.prepare("UPDATE area_members SET role = ? WHERE area_id = ? AND user_id = ?").run(after, op.area, op.user);
        else db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(op.area, op.user, after);
        db.exec("RELEASE replay_op");
        replayed++;
      } catch (error) {
        db.exec("ROLLBACK TO replay_op");
        db.exec("RELEASE replay_op");
        // The only expected refusal is the last-admin invariant. Skipping it would hand back a role
        // which the journal took away, so the whole restore is refused instead (collect every Area).
        if (/at least one admin/.test(String((error as Error | null)?.message ?? ""))) blocked.add(op.area);
        else throw new ReplayAbort("replay_failed");
      }
    }
    if (withGrants) for (const grant of grants) grantAdmin(grant);
    const unguarded = db.prepare(`SELECT a.id AS id FROM areas a WHERE a.kind = 'shared' AND NOT EXISTS (
      SELECT 1 FROM area_members m WHERE m.area_id = a.id AND m.role = 'admin') ORDER BY a.id`).all() as { id: string }[];
    for (const row of unguarded) blocked.add(row.id);
    return { replayed, skipped, blocked };
  };

  if (grants.length > 0) {
    // A grant is only for an Area which the invariant would otherwise block: evaluate the replay WITHOUT
    // grants first (inside this transaction, rolled back to the savepoint), then refuse any other grant.
    for (const grant of grants) existsForGrant(grant);
    const finalRole = new Map<string, string | null>();
    for (const op of membership) if (op.op !== "noop") finalRole.set(`${op.area}\0${op.user}`, op.op === "remove" ? null : op.role);
    for (const grant of grants) {
      const last = finalRole.get(`${grant.areaId}\0${grant.userId}`);
      if (last !== undefined && last !== "admin") throw new ReplayAbort("grant_removed_by_journal");
    }
    db.exec("SAVEPOINT replay_dry");
    let dry: Set<string>;
    try {
      dry = replay(false).blocked;
    } finally {
      db.exec("ROLLBACK TO replay_dry");
      db.exec("RELEASE replay_dry");
    }
    if (grants.some(grant => !dry.has(grant.areaId))) throw new ReplayAbort("grant_unneeded");
  }
  const { replayed, skipped, blocked } = replay(true);
  if (blocked.size > 0) throw new ReplayAbort("last_admin", [...blocked].sort());

  // ---- every session dies: the epoch of every identity ends above everything the journal knows ----
  let epochsBumped = 0;
  const bump = db.prepare("UPDATE identities SET revocation_epoch = revocation_epoch + 1 WHERE id = ?");
  for (const row of epochRows) {
    const steps = Math.max(row.epoch, journalEpoch.get(row.id) ?? 0) + 1 - row.epoch;
    if (steps < 1 || steps > MAX_EPOCH_STEPS) throw new ReplayAbort("replay_failed");
    for (let i = 0; i < steps; i++) {
      if (bump.run(row.id).changes !== 1) throw new ReplayAbort("write_failed");
    }
    epochsBumped++;
  }
  const stamped = Number(db.prepare("UPDATE staging_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL")
    .run(now).changes);

  // ---- the new generation and the superseded sessions -----------------------------------------
  const updated = db.prepare("UPDATE metadata SET value = ? WHERE key = 'restore_generation'")
    .run(context.newGeneration);
  if (updated.changes !== 1) throw new ReplayAbort("write_failed");
  db.prepare("INSERT INTO restore_generations(generation,previous_generation,journal_n,restored_at_ms) VALUES (?,?,?,?)")
    .run(context.newGeneration, context.backupGeneration, context.intentNumber, now);
  const insert = db.prepare("INSERT INTO restore_superseded_sessions(token_hash,user_id,restore_generation) VALUES (?,?,?)");
  for (const [hash, user] of superseded) insert.run(hash, user, context.newGeneration);

  // The result must be a valid store of the NEW generation before anything is committed.
  const check = inspectIsolatedTargetStore({
    stagingDirectory: context.directory, expectedRestoreGeneration: context.newGeneration, mode: "r2-model",
  }, { db, fd: context.databaseFd });
  if (!check.ok || !context.stillPinned()) throw new ReplayAbort("write_failed");

  const grantPairs = grants.map(grant => [grant.areaId, grant.userId] as [string, string]);
  const confirmed = context.commit({ kind: "restore", payload: {
    superseded: superseded.size, skipped, grantAdmin: grantPairs,
  } });
  // Never report success for a restore whose confirm is missing: the operator must not set the new generation.
  if (!confirmed) {
    return { ok: false, reason: "confirm_untrusted", restoreGeneration: context.newGeneration,
      previousGeneration: context.previousGeneration };
  }
  return {
    ok: true, restoreGeneration: context.newGeneration, previousGeneration: context.previousGeneration,
    backupAnchor: A, confirmedThrough: H, replayedMembership: replayed, revokedTokens: revoked.size,
    supersededTokens: superseded.size, skipped, epochsBumped, grantedAdmins: grants.length, grantAdmin: grantPairs,
    stampedSessions: stamped,
  };
}
