import type { Entity, Relation } from "./db";

// What the server accepts as a record (the entity checks in lib/server-store.ts). A record it
// would refuse makes the server refuse the whole save, so such a record is held back on this
// device instead: everything else is sent, and the record is shown to be fixed or removed.
export function isSendable(entity: Entity) {
  return Boolean(entity) &&
    typeof entity.id === "string" && entity.id.length > 0 && entity.id.length <= 240 &&
    typeof entity.title === "string" && entity.title.length > 0 && entity.title.length <= 1000 &&
    (entity.content === undefined || (typeof entity.content === "string" && entity.content.length <= 100_000)) &&
    typeof entity.status === "string" && entity.status.length <= 40 &&
    typeof entity.workspaceId === "string" && entity.workspaceId.length <= 120 &&
    Boolean(entity.properties) && typeof entity.properties === "object" && !Array.isArray(entity.properties) &&
    JSON.stringify(entity.properties).length <= 250_000 &&
    Number.isFinite(entity.createdAt) && Number.isFinite(entity.updatedAt);
}

// Splits the local copy into what can be sent and what is held back. A held-back record that the
// server already knows (it is in `base`, the common version) is sent in that known form, so the
// save does not remove it; one the server never had is left out with its relations.
export function forServer(entities: Entity[], relations: Relation[], base: { entities: Entity[] } | null) {
  const known = new Map((base?.entities || []).map((entity) => [entity.id, entity]));
  const heldBack: Entity[] = [];
  const sent: Entity[] = [];
  for (const entity of entities) {
    if (isSendable(entity)) { sent.push(entity); continue; }
    heldBack.push(entity);
    const previous = known.get(entity.id);
    if (previous && isSendable(previous)) sent.push(previous);
  }
  if (!heldBack.length) return { entities, relations, heldBack };
  const ids = new Set(sent.map((entity) => entity.id));
  return { entities: sent, relations: relations.filter((relation) => ids.has(relation.sourceEntityId) && ids.has(relation.targetEntityId)), heldBack };
}

// The records of the local copy that are not in `base` as they are here: changes not sent yet.
export function unsentIds(entities: Entity[], base: { entities: Entity[] } | null) {
  if (!base) return new Set<string>();
  const known = new Map(base.entities.map((entity) => [entity.id, entity.updatedAt]));
  return new Set(entities.filter((entity) => entity.type !== "workspace" && known.get(entity.id) !== entity.updatedAt).map((entity) => entity.id));
}
