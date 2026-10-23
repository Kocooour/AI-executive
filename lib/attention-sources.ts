import type { Entity, Relation } from "./db";

// What the sources of an attention item are, for a person: the records of the item's workspace by
// name, confirmed context claims as one count, and how many records are not on this device. The
// links between a project and its tasks are left out, because the tasks themselves are listed.
export function describeAttentionSources(sourceIds: string[], workspaceId: string, items: Entity[], relations: Relation[]) {
  const records: Entity[] = [];
  let claims = 0, missing = 0;
  for (const id of new Set(sourceIds)) {
    if (id.startsWith("claim:")) { claims += 1; continue; }
    const record = items.find((item) => item.id === id && item.workspaceId === workspaceId);
    if (record) records.push(record);
    else if (!relations.some((relation) => relation.id === id && relation.workspaceId === workspaceId)) missing += 1;
  }
  return { records, claims, missing };
}
