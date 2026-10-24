// 2a, part 3: transactional, backed-up, verifiable and reversible Area normalization. A TOOL only: nothing calls
// it from start-up, schema migrations, API routes or UI. Run it with the service stopped (docs/D2A-AREA-APPLY.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entity } from "./db";
import { AreaNormalizationBlocked, planAreaNormalization } from "./area-normalization";
import { areaSnapshotSha256, createAreaPreflight, verifyAreaPreflight, type AreaPreflight } from "./area-normalization-preflight";
import { readAreaNormalizationSource } from "./area-normalization-source";
import { describeFile } from "./backup-engine";
import { resolveDataDirectory } from "./data-dir";
import { createBackup, getDatabase, restoreBackup, writeSnapshotRows, type StoreSnapshot } from "./server-store";
import { validateSnapshotStructure } from "./snapshot-validation";

export type AppliedManifest = {
  status: "applied";
  sourceSha256: string; resultSha256: string;
  revisionBefore: number; revisionAfter: number; restoreGeneration: number;
  backup: { name: string; sha256: string; bytes: number };
  counts: { createdAreas: number; addedRelations: number; tombstonedRelations: number; kindBackfills: number; inheritedTasks: number };
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
let faultsForTests: { afterBackup?: () => void; afterWrite?: () => void } | null = null;
export function areaNormalizationFaultsForTests(faults: { afterBackup?: () => void; afterWrite?: () => void } | null) {
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

export function applyAreaNormalization(expected: AreaPreflight, options: { now: number }): AreaApplyResult {
  const database = getDatabase();
  if ((database as unknown as { isTransaction?: boolean }).isTransaction) throw blocked("inside-transaction");
  // a. Outside any transaction: drift means no backup and no write.
  const first = readAreaNormalizationSource(database);
  verifyAreaPreflight(first.source, first.identity, expected);
  if (expected.noChanges) return { status: "noop" };
  const { now } = options;
  const newest = Math.max(0, ...first.source.entities.map(e => e.updatedAt || 0), ...first.source.relations.map(r => r.createdAt || 0));
  if (!Number.isSafeInteger(now) || now < newest) throw blocked("invalid-apply-timestamp");

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
    const { source, identity } = locked;
    if (backup.counts.entities !== source.entities.length || backup.counts.relations !== source.relations.length ||
        backup.counts.tombstones !== identity.tombstones.length) throw blocked("backup-mismatch");
    const planned = planAreaNormalization({ ...source, tombstones: identity.tombstones }, expected.at);
    const report = planned.report;

    // d. The next state: planned records, kind backfill, tombstones for removed links, revision + 1.
    const workspaceKind = new Map<string, string>([["personal", "personal"]]);
    for (const e of planned.entities) if (e.type === "workspace") workspaceKind.set(e.workspaceId, String(e.properties.kind));
    const backfill = new Set(report.existingAreaKindBackfillIds);
    const entities = planned.entities.map((e): Entity => !backfill.has(e.id) ? e : {
      ...e,
      properties: { ...e.properties, kind: workspaceKind.get(e.workspaceId) === "personal" ? "private" : "shared" },
      updatedAt: Math.max(now, (e.updatedAt || 0) + 1),
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
          (!backfill.has(old.id) && entitySha(kept) !== entitySha(old))) throw blocked("result-verification-failed");
    }
    if (!createAreaPreflight(after.source, after.identity, after.at).noChanges) throw blocked("result-not-normalized");
    database.exec("COMMIT");
    return {
      status: "applied", sourceSha256: expected.sourceSha256, resultSha256,
      revisionBefore: identity.revision, revisionAfter: next.revision, restoreGeneration: identity.restoreGeneration,
      backup: { name: backup.name, sha256: backup.sha256, bytes: backup.bytes },
      counts: {
        createdAreas: report.createdAreaIds.length,
        addedRelations: report.addedRelationIds.length + report.addedLegacyProjectRelationIds.length,
        tombstonedRelations: removedIds.length, kindBackfills: backfill.size, inheritedTasks: report.inheritedTaskIds.length,
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
  const database = getDatabase();
  if ((database as unknown as { isTransaction?: boolean }).isTransaction) throw blocked("inside-transaction");
  const current = readAreaNormalizationSource(database);
  if (current.identity.revision !== applied.revisionAfter || current.identity.restoreGeneration !== applied.restoreGeneration ||
      areaSnapshotSha256(current.source, current.identity.tombstones) !== applied.resultSha256)
    throw blocked("post-migration-changes");
  const backup = backupFacts(applied.backup.name);
  if (backup.sha256 !== applied.backup.sha256 || backup.bytes !== applied.backup.bytes) throw blocked("backup-mismatch");
  // The tombstones the backup knew; the restore adds some for the Areas this migration created.
  const copy = new DatabaseSync(backupFile(backup.name), { readOnly: true });
  let known: Set<string>;
  try { known = new Set((copy.prepare("SELECT id FROM tombstones").all() as Array<{ id: string }>).map(r => r.id)); }
  finally { copy.close(); }
  try { restoreBackup(backup.name); } catch { throw blocked("restore-failed"); }
  const after = readAreaNormalizationSource(database);
  const rolledBackSha256 = areaSnapshotSha256(after.source, after.identity.tombstones.filter(t => known.has(t.id)));
  if (rolledBackSha256 !== applied.sourceSha256 || after.identity.restoreGeneration <= applied.restoreGeneration)
    throw blocked("rollback-verification-failed");
  return {
    status: "rolled-back", rolledBackSha256, sourceSha256: applied.sourceSha256,
    revision: after.identity.revision, restoreGeneration: after.identity.restoreGeneration,
  };
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
  const numeric = ["revision", "restoreGeneration", "at", "addedAreas", "addedRelations", "removedRelations", "inheritedTasks", "pendingAreaKindBackfills"];
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
  if (!sameKeys(v, ["status", "sourceSha256", "resultSha256", "revisionBefore", "revisionAfter", "restoreGeneration", "backup", "counts", "appliedAt"]) ||
      v.status !== "applied" || !hex(v.sourceSha256) || !hex(v.resultSha256) ||
      !safeInt(v.revisionBefore) || !safeInt(v.revisionAfter) || !safeInt(v.restoreGeneration) || !safeInt(v.appliedAt) ||
      !isObject(b) || !sameKeys(b, ["name", "sha256", "bytes"]) || typeof b.name !== "string" || !hex(b.sha256) || !safeInt(b.bytes) ||
      !counts(v.counts, ["createdAreas", "addedRelations", "tombstonedRelations", "kindBackfills", "inheritedTasks"]))
    throw blocked("bad-applied-manifest");
  return v as unknown as AppliedManifest;
}
