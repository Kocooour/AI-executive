import type { Entity, Relation } from "./db";

export interface ServerSnapshot {
  revision: number;
  entities: Entity[];
  relations: Relation[];
  updatedAt: number;
}

const entityKey = (entity: Entity) =>
  [entity.workspaceId, entity.type, entity.title.trim().toLowerCase()].join("|");

export function mergeSnapshots(
  server: ServerSnapshot,
  localEntities: Entity[],
  localRelations: Relation[],
) {
  const entities = new Map(server.entities.map((entity) => [entity.id, entity]));
  const keys = new Map(
    server.entities.map((entity) => [entityKey(entity), entity.id]),
  );
  const remappedIds = new Map<string, string>();

  for (const entity of localEntities) {
    const sameId = entities.get(entity.id);
    const matchingId = keys.get(entityKey(entity));
    const canonicalId = sameId ? entity.id : matchingId || entity.id;
    const current = entities.get(canonicalId);
    remappedIds.set(entity.id, canonicalId);
    if (!current || entity.updatedAt > current.updatedAt) {
      entities.set(canonicalId, { ...entity, id: canonicalId });
      keys.set(entityKey(entity), canonicalId);
    }
  }

  const relations = new Map<string, Relation>();
  for (const relation of [...server.relations, ...localRelations]) {
    const sourceEntityId =
      remappedIds.get(relation.sourceEntityId) || relation.sourceEntityId;
    const targetEntityId =
      remappedIds.get(relation.targetEntityId) || relation.targetEntityId;
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

