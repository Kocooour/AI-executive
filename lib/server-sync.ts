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

  for (const entity of localEntities) {
    if (deletedIds.has(entity.id)) continue;
    const current = entities.get(entity.id);
    if (!current || entity.updatedAt > current.updatedAt) {
      entities.set(entity.id, entity);
    }
  }

  const relations = new Map<string, Relation>();
  for (const relation of [...server.relations, ...localRelations]) {
    const { sourceEntityId, targetEntityId } = relation;
    if (!entities.has(sourceEntityId) || !entities.has(targetEntityId)) continue;
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
