// 2a: deterministic, offline-only preparation. Do not use this as an authorization
// resolver or write it to a live store until the migration/sync review is complete.
import { createHash } from "node:crypto";
import type { Entity, Relation } from "./db";

export interface AreaNormalizationSnapshot {
  entities: readonly Entity[];
  relations: readonly Relation[];
}

export interface AreaNormalizationReport {
  before: { entities: number; relations: number };
  after: { entities: number; relations: number };
  createdAreaIds: string[];
  addedRelationIds: string[];
  addedLegacyProjectRelationIds: string[];
  removedRedundantRelationIds: string[];
  inheritedTaskIds: string[];
  // Existing legacy Area entities are left untouched; a future transactional
  // applicator MUST backfill these kinds before enabling Area authorization.
  existingAreaKindBackfillIds: string[];
  areaKindBackfillRequired: boolean;
  unchangedWorkspaceIds: boolean;
}

export class AreaNormalizationBlocked extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("Area normalization blocked");
    this.name = "AreaNormalizationBlocked";
    this.issues = issues;
  }
}

const displayLabel = (label: string) => label.trim().normalize("NFC").replace(/\s+/g, " ");
const normalizedLabel = (label: string) => displayLabel(label).toLocaleLowerCase("cs");
const digest = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
const generatedAreaId = (workspaceId: string, label: string) =>
  "area:2a:" + digest(workspaceId, normalizedLabel(label));
const generatedRelationId = (entityId: string, areaId: string) =>
  "relation:2a:" + digest(entityId, areaId);

function textId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Prepare an auditable 2a snapshot transformation without touching storage.
 *
 * - workspaceId and every pre-existing entity's ID/revision/timestamps stay intact;
 * - project tasks inherit their project's Area, never keep a task-level Area link;
 * - project and standalone-task missing Areas receive one workspace-local fallback;
 * - legacy free-text labels are NOT interpreted as consent to share;
 * - inconsistent project/Area relationships fail closed rather than guessing.
 *
 * The return value is a proposal only: the caller must review its report and
 * separately apply it under a backed-up, versioned, offline migration protocol.
 */
export function planAreaNormalization(
  snapshot: AreaNormalizationSnapshot,
  at: number,
): { entities: Entity[]; relations: Relation[]; report: AreaNormalizationReport } {
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new AreaNormalizationBlocked(["invalid-migration-timestamp"]);
  }
  const issues: string[] = [];
  const original = new Map<string, Entity>();
  // The Personal workspace can be implicit in a legacy snapshot, but any
  // explicit workspace record must have its canonical ID and unique scope.
  const workspaceKind = new Map<string, "personal" | "shared">([["personal", "personal"]]);
  const explicitWorkspaceIds = new Set<string>();
  for (const entity of snapshot.entities) {
    if (original.has(entity.id)) issues.push("duplicate-entity-id:" + entity.id);
    original.set(entity.id, entity);
    if (entity.type === "workspace") {
      if (entity.id !== "workspace:" + entity.workspaceId) {
        issues.push("noncanonical-workspace-id:" + entity.id);
      }
      if (explicitWorkspaceIds.has(entity.workspaceId)) {
        issues.push("duplicate-workspace:" + entity.workspaceId);
      }
      explicitWorkspaceIds.add(entity.workspaceId);
      const kind = entity.properties.kind;
      if (kind !== "personal" && kind !== "shared") {
        issues.push("invalid-workspace-kind:" + entity.id);
      } else if (entity.workspaceId === "personal" && kind !== "personal") {
        issues.push("personal-workspace-kind-mismatch");
      } else if (entity.workspaceId !== "personal" && kind !== "shared") {
        issues.push("nonpersonal-workspace-kind-mismatch:" + entity.id);
      } else {
        workspaceKind.set(entity.workspaceId, kind);
      }
    }
  }
  const areas = new Map<string, Entity>();
  const existingAreaKindBackfillIds: string[] = [];
  const preferredTitles = new Map<string, string>();
  const projectIds = new Set<string>();
  for (const entity of snapshot.entities) {
    if (!workspaceKind.has(entity.workspaceId)) {
      issues.push("unknown-workspace:" + entity.id);
    }
    if (entity.type === "project" || entity.type === "task") {
      // A present but malformed reference must not silently turn an inherited
      // Area into a standalone fallback. Missing/null/blank legacy values are
      // the only backward-compatible "unassigned" representations.
      const referenceKeys = entity.type === "task" ? ["areaId", "projectId"] : ["areaId"];
      for (const key of referenceKeys) {
        const value = entity.properties[key];
        if (value !== undefined && value !== null && typeof value !== "string") {
          issues.push("invalid-legacy-reference:" + entity.id + ":" + key);
        }
      }
      const label = entity.properties.area;
      if (label !== undefined && label !== null && typeof label !== "string") {
        issues.push("invalid-legacy-area-label:" + entity.id);
      } else if (typeof label === "string" && label.trim()) {
        const preferred = displayLabel(label);
        if (preferred.length > 1000) {
          issues.push("invalid-area-label-length:" + entity.id);
        } else {
          const key = entity.workspaceId + "\0" + normalizedLabel(label);
          const previous = preferredTitles.get(key);
          // The first entity in a snapshot is not necessarily the same on
          // every device. Pick a stable display variant from ALL labels.
          if (previous === undefined || preferred < previous) preferredTitles.set(key, preferred);
        }
      }
    }
    if (entity.type === "area") {
      const expectedKind = workspaceKind.get(entity.workspaceId) === "personal" ? "private" : "shared";
      const existingKind = entity.properties.kind;
      // An explicitly classified Area must never disagree with its legacy
      // workspace. Older Areas without this property retain their old data.
      if (existingKind === undefined) {
        existingAreaKindBackfillIds.push(entity.id);
      } else if (existingKind !== expectedKind) {
        issues.push("area-visibility-mismatch:" + entity.id);
      }
      areas.set(entity.id, entity);
    }
    if (entity.type === "project") projectIds.add(entity.id);
  }
  const bySource = new Map<string, Relation[]>();
  const relationIds = new Set<string>();
  for (const relation of snapshot.relations) {
    if (relationIds.has(relation.id)) issues.push("duplicate-relation-id:" + relation.id);
    relationIds.add(relation.id);
    const source = original.get(relation.sourceEntityId);
    const target = original.get(relation.targetEntityId);
    if (!source || !target || source.workspaceId !== target.workspaceId || relation.workspaceId !== source.workspaceId) {
      issues.push("invalid-scope-relation:" + relation.id);
      continue;
    }
    if (relation.relationType !== "belongs_to_area" && relation.relationType !== "belongs_to_project") continue;
    if ((relation.relationType === "belongs_to_area" && target.type !== "area")
      || (relation.relationType === "belongs_to_project" && target.type !== "project")) {
      issues.push("invalid-relation-target:" + relation.id);
    }
    const list = bySource.get(relation.sourceEntityId) ?? [];
    list.push(relation);
    bySource.set(relation.sourceEntityId, list);
  }
  if (issues.length) throw new AreaNormalizationBlocked(issues);

  const newAreas = new Map<string, Entity>();
  const areaLabelIndex = new Map<string, Entity[]>();
  const areaList = () => [...areas.values(), ...newAreas.values()];
  const areaById = (id: string) => areas.get(id) ?? newAreas.get(id);
  const byWorkspaceLabel = (workspaceId: string, label: string) => {
    const key = workspaceId + "\0" + normalizedLabel(label);
    if (!areaLabelIndex.has(key)) {
      areaLabelIndex.set(key, areaList().filter((entity) =>
        entity.workspaceId === workspaceId && normalizedLabel(entity.title) === normalizedLabel(label)));
    }
    return areaLabelIndex.get(key) ?? [];
  };
  function createArea(workspaceId: string, label: string): Entity | undefined {
    const existing = byWorkspaceLabel(workspaceId, label);
    if (existing.length > 1) {
      issues.push("ambiguous-area-label:" + workspaceId);
      return undefined;
    }
    if (existing.length === 1) return existing[0];
    const key = workspaceId + "\0" + normalizedLabel(label);
    const defaultTitle = workspaceKind.get(workspaceId) === "shared"
      ? "Nezařazeno (původní sdílené)" : "Nezařazeno";
    const title = normalizedLabel(label) === normalizedLabel(defaultTitle)
      ? defaultTitle : (preferredTitles.get(key) ?? displayLabel(label));
    if (!title || title.length > 1000) {
      issues.push("invalid-generated-area-title:" + workspaceId);
      return undefined;
    }
    const id = generatedAreaId(workspaceId, label);
    const earlier = original.get(id);
    if (earlier || newAreas.has(id)) {
      issues.push("generated-area-id-collision:" + id);
      return undefined;
    }
    const kind = workspaceKind.get(workspaceId);
    if (!kind) {
      issues.push("unknown-workspace-for-area:" + workspaceId);
      return undefined;
    }
    const area: Entity = {
      id, type: "area", title, status: "active", workspaceId,
      properties: { kind: kind === "personal" ? "private" : "shared" },
      createdAt: at, updatedAt: at,
    };
    newAreas.set(id, area);
    areaLabelIndex.set(workspaceId + "\0" + normalizedLabel(label), [area]);
    return area;
  }
  function explicitArea(entity: Entity): Entity | undefined {
    const links = (bySource.get(entity.id) ?? []).filter((relation) => relation.relationType === "belongs_to_area");
    const targets = new Set(links.map((relation) => relation.targetEntityId));
    const propertyId = textId(entity.properties.areaId);
    if (propertyId) targets.add(propertyId);
    if (targets.size > 1) {
      issues.push("ambiguous-area:" + entity.id);
      return undefined;
    }
    const target = [...targets][0];
    if (target) {
      const area = areaById(target);
      if (!area || area.workspaceId !== entity.workspaceId) {
        issues.push("invalid-area-reference:" + entity.id);
        return undefined;
      }
      const label = textId(entity.properties.area);
      if (label && normalizedLabel(label) !== normalizedLabel(area.title)) {
        issues.push("conflicting-legacy-area-label:" + entity.id);
      }
      return area;
    }
    const label = textId(entity.properties.area);
    return label ? createArea(entity.workspaceId, label) : undefined;
  }
  const fallback = (workspaceId: string) =>
    createArea(workspaceId, workspaceKind.get(workspaceId) === "shared"
      ? "Nezařazeno (původní sdílené)" : "Nezařazeno");

  const projectAreas = new Map<string, Entity>();
  for (const entity of snapshot.entities) {
    if (entity.type !== "project") continue;
    const area = explicitArea(entity) ?? (issues.length ? undefined : fallback(entity.workspaceId));
    if (area) projectAreas.set(entity.id, area);
  }

  const addedRelations: Relation[] = [];
  const addedLegacyProjectRelations: Relation[] = [];
  const removed = new Set<string>();
  const inherited: string[] = [];
  function linkEntity(entity: Entity, area: Entity | undefined, inherits: boolean) {
    if (!area) return;
    // Historical archived records can keep their old Area, but no live item
    // may acquire (or retain as a proposed canonical assignment) an archived
    // Area. Never silently create a similarly named replacement.
    if (area.status === "archived" && entity.status !== "archived") {
      issues.push("archived-area-for-active-item:" + entity.id + ":" + area.id);
      return;
    }
    const areaLinks = (bySource.get(entity.id) ?? []).filter((relation) => relation.relationType === "belongs_to_area");
    if (inherits) {
      // The canonical Area of a project task is its project's Area. An equal
      // legacy direct link is redundant; a different one must never be dropped.
      const local = explicitArea(entity);
      if (issues.length) return;
      if (local && local.id !== area.id) {
        issues.push("project-task-area-disagrees:" + entity.id);
        return;
      }
      for (const relation of areaLinks) removed.add(relation.id);
      inherited.push(entity.id);
      return;
    }
    if (areaLinks.length) {
      // Retain the oldest canonical relation; break timestamp ties by ID.
      // The source snapshot may arrive in a different order on another device.
      const [primary, ...duplicates] = [...areaLinks].sort((a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (primary.targetEntityId !== area.id) {
        issues.push("unexpected-area-link:" + entity.id);
        return;
      }
      for (const relation of duplicates) removed.add(relation.id);
      return;
    }
    const id = generatedRelationId(entity.id, area.id);
    if (relationIds.has(id) || addedRelations.some((relation) => relation.id === id)) {
      issues.push("generated-relation-id-collision:" + id);
      return;
    }
    addedRelations.push({
      id, workspaceId: entity.workspaceId, sourceEntityId: entity.id,
      targetEntityId: area.id, relationType: "belongs_to_area", createdAt: at,
    });
  }
  for (const entity of snapshot.entities) {
    if (entity.type === "project") {
      linkEntity(entity, projectAreas.get(entity.id), false);
      continue;
    }
    if (entity.type !== "task") continue;
    const projectLinks = (bySource.get(entity.id) ?? [])
      .filter((relation) => relation.relationType === "belongs_to_project")
      .map((relation) => relation.targetEntityId);
    const oldProject = textId(entity.properties.projectId);
    const possibleProjects = new Set([...projectLinks, ...(oldProject ? [oldProject] : [])]);
    if (possibleProjects.size > 1) {
      issues.push("ambiguous-task-project:" + entity.id);
      continue;
    }
    const projectId = [...possibleProjects][0];
    if (projectId) {
      const project = original.get(projectId);
      if (!project || !projectIds.has(projectId) || project.workspaceId !== entity.workspaceId) {
        issues.push("invalid-task-project:" + entity.id);
        continue;
      }
      // A legacy property-only project membership must not disappear when
      // normalization becomes the canonical relational representation.
      if (oldProject && projectLinks.length === 0) {
        const id = "relation:2a:" + digest("project", entity.id, projectId);
        if (relationIds.has(id) || addedLegacyProjectRelations.some((relation) => relation.id === id)) {
          issues.push("generated-project-relation-id-collision:" + id);
          continue;
        }
        addedLegacyProjectRelations.push({
          id, workspaceId: entity.workspaceId, sourceEntityId: entity.id,
          targetEntityId: projectId, relationType: "belongs_to_project", createdAt: at,
        });
      }
      linkEntity(entity, projectAreas.get(projectId), true);
    } else {
      const area = explicitArea(entity) ?? (issues.length ? undefined : fallback(entity.workspaceId));
      linkEntity(entity, area, false);
    }
  }

  if (issues.length) throw new AreaNormalizationBlocked([...new Set(issues)]);
  const entities = [...snapshot.entities, ...[...newAreas.values()].sort((a,b) => a.id.localeCompare(b.id))];
  const relations = [...snapshot.relations.filter((relation) => !removed.has(relation.id)),
    ...[...addedRelations, ...addedLegacyProjectRelations].sort((a,b) => a.id.localeCompare(b.id))];
  const oldWorkspaceIds = snapshot.entities.map((entity) => [entity.id, entity.workspaceId]);
  const newById = new Map(entities.map((entity) => [entity.id, entity.workspaceId]));
  return {
    entities, relations,
    report: {
      before: { entities: snapshot.entities.length, relations: snapshot.relations.length },
      after: { entities: entities.length, relations: relations.length },
      createdAreaIds: [...newAreas.keys()].sort(),
      addedRelationIds: addedRelations.map((relation) => relation.id).sort(),
      addedLegacyProjectRelationIds: addedLegacyProjectRelations.map((relation) => relation.id).sort(),
      removedRedundantRelationIds: [...removed].sort(),
      inheritedTaskIds: inherited.sort(),
      existingAreaKindBackfillIds: existingAreaKindBackfillIds.sort(),
      areaKindBackfillRequired: existingAreaKindBackfillIds.length > 0,
      unchangedWorkspaceIds: oldWorkspaceIds.every(([id, workspace]) => newById.get(id) === workspace),
    },
  };
}
