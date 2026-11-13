import type { Entity, Relation } from "./db";
import type { RestoreKind } from "./restore-generation-origin";
import { limitConflicts, mergeEntity, mergeRelations, withConflicts } from "./field-merge";

export interface ServerSnapshot {
  revision: number;
  // See StoreSnapshot.restoreGeneration (lib/server-store.ts); `code: "restored"` marks the refusal of a save made before a restore.
  restoreGeneration?: number;
  restoreKind?: RestoreKind;
  code?: string;
  entities: Entity[];
  relations: Relation[];
  tombstones?: Array<{ id: string; deletedAt: number }>;
  updatedAt: number;
}

// The version of the data this device last had in common with the server (see field-merge.ts).
export interface SyncBase {
  entities: Entity[];
  relations: Relation[];
}

export function mergeSnapshots(
  server: ServerSnapshot,
  localEntities: Entity[],
  localRelations: Relation[],
  base?: SyncBase | null,
) {
  if (base) return mergeWithBase(server, localEntities, localRelations, base);
  const deletedIds = new Set((server.tombstones || []).map((item) => item.id));
  const entities = new Map(
    server.entities
      .filter((entity) => !deletedIds.has(entity.id))
      .map((entity) => [entity.id, entity]),
  );
  const serverEntities = new Map(
    server.entities.map((entity) => [entity.id, entity]),
  );
  const localEntitiesById = new Map(
    localEntities.map((entity) => [entity.id, entity]),
  );

  for (const entity of localEntities) {
    if (deletedIds.has(entity.id)) continue;
    const current = entities.get(entity.id);
    if (!current || entity.updatedAt > current.updatedAt) {
      entities.set(entity.id, entity);
    }
  }

  const relations = new Map<string, Relation>();
  const relationVersion = (entity: Entity | undefined) =>
    Number(entity?.properties.relationsUpdatedAt || 0);
  const localRelationSources = new Set(
    localEntities
      .filter(
        (entity) =>
          relationVersion(entity) > relationVersion(serverEntities.get(entity.id)),
      )
      .map((entity) => entity.id),
  );
  const serverRelationSources = new Set(
    server.entities
      .filter(
        (entity) =>
          relationVersion(entity) >
          relationVersion(localEntitiesById.get(entity.id)),
      )
      .map((entity) => entity.id),
  );
  for (const [entityId, entity] of entities) {
    const winningRelationVersion = Math.max(
      relationVersion(serverEntities.get(entityId)),
      relationVersion(localEntitiesById.get(entityId)),
    );
    if (
      winningRelationVersion >
      Number(entity.properties.relationsUpdatedAt || 0)
    ) {
      entities.set(entityId, {
        ...entity,
        properties: {
          ...entity.properties,
          relationsUpdatedAt: winningRelationVersion,
        },
      });
    }
  }
  const mergeableServerRelations = server.relations.filter(
    (relation) => !localRelationSources.has(relation.sourceEntityId),
  );
  const mergeableLocalRelations = localRelations.filter(
    (relation) => !serverRelationSources.has(relation.sourceEntityId),
  );
  for (const relation of [
    ...mergeableServerRelations,
    ...mergeableLocalRelations,
  ]) {
    const { sourceEntityId, targetEntityId } = relation;
    if (deletedIds.has(relation.id)) continue;
    if (!entities.has(sourceEntityId) || !entities.has(targetEntityId)) continue;
    const source = entities.get(sourceEntityId);
    const target = entities.get(targetEntityId);
    if (
      !source ||
      !target ||
      source.workspaceId !== target.workspaceId ||
      relation.workspaceId !== source.workspaceId
    ) {
      continue;
    }
    const key = `${sourceEntityId}|${targetEntityId}|${relation.relationType}`;
    if (!relations.has(key)) {
      relations.set(key, {
        ...relation,
        sourceEntityId,
        targetEntityId,
      });
    }
  }

  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
  };
}

// Field-level merge against the common version. A record without a common version (created on
// one side, or a device that has never synchronized) falls back to the newer record.
function mergeWithBase(server: ServerSnapshot, localEntities: Entity[], localRelations: Relation[], base: SyncBase) {
  const now = Date.now();
  const deletedIds = new Set((server.tombstones || []).map((item) => item.id));
  const baseEntities = new Map(base.entities.map((entity) => [entity.id, entity]));
  const entities = new Map(
    server.entities.filter((entity) => !deletedIds.has(entity.id)).map((entity) => [entity.id, entity]),
  );
  for (const local of localEntities) {
    if (deletedIds.has(local.id)) continue;
    const current = entities.get(local.id);
    const common = baseEntities.get(local.id);
    if (!current) entities.set(local.id, local);
    else if (common) entities.set(local.id, mergeEntity(common, local, current, now));
    else if (local.updatedAt > current.updatedAt) entities.set(local.id, local);
  }
  const serverEntities = new Map(server.entities.map((entity) => [entity.id, entity]));
  const localById = new Map(localEntities.map((entity) => [entity.id, entity]));
  const relationsVersion = (entity: Entity | undefined) => Number(entity?.properties.relationsUpdatedAt || entity?.updatedAt || 0);
  // A record this device does not have (deleted here, or never loaded) has not had its relations
  // changed here either; only the server's changes apply to it.
  const effectiveLocalRelations = [
    ...localRelations.filter((relation) => localById.has(relation.sourceEntityId)),
    ...base.relations.filter((relation) => !localById.has(relation.sourceEntityId)),
  ];
  const merged = mergeRelations(
    base.relations,
    effectiveLocalRelations,
    server.relations,
    (sourceId) => relationsVersion(localById.get(sourceId)) > relationsVersion(serverEntities.get(sourceId)),
    now,
  );
  for (const [sourceId, conflicts] of merged.conflicts) {
    const entity = entities.get(sourceId);
    if (entity) entities.set(sourceId, withConflicts(entity, conflicts));
  }
  const relations = new Map<string, Relation>();
  for (const relation of merged.relations) {
    if (deletedIds.has(relation.id)) continue;
    const source = entities.get(relation.sourceEntityId);
    const target = entities.get(relation.targetEntityId);
    if (!source || !target || source.workspaceId !== target.workspaceId || relation.workspaceId !== source.workspaceId) continue;
    const key = `${relation.sourceEntityId}|${relation.targetEntityId}|${relation.relationType}`;
    if (!relations.has(key)) relations.set(key, relation);
  }
  return { entities: limitConflicts([...entities.values()]), relations: [...relations.values()] };
}
