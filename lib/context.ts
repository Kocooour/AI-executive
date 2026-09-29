import { db, type Entity, type Relation } from "./db";

export interface ContextBundle {
  focus: Entity;
  related: Entity[];
  relations: Relation[];
  summary: { tasks: number; notes: number; projects: number; areas: number };
}

export async function buildContext(
  entityId: string,
  depth = 1,
): Promise<ContextBundle | null> {
  const focus = await db.entities.get(entityId);
  if (!focus || focus.type === "workspace") return null;
  const allRelations = (await db.relations.toArray()).filter(
    (relation) => relation.workspaceId === focus.workspaceId,
  );
  const ids = new Set<string>([entityId]);
  let frontier = new Set<string>([entityId]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const relation of allRelations) {
      if (
        frontier.has(relation.sourceEntityId) ||
        frontier.has(relation.targetEntityId)
      ) {
        if (!ids.has(relation.sourceEntityId)) next.add(relation.sourceEntityId);
        if (!ids.has(relation.targetEntityId)) next.add(relation.targetEntityId);
        ids.add(relation.sourceEntityId);
        ids.add(relation.targetEntityId);
      }
    }
    frontier = next;
  }
  const related = (
    await db.entities.bulkGet([...ids].filter((id) => id !== entityId))
  ).filter(
    (entity): entity is Entity =>
      Boolean(entity) && entity?.workspaceId === focus.workspaceId,
  );
  const relations = allRelations.filter(
    (relation) =>
      ids.has(relation.sourceEntityId) && ids.has(relation.targetEntityId),
  );
  return {
    focus,
    related,
    relations,
    summary: {
      tasks: related.filter((entity) => entity.type === "task").length,
      notes: related.filter((entity) => entity.type === "note").length,
      projects: related.filter((entity) => entity.type === "project").length,
      areas: related.filter((entity) => entity.type === "area").length,
    },
  };
}
