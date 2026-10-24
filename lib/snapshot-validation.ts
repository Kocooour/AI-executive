// Shared, storage-free structural validation for canonical store records.
// Keep the rules identical for live store writes and offline migration audits.
import { DECISIONS_PROPERTY, validDecisionsValue } from "./calendar-decisions";
import { validProjectContext } from "./project-context";
import type { Entity, Relation } from "./db";

export interface CanonicalRecordSnapshot {
  entities: Entity[];
  relations: Relation[];
  tombstones?: Array<{ id: string; deletedAt: number }>;
}

export function validateSnapshotStructure(snapshot: unknown): asserts snapshot is CanonicalRecordSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid snapshot");
  const value = snapshot as Partial<CanonicalRecordSnapshot>;
  if (!Array.isArray(value.entities) || !Array.isArray(value.relations)) {
    throw new Error("Snapshot does not contain entity and relation arrays");
  }
  const entityIds = new Set<string>();
  const allowedEntityTypes = new Set([
    "area",
    "project",
    "task",
    "note",
    "workspace",
  ]);
  for (const entity of value.entities) {
    if (
      !entity ||
      typeof entity.id !== "string" ||
      entity.id.length === 0 ||
      entity.id.length > 240 ||
      typeof entity.type !== "string" ||
      !allowedEntityTypes.has(entity.type) ||
      typeof entity.title !== "string" ||
      entity.title.length === 0 ||
      entity.title.length > 1000 ||
      (entity.content !== undefined &&
        (typeof entity.content !== "string" || entity.content.length > 100000)) ||
      typeof entity.status !== "string" ||
      entity.status.length > 40 ||
      typeof entity.workspaceId !== "string" ||
      entity.workspaceId.length > 120 ||
      !entity.properties ||
      typeof entity.properties !== "object" ||
      Array.isArray(entity.properties) ||
      JSON.stringify(entity.properties).length > 250000 ||
      typeof entity.createdAt !== "number" ||
      !Number.isFinite(entity.createdAt) ||
      typeof entity.updatedAt !== "number" ||
      !Number.isFinite(entity.updatedAt)
    ) {
      throw new Error("Snapshot contains an invalid entity");
    }
    // Match the project-context constraint introduced on main by PR #104.
    // Old projects with no context remain supported, but malformed present
    // context must be refused by both live store and offline 2a preflight.
    if (entity.type === "project" && entity.properties.context !== undefined && !validProjectContext(entity.properties.context)) {
      throw new Error("Snapshot contains an invalid entity");
    }
    if (entityIds.has(entity.id)) throw new Error("Snapshot contains duplicate entity IDs");
    entityIds.add(entity.id);
  }
  const workspaceIds = new Set(
    value.entities
      .filter((entity) => entity.type === "workspace")
      .map((entity) => entity.workspaceId),
  );
  const workspaceEntities = value.entities.filter(
    (entity) => entity.type === "workspace",
  );
  if (
    new Set(workspaceEntities.map((entity) => entity.workspaceId)).size !==
    workspaceEntities.length
  ) {
    throw new Error("Snapshot contains duplicate workspace IDs");
  }
  for (const workspace of workspaceEntities) {
    if (
      workspace.id !== `workspace:${workspace.workspaceId}` ||
      workspace.title.trim().length === 0 ||
      workspace.title.length > 120 ||
      !["personal", "shared"].includes(String(workspace.properties.kind)) ||
      workspace.properties.role !== "owner" ||
      !Array.isArray(workspace.properties.members) ||
      !validDecisionsValue(workspace.properties[DECISIONS_PROPERTY])
    ) {
      throw new Error("Snapshot contains an invalid workspace");
    }
  }
  workspaceIds.add("personal");
  if (
    value.entities.some(
      (entity) =>
        entity.type !== "workspace" && !workspaceIds.has(entity.workspaceId),
    )
  ) {
    throw new Error("Snapshot contains an entity in an unknown workspace");
  }
  const entitiesById = new Map(
    value.entities.map((entity) => [entity.id, entity]),
  );
  const relationIds = new Set<string>();
  for (const relation of value.relations) {
    if (
      !relation ||
      typeof relation.id !== "string" ||
      relation.id.length === 0 ||
      relation.id.length > 240 ||
      typeof relation.sourceEntityId !== "string" ||
      relation.sourceEntityId.length > 240 ||
      typeof relation.targetEntityId !== "string" ||
      relation.targetEntityId.length > 240 ||
      typeof relation.relationType !== "string" ||
      relation.relationType.length === 0 ||
      relation.relationType.length > 120 ||
      typeof relation.workspaceId !== "string" ||
      relation.workspaceId.length > 120 ||
      typeof relation.createdAt !== "number" ||
      !Number.isFinite(relation.createdAt)
    ) {
      throw new Error("Snapshot contains an invalid relation");
    }
    if (relationIds.has(relation.id)) throw new Error("Snapshot contains duplicate relation IDs");
    if (
      !entityIds.has(relation.sourceEntityId) ||
      !entityIds.has(relation.targetEntityId)
    ) {
      throw new Error("Snapshot contains a relation to a missing entity");
    }
    const source = entitiesById.get(relation.sourceEntityId);
    const target = entitiesById.get(relation.targetEntityId);
    if (
      !source ||
      !target ||
      source.workspaceId !== target.workspaceId ||
      relation.workspaceId !== source.workspaceId
    ) {
      throw new Error("Snapshot contains a cross-workspace relation");
    }
    relationIds.add(relation.id);
  }
  if (value.tombstones !== undefined) {
    if (!Array.isArray(value.tombstones)) throw new Error("Snapshot tombstones are invalid");
    const tombstoneIds = new Set<string>();
    for (const tombstone of value.tombstones) {
      if (
        !tombstone ||
        typeof tombstone.id !== "string" ||
        tombstone.id.length === 0 ||
        tombstone.id.length > 240 ||
        typeof tombstone.deletedAt !== "number" ||
        !Number.isFinite(tombstone.deletedAt)
      ) {
        throw new Error("Snapshot contains an invalid tombstone");
      }
      // Canonical SQLite tombstones have a unique primary key. A deleted ID
      // also cannot remain present as a live entity or relation: the sync
      // write path filters such entities and their links before persisting.
      if (tombstoneIds.has(tombstone.id)) {
        throw new Error("Snapshot contains duplicate tombstone IDs");
      }
      if (entityIds.has(tombstone.id) || relationIds.has(tombstone.id)) {
        throw new Error("Snapshot tombstone overlaps a live record");
      }
      tombstoneIds.add(tombstone.id);
    }
  }
}
