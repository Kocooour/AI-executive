// The ONE reader of the D2a migration source, shared by the offline preflight and the applicator,
// so that both can never read (or accept) different data. Read-only: it never writes.
import type { DatabaseSync } from "node:sqlite";
import type { Entity, Relation } from "./db";
import { AreaNormalizationBlocked } from "./area-normalization";
import type { AreaSourceIdentity } from "./area-normalization-preflight";

export type AreaNormalizationSourceRead = {
  source: { entities: Entity[]; relations: Relation[] };
  identity: AreaSourceIdentity;
  // Preflight time: the newest entity update, exactly as the preflight script computes it.
  at: number;
};

function counter(key: string, value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AreaNormalizationBlocked(["invalid-store-" + key]);
  return Number(value);
}

export function readAreaNormalizationSource(db: DatabaseSync): AreaNormalizationSourceRead {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));
  if (!["entities", "relations", "tombstones", "metadata"].every(t => tables.has(t)))
    throw new AreaNormalizationBlocked(["bad-offline-schema"]);
  if ((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length > 0)
    throw new AreaNormalizationBlocked(["offline-integrity-failed"]);
  // Both mirror timestamps are written with the payload by writeSnapshotRows
  // (lib/server-store.ts); they must agree, or the store is inconsistent.
  const entities = (db.prepare("SELECT id, payload, updated_at FROM entities ORDER BY id").all() as Array<{ id: string; payload: string; updated_at: number }>).map(row => {
    const e = JSON.parse(row.payload) as Entity;
    if (e.id !== row.id) throw new AreaNormalizationBlocked(["entity-id-disagrees"]);
    if (!Number.isSafeInteger(row.updated_at) || row.updated_at !== (e.updatedAt || 0))
      throw new AreaNormalizationBlocked(["entity-timestamp-disagrees"]);
    return e;
  });
  const relations = (db.prepare("SELECT id, payload, created_at FROM relations ORDER BY id").all() as Array<{ id: string; payload: string; created_at: number }>).map(row => {
    const r = JSON.parse(row.payload) as Relation;
    if (r.id !== row.id) throw new AreaNormalizationBlocked(["relation-id-disagrees"]);
    if (!Number.isSafeInteger(row.created_at) || row.created_at !== (r.createdAt || 0))
      throw new AreaNormalizationBlocked(["relation-timestamp-disagrees"]);
    return r;
  });
  const tombstones = (db.prepare("SELECT id, deleted_at FROM tombstones ORDER BY id").all() as Array<{ id: string; deleted_at: number }>)
    .map(r => ({ id: r.id, deletedAt: r.deleted_at }));
  const metadata = new Map((db.prepare("SELECT key, value FROM metadata WHERE key IN ('revision','restoreGeneration')")
    .all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]));
  // readSnapshot() defaults a missing restoreGeneration to 0 until the first
  // restore/import. A present but malformed value is never a valid default.
  if (!metadata.has("revision")) throw new AreaNormalizationBlocked(["missing-store-revision"]);
  const revision = counter("revision", metadata.get("revision"));
  const restoreGeneration = metadata.has("restoreGeneration")
    ? counter("restore-generation", metadata.get("restoreGeneration")) : 0;
  const at = entities.reduce((n, e) => Math.max(n, Number.isFinite(e.updatedAt) ? e.updatedAt : 0), 0);
  return { source: { entities, relations }, identity: { revision, restoreGeneration, tombstones }, at };
}
