// 2a, part 3: transactional, backed-up, verifiable and reversible Area normalization. A TOOL only: nothing calls
// it from start-up, schema migrations, API routes or UI. Run it with the service stopped (docs/D2A-AREA-APPLY.md).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entity } from "./db";
import { AreaNormalizationBlocked, planAreaNormalization } from "./area-normalization";
import { areaIdCleanupIds, areaSnapshotSha256, createAreaPreflight, verifyAreaPreflight, type AreaPreflight } from "./area-normalization-preflight";
import { readAreaNormalizationSource } from "./area-normalization-source";
import { describeFile } from "./backup-engine";
import { resolveDataDirectory } from "./data-dir";
import { replacedTables } from "./backup-scope";
import { countExpiredMailMetadata } from "./mail-sync-retention";
import { schemaMigrations } from "./schema-migrations";
import { createHash } from "node:crypto";
import { createBackup, getDatabase, restoreBackup, writeSnapshotRows, type StoreSnapshot } from "./server-store";
import { validateSnapshotStructure } from "./snapshot-validation";

export type AppliedManifest = {
  status: "applied";
  sourceSha256: string; resultSha256: string;
  // Fingerprint of every other table a restore replaces (context, work sessions, attention...), at apply time.
  otherTablesSha256: string;
  revisionBefore: number; revisionAfter: number; restoreGeneration: number;
  backup: { name: string; sha256: string; bytes: number };
  counts: { createdAreas: number; addedRelations: number; tombstonedRelations: number; kindBackfills: number; inheritedTasks: number; areaIdCleanups: number };
  appliedAt: number;
};
export type AreaApplyResult = { status: "noop" } | AppliedManifest;
export type AreaRollbackResult = {
  status: "rolled-back"; rolledBackSha256: string; sourceSha256: string; revision: number; restoreGeneration: number;
};

const blocked = (...codes: string[]) => new AreaNormalizationBlocked(codes);
const rollbackQuietly = (database: DatabaseSync) => { try { database.exec("ROLLBACK"); } catch { /* the original error matters */ } };
const entitySha = (entity: Entity) => areaSnapshotSha256({ entities: [entity], relations: [] }, []);

// Tests only (pattern: failRestoreAfterTableForTests in server-store): inject a fault or a competing write.
type Faults = { afterBackup?: () => void; afterWrite?: () => void; beforeRestore?: () => void };
let faultsForTests: Faults | null = null;
export function areaNormalizationFaultsForTests(faults: Faults | null) {
  if (faults !== null && !process.env.NODE_TEST_CONTEXT) throw new Error("Not available outside tests");
  faultsForTests = faults;
}

const backupFile = (name: string) => path.join(resolveDataDirectory(), "backups", name);
const sidecarFile = (name: string) => backupFile(name.replace(/\.sqlite$/, ".meta.json"));
// The backup as the store recorded it: file, sidecar and counts must agree, or it cannot be trusted for a rollback.
function backupFacts(name: string) {
  if (!/^[0-9T-]+Z-before-area-normalization\.sqlite$/.test(name) || !existsSync(backupFile(name)) || !existsSync(sidecarFile(name)))
    throw blocked("backup-mismatch");
  const meta = JSON.parse(readFileSync(sidecarFile(name), "utf8"));
  const actual = describeFile(backupFile(name));
  if (meta.sha256 !== actual.sha256 || meta.bytes !== actual.bytes) throw blocked("backup-mismatch");
  return { name, sha256: actual.sha256, bytes: actual.bytes, counts: meta.counts as Record<string, number> };
}

// Canonical sha256 over all rows of the tables a restore replaces besides the store tables (entities, relations,
// tombstones are covered by the snapshot sha). Row order does not matter. Every value is tagged with its SQLite type,
// so NULL, +-Infinity, BLOB vs TEXT and integers beyond 2^53 can never collide (integers are read as BigInt).
const tagged = (v: unknown): unknown[] =>
  v === null ? ["n"] : typeof v === "bigint" ? ["i", v.toString()]
  : typeof v === "number" ? ["r", Object.is(v, -0) ? "-0" : Number.isFinite(v) ? v : String(v)]
  : typeof v === "string" ? ["t", v] : v instanceof Uint8Array ? ["b", Buffer.from(v).toString("hex")]
  : (() => { throw blocked("unfingerprintable-value"); })();
export function fingerprintOtherTables(database: DatabaseSync) {
  const hash = createHash("sha256");
  for (const table of [...replacedTables].sort()) {
    const statement = database.prepare(`SELECT * FROM "${table}"`);
    statement.setReadBigInts(true);
    const rows = (statement.all() as Array<Record<string, unknown>>)
      .map(row => JSON.stringify(Object.keys(row).sort().map(k => [k, tagged(row[k])])))
      .sort();
    hash.update(JSON.stringify([table, rows]));
  }
  return hash.digest("hex");
}

// A separate READ-ONLY connection to the live file, resolved exactly like server-store does. getDatabase() mutates the
// store when it opens it (schema migrations, repairs, retention sweep), so every refusal that can be decided from a
// read happens here, before getDatabase() is ever called.
function withLiveReadOnly<T>(fn: (database: DatabaseSync) => T): T {
  const file = path.join(resolveDataDirectory(), "store.sqlite");
  let isFile = false;
  try { isFile = statSync(file).isFile(); } catch { /* missing */ }
  if (!isFile) throw blocked("missing-store");
  const database = new DatabaseSync(file, { readOnly: true });
  try { return fn(database); } finally { database.close(); }
}

// Refusals about work getDatabase() would do on open: pending schema migrations (they rewrite payloads and bump the
// revision), the default workspace it would insert. The operator starts the service once so they run, then re-runs preflight.
function assertStoreReady(database: DatabaseSync) {
  const hasTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const applied = new Set(hasTable ? (database.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map(r => r.id) : []);
  if (schemaMigrations.some(m => !applied.has(m.id))) throw blocked("pending-schema-migrations");
  if (!database.prepare("SELECT 1 FROM entities WHERE id = 'workspace:personal'").get()) throw blocked("missing-default-workspace");
}

export function applyAreaNormalization(expected: AreaPreflight, options: { now: number }): AreaApplyResult {
  // a. Read-only connection, outside any transaction: drift (or noChanges) means getDatabase() is never called,
  // so nothing is opened for writing, migrated, repaired, backed up or written.
  const now = options.now;
  const checked = withLiveReadOnly(database => {
    assertStoreReady(database);
    const first = readAreaNormalizationSource(database);
    verifyAreaPreflight(first.source, first.identity, expected);
    if (expected.noChanges) return "noop" as const;
    // A loop, not Math.max(...spread): spreading hundreds of thousands of records overflows the call stack.
    let newest = 0;
    for (const e of first.source.entities) newest = Math.max(newest, e.updatedAt || 0);
    for (const r of first.source.relations) newest = Math.max(newest, r.createdAt || 0);
    if (!Number.isSafeInteger(now) || now < newest) throw blocked("invalid-apply-timestamp");
    return "go" as const;
  });
  if (checked === "noop") return { status: "noop" };
  // From here the store is opened normally: its start-up repairs/retention run BEFORE the backup (so the backup
  // contains their result), and the locked re-verification below catches anything they changed.
  const database = getDatabase();
  if ((database as unknown as { isTransaction?: boolean }).isTransaction) throw blocked("inside-transaction");

  // b. createBackup must run outside a transaction. A failed backup writes nothing.
  let backup: ReturnType<typeof backupFacts>;
  try { backup = backupFacts(createBackup("before-area-normalization").name); }
  catch (error) { throw error instanceof AreaNormalizationBlocked ? error : blocked("backup-failed"); }
  faultsForTests?.afterBackup?.();

  database.exec("BEGIN IMMEDIATE");
  try {
    // c. Under the write lock: same reader, same verification. Entity/relation/tombstone writes bump the
    // revision, so a source equal to the verified one also equals the backup just taken.
    const locked = readAreaNormalizationSource(database);
    verifyAreaPreflight(locked.source, locked.identity, expected);
    // Tables the source sha does not cover (attention, context, work sessions...) can change without a revision
    // bump: the backup must hold exactly the live rows, or a later rollback would restore an older copy.
    const otherTablesSha256 = fingerprintOtherTables(database);
    const copy = new DatabaseSync(backupFile(backup.name), { readOnly: true });
    try { if (fingerprintOtherTables(copy) !== otherTablesSha256) throw blocked("other-tables-drift"); }
    finally { copy.close(); }
    const { source, identity } = locked;
    if (backup.counts.entities !== source.entities.length || backup.counts.relations !== source.relations.length ||
        backup.counts.tombstones !== identity.tombstones.length) throw blocked("backup-mismatch");
    const planned = planAreaNormalization({ ...source, tombstones: identity.tombstones }, expected.at);
    const report = planned.report;

    // d. The next state: planned records, kind backfill, tombstones for removed links, revision + 1.
    const workspaceKind = new Map<string, string>([["personal", "personal"]]);
    for (const e of planned.entities) if (e.type === "workspace") workspaceKind.set(e.workspaceId, String(e.properties.kind));
    const backfill = new Set(report.existingAreaKindBackfillIds);
    // Inherited project tasks drop a leftover properties.areaId (only that key): the client load migration would
    // otherwise turn it back into the task-level link this migration removed.
    const cleanup = new Set(areaIdCleanupIds(planned.entities, report.inheritedTaskIds));
    const entities = planned.entities.map((e): Entity => {
      if (cleanup.has(e.id)) {
        const { areaId: _dropped, ...properties } = e.properties;
        return { ...e, properties, updatedAt: Math.max(now, (e.updatedAt || 0) + 1) };
      }
      if (!backfill.has(e.id)) return e;
      return {
        ...e,
        properties: { ...e.properties, kind: workspaceKind.get(e.workspaceId) === "personal" ? "private" : "shared" },
        updatedAt: Math.max(now, (e.updatedAt || 0) + 1),
      };
    });
    const removedIds = report.removedRedundantRelationIds;
    const next: StoreSnapshot = {
      revision: identity.revision + 1, restoreGeneration: identity.restoreGeneration,
      entities, relations: planned.relations,
      // Old clients merging a pre-normalization copy skip tombstoned relation IDs (mergeSnapshots).
      tombstones: [...identity.tombstones, ...removedIds.map(id => ({ id, deletedAt: now }))],
      updatedAt: now,
    };
    try { validateSnapshotStructure(next); } catch { throw blocked("next-snapshot-invalid"); }
    const expectedSha = areaSnapshotSha256(next, next.tombstones);

    // e. Same row conventions as every other store write; never replaceSnapshot (client semantics).
    writeSnapshotRows(database, next);
    faultsForTests?.afterWrite?.();

    // f. Verify what is actually in the rows, still under the lock.
    const after = readAreaNormalizationSource(database);
    const resultSha256 = areaSnapshotSha256(after.source, after.identity.tombstones);
    if (resultSha256 !== expectedSha || after.identity.revision !== next.revision ||
        after.identity.restoreGeneration !== identity.restoreGeneration) throw blocked("result-verification-failed");
    const nowEntities = new Map(after.source.entities.map(e => [e.id, e]));
    const expectedEntities = new Map(entities.map(e => [e.id, e]));
    for (const old of source.entities) {
      const kept = nowEntities.get(old.id);
      if (!kept || kept.workspaceId !== old.workspaceId || entitySha(kept) !== entitySha(expectedEntities.get(old.id)!) ||
          (!backfill.has(old.id) && !cleanup.has(old.id) && entitySha(kept) !== entitySha(old))) throw blocked("result-verification-failed");
    }
    if (!createAreaPreflight(after.source, after.identity, after.at).noChanges) throw blocked("result-not-normalized");
    // Unchanged by the writes above (verified equal to the backup before them), re-checked for safety.
    if (fingerprintOtherTables(database) !== otherTablesSha256) throw blocked("other-tables-drift");
    database.exec("COMMIT");
    return {
      status: "applied", sourceSha256: expected.sourceSha256, resultSha256, otherTablesSha256,
      revisionBefore: identity.revision, revisionAfter: next.revision, restoreGeneration: identity.restoreGeneration,
      backup: { name: backup.name, sha256: backup.sha256, bytes: backup.bytes },
      counts: {
        createdAreas: report.createdAreaIds.length,
        addedRelations: report.addedRelationIds.length + report.addedLegacyProjectRelationIds.length,
        tombstonedRelations: removedIds.length, kindBackfills: backfill.size, inheritedTasks: report.inheritedTaskIds.length,
        areaIdCleanups: cleanup.size,
      },
      appliedAt: now,
    };
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

/**
 * Only while the store is still exactly the applied result. Restores the pre-apply backup through the normal
 * restore path (restoreGeneration + 1, so clients adopt it instead of merging). Stop the service first: the
 * restore takes its own lock and also returns the other backed-up tables (context, work sessions...) to the backup.
 */
export function rollbackAreaNormalization(applied: AppliedManifest): AreaRollbackResult {
  // Refusals decidable from reads happen on a read-only connection, before getDatabase() can touch the store;
  // the same state checks are repeated INSIDE the restore transaction (verifyBefore below).
  const backup = backupFacts(applied.backup.name);
  if (backup.sha256 !== applied.backup.sha256 || backup.bytes !== applied.backup.bytes) throw blocked("backup-mismatch");
  withLiveReadOnly(db => {
    assertStoreReady(db);
    const current = readAreaNormalizationSource(db);
    if (current.identity.revision !== applied.revisionAfter || current.identity.restoreGeneration !== applied.restoreGeneration ||
        areaSnapshotSha256(current.source, current.identity.tombstones) !== applied.resultSha256 ||
        fingerprintOtherTables(db) !== applied.otherTablesSha256) throw blocked("post-migration-changes");
    // Opening the store runs the mail retention sweep and COMMITS its deletes before any restore check could refuse,
    // which would make the rollback impossible. Refuse while the sweep would delete anything (the apply needs no such
    // probe: retention running before its backup is harmless, the backup then already contains the result).
    if (countExpiredMailMetadata(db) > 0) throw blocked("retention-pending");
  });
  const database = getDatabase();
  if ((database as unknown as { isTransaction?: boolean }).isTransaction) throw blocked("inside-transaction");
  // The tombstones the backup knew; the restore adds some for the Areas this migration created.
  const copy = new DatabaseSync(backupFile(backup.name), { readOnly: true });
  let known: Set<string>;
  try { known = new Set((copy.prepare("SELECT id FROM tombstones").all() as Array<{ id: string }>).map(r => r.id)); }
  finally { copy.close(); }
  faultsForTests?.beforeRestore?.();
  let result: AreaRollbackResult | undefined;
  try {
    restoreBackup(backup.name, {
      // Under the restore's write lock, before anything is replaced: still exactly the applied result, and no
      // other restorable table changed since (the restore would silently discard such writes).
      verifyBefore(db) {
        const current = readAreaNormalizationSource(db);
        if (current.identity.revision !== applied.revisionAfter || current.identity.restoreGeneration !== applied.restoreGeneration ||
            areaSnapshotSha256(current.source, current.identity.tombstones) !== applied.resultSha256 ||
            fingerprintOtherTables(db) !== applied.otherTablesSha256) throw blocked("post-migration-changes");
      },
      // Before COMMIT: a failure here rolls the whole restore back and leaves the applied state intact.
      verifyAfter(db) {
        const after = readAreaNormalizationSource(db);
        const rolledBackSha256 = areaSnapshotSha256(after.source, after.identity.tombstones.filter(t => known.has(t.id)));
        if (rolledBackSha256 !== applied.sourceSha256 || after.identity.restoreGeneration <= applied.restoreGeneration)
          throw blocked("rollback-verification-failed");
        result = {
          status: "rolled-back", rolledBackSha256, sourceSha256: applied.sourceSha256,
          revision: after.identity.revision, restoreGeneration: after.identity.restoreGeneration,
        };
      },
    });
  } catch (error) { throw error instanceof AreaNormalizationBlocked ? error : blocked("restore-failed"); }
  if (!result) throw blocked("rollback-verification-failed");
  return result;
}

// Strict manifest parsers for the CLI: exactly the known fields, nothing else.
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const counts = (v: unknown, keys: string[]) => isObject(v) && sameKeys(v, keys) && keys.every(k => safeInt(v[k]));

export function parseAreaPreflightManifest(input: unknown): AreaPreflight {
  // Accept the preflight script's wrapper and strip it before verification.
  const { status, ...v } = isObject(input) ? input : { status: undefined };
  if (status !== "offline-preflight-only" && status !== undefined) throw blocked("bad-preflight-manifest");
  const numeric = ["revision", "restoreGeneration", "at", "addedAreas", "addedRelations", "removedRelations", "inheritedTasks", "pendingAreaKindBackfills", "pendingAreaIdCleanups"];
  if (!sameKeys(v, ["sourceSha256", "targetSha256", "before", "after", "areaKindBackfillRequired", "noChanges", ...numeric]) ||
      !hex(v.sourceSha256) || !hex(v.targetSha256) || !numeric.every(k => safeInt(v[k])) ||
      !counts(v.before, ["entities", "relations"]) || !counts(v.after, ["entities", "relations"]) ||
      typeof v.areaKindBackfillRequired !== "boolean" || typeof v.noChanges !== "boolean")
    throw blocked("bad-preflight-manifest");
  return v as unknown as AreaPreflight;
}

export function parseAppliedManifest(input: unknown): AppliedManifest {
  const v = isObject(input) ? input : {};
  const b = v.backup;
  if (!sameKeys(v, ["status", "sourceSha256", "resultSha256", "otherTablesSha256", "revisionBefore", "revisionAfter", "restoreGeneration", "backup", "counts", "appliedAt"]) ||
      v.status !== "applied" || !hex(v.sourceSha256) || !hex(v.resultSha256) || !hex(v.otherTablesSha256) ||
      !safeInt(v.revisionBefore) || !safeInt(v.revisionAfter) || !safeInt(v.restoreGeneration) || !safeInt(v.appliedAt) ||
      !isObject(b) || !sameKeys(b, ["name", "sha256", "bytes"]) || typeof b.name !== "string" || !hex(b.sha256) || !safeInt(b.bytes) ||
      !counts(v.counts, ["createdAreas", "addedRelations", "tombstonedRelations", "kindBackfills", "inheritedTasks", "areaIdCleanups"]))
    throw blocked("bad-applied-manifest");
  return v as unknown as AppliedManifest;
}
