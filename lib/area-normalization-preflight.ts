// D2a preflight: content fingerprints and fail-closed invariants. NO database writes.
import { createHash } from "node:crypto";
import { AreaNormalizationBlocked, planAreaNormalization, type AreaNormalizationSnapshot } from "./area-normalization";

export type AreaSourceIdentity = { revision: number; restoreGeneration: number; tombstoneIds: readonly string[] };
export type AreaPreflight = {
  sourceSha256: string; targetSha256: string; revision: number; restoreGeneration: number; at: number;
  before: { entities: number; relations: number };
  after: { entities: number; relations: number };
  addedAreas: number; addedRelations: number; removedRelations: number; inheritedTasks: number;
  noChanges: boolean;
};
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AreaNormalizationBlocked(["non-finite-snapshot"]);
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value) {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new AreaNormalizationBlocked(["undefined-snapshot-value"]);
      out[key] = canonical(item);
    }
    return out;
  }
  throw new AreaNormalizationBlocked(["unserializable-snapshot-value"]);
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export function areaSnapshotSha256(source: AreaNormalizationSnapshot): string {
  const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return sha({ entities: [...source.entities].sort(byId), relations: [...source.relations].sort(byId) });
}
function validIdentity(i: AreaSourceIdentity) {
  return Number.isSafeInteger(i.revision) && i.revision >= 0 &&
    Number.isSafeInteger(i.restoreGeneration) && i.restoreGeneration >= 0 &&
    Array.isArray(i.tombstoneIds) &&
    i.tombstoneIds.every(id => typeof id === "string" && id.length > 0) &&
    new Set(i.tombstoneIds).size === i.tombstoneIds.length;
}
export function createAreaPreflight(source: AreaNormalizationSnapshot, identity: AreaSourceIdentity, at: number): AreaPreflight {
  if (!validIdentity(identity)) throw new AreaNormalizationBlocked(["invalid-source-identity"]);
  if (!source || !Array.isArray(source.entities) || !Array.isArray(source.relations))
    throw new AreaNormalizationBlocked(["invalid-source-shape"]);
  const sourceSha256 = areaSnapshotSha256(source);
  const planned = planAreaNormalization(source, at);
  const sourceEntities = new Map(source.entities.map(e => [e.id, e]));
  const sourceRelations = new Map(source.relations.map(r => [r.id, r]));
  const outputEntities = new Map(planned.entities.map(e => [e.id, e]));
  const outputRelations = new Map(planned.relations.map(r => [r.id, r]));
  const removed = new Set(planned.report.removedRedundantRelationIds);
  const tombstones = new Set(identity.tombstoneIds);
  const issues: string[] = [];
  for (const e of planned.entities) {
    const old = sourceEntities.get(e.id);
    if (!old && (e.type !== "area" || tombstones.has(e.id))) issues.push("area-id-reused");
    if (old && sha(old) !== sha(e)) issues.push("existing-entity-changed");
  }
  for (const r of planned.relations) {
    const old = sourceRelations.get(r.id);
    if (old && sha(old) !== sha(r)) issues.push("existing-relation-changed");
    if (!outputEntities.has(r.sourceEntityId) || !outputEntities.has(r.targetEntityId)) issues.push("dangling-relation");
  }
  for (const id of sourceEntities.keys()) if (!outputEntities.has(id)) issues.push("entity-lost");
  for (const [id, r] of sourceRelations) {
    if (!outputRelations.has(id) && (!removed.has(id) || r.relationType !== "belongs_to_area"))
      issues.push("unexpected-relation-loss");
  }
  for (const id of removed) if (outputRelations.has(id) || !sourceRelations.has(id)) issues.push("bad-redundancy-audit");
  if (!planned.report.unchangedWorkspaceIds) issues.push("workspace-moved");
  if (source.entities.length + planned.report.createdAreaIds.length !== planned.entities.length ||
      source.relations.length + planned.report.addedRelationIds.length +
      planned.report.addedLegacyProjectRelationIds.length - removed.size !== planned.relations.length)
    issues.push("count-mismatch");
  if (issues.length) throw new AreaNormalizationBlocked([...new Set(issues)]);
  const targetSha256 = areaSnapshotSha256(planned);
  return {
    sourceSha256, targetSha256, revision: identity.revision, restoreGeneration: identity.restoreGeneration,
    at, before: planned.report.before, after: planned.report.after,
    addedAreas: planned.report.createdAreaIds.length,
    addedRelations: planned.report.addedRelationIds.length + planned.report.addedLegacyProjectRelationIds.length,
    removedRelations: removed.size, inheritedTasks: planned.report.inheritedTaskIds.length,
    noChanges: sourceSha256 === targetSha256,
  };
}
// Must be rerun INSIDE a future application's write transaction, under the same lock.
export function verifyAreaPreflight(source: AreaNormalizationSnapshot, identity: AreaSourceIdentity, expected: AreaPreflight) {
  if (!validIdentity(identity) || identity.revision !== expected.revision ||
      identity.restoreGeneration !== expected.restoreGeneration ||
      areaSnapshotSha256(source) !== expected.sourceSha256)
    throw new AreaNormalizationBlocked(["preflight-source-drift"]);
  const current = createAreaPreflight(source, identity, expected.at);
  if (sha(current) !== sha(expected)) throw new AreaNormalizationBlocked(["preflight-plan-drift"]);
  return current;
}
