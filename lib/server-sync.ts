import type { Entity, Relation } from "./db";

export interface ServerSnapshot {
  revision: number;
  entities: Entity[];
  relations: Relation[];
  tombstones?: Array<{ id: string; deletedAt: number }>;
  updatedAt: number;
}

export function mergeSnapshots(
  server: ServerSnapshot,
  localEntities: Entity[],
  localRelations: Relation[],
) {
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
