// 2a, part 4: every NEW write keeps the Area model normalized, so that the audited 2a applicator
// (lib/area-normalization-apply.ts) can be run once and the state stays normalized afterwards.
//
// One pure, deterministic function, used by every server write path (replaceSnapshot, Inbox batch, AI
// actions, work-session occurrences) and, for its fallback-Area helper, by the client. It acts ONLY on what
// the write itself introduced (`next` compared with `current`); legacy violations the write did not touch are
// left exactly as they are, they belong to the audited applicator.
//
//  R1  a belongs_to_area relation (or properties.areaId) that is new in this write on a task that is in a
//      project is dropped: a project task inherits the Area of its project.
//  R2  a task that gains a project in this write loses ALL its own Area links and properties.areaId.
//  R3  a project / standalone task that is new, or a task that leaves its project, and has no Area gets the
//      workspace's fallback Area (created when missing, with `kind`).
//  R4  an explicit new Area choice replaces previous links, including old ones.
//      Several links that all pre-existed are legacy and stay untouched.
//  R5  an Area entity that is new or changed gets properties.kind = its workspace kind.
//
// Browser-safe: no node-only imports (the client uses planFallbackArea too).
import type { Entity, Relation } from "./db";
import {
  areaKindForWorkspace, displayLabel, fallbackAreaTitle, generatedAreaId, normalizedLabel, writeRelationId,
  type WorkspaceKind,
} from "./area-ids";

export interface AreaWriteState {
  entities: readonly Entity[];
  relations: readonly Relation[];
}

// Counts only: no titles, IDs or other record content.
export interface AreaWriteReport {
  droppedProjectTaskAreaLinks: number;
  tasksInheritingFromProject: number;
  fallbackAssigned: number;
  fallbackAreasCreated: number;
  duplicateAreaLinksDropped: number;
  legacyAreaIdsCanonicalized: number;
  legacyAreaLabelsCanonicalized: number;
  areaKindsRestored: number;
  fallbackUnavailable: number;
}

export interface AreaWriteResult {
  entities: Entity[];
  relations: Relation[];
  // Opaque IDs of relations this function removed; callers record them as deleted (tombstones) so an old
  // client cannot send them back.
  droppedRelationIds: string[];
  report: AreaWriteReport;
  changed: boolean;
}

const textValue = (value: unknown) => typeof value === "string" && value.trim() !== "";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A new invalid Area reference must fail atomically rather than corrupt the 2a preflight. */
export class AreaWriteInvalid extends Error {
  constructor() { super("Invalid Area assignment"); this.name = "AreaWriteInvalid"; }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as object).sort()
      .map((key) => JSON.stringify(key) + ":" + stable((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/** Workspace kind per workspace ID; the implicit Personal workspace counts as personal. */
export function workspaceKinds(entities: readonly Entity[]): Map<string, WorkspaceKind> {
  const kinds = new Map<string, WorkspaceKind>([["personal", "personal"]]);
  for (const entity of entities) {
    if (entity.type !== "workspace") continue;
    const kind = entity.properties.kind;
    if (kind === "personal" || kind === "shared") kinds.set(entity.workspaceId, kind);
    else kinds.delete(entity.workspaceId);
  }
  return kinds;
}

export type FallbackAreaPlan =
  | { status: "existing"; area: Entity }
  | { status: "create"; area: Entity }
  | { status: "unavailable"; reason: "unknown-workspace" | "ambiguous" | "archived" | "tombstoned" | "collision" };

/**
 * The workspace's fallback Area exactly as the 2a planner names and identifies it. An Area with that
 * normalized label is reused when it is the only one in the workspace (and active); otherwise the
 * deterministic planner ID is created, unless it is tombstoned or taken, in which case nothing is created.
 */
export function planFallbackArea(input: {
  workspaceId: string;
  kind: WorkspaceKind | undefined;
  entities: readonly Entity[];
  tombstonedIds: ReadonlySet<string>;
  now: number;
}): FallbackAreaPlan {
  const { workspaceId, kind } = input;
  if (!kind) return { status: "unavailable", reason: "unknown-workspace" };
  const title = fallbackAreaTitle(kind);
  const wanted = normalizedLabel(title);
  const matches = input.entities.filter((entity) =>
    entity.type === "area" && entity.workspaceId === workspaceId && normalizedLabel(entity.title) === wanted);
  if (matches.length > 1) return { status: "unavailable", reason: "ambiguous" };
  if (matches.length === 1) {
    return matches[0].status === "active"
      ? { status: "existing", area: matches[0] }
      : { status: "unavailable", reason: "archived" };
  }
  const id = generatedAreaId(workspaceId, title);
  if (input.tombstonedIds.has(id)) return { status: "unavailable", reason: "tombstoned" };
  if (input.entities.some((entity) => entity.id === id)) return { status: "unavailable", reason: "collision" };
  return {
    status: "create",
    area: {
      id, type: "area", title, status: "active", workspaceId,
      properties: { kind: areaKindForWorkspace(kind) }, createdAt: input.now, updatedAt: input.now,
    },
  };
}

/**
 * The workspace's fallback Area, identified exactly as planFallbackArea does: the deterministic planner ID, or the one
 * active Area with the fallback label. It is the system Area ("Nezařazeno"): deleting or renaming it would block the 2a
 * applicator for good (tombstoned-generated-area-id), so the client refuses to.
 */
export function isFallbackArea(area: Entity, entities: readonly Entity[]): boolean {
  if (area.type !== "area") return false;
  const kind = workspaceKinds(entities).get(area.workspaceId);
  if (!kind) return false;
  const title = fallbackAreaTitle(kind);
  if (area.id === generatedAreaId(area.workspaceId, title)) return true;
  const wanted = normalizedLabel(title);
  const matches = entities.filter((entity) =>
    entity.type === "area" && entity.workspaceId === area.workspaceId && normalizedLabel(entity.title) === wanted);
  return matches.length === 1 && matches[0].id === area.id && area.status === "active";
}

/** An unused deterministic ID for the fallback link (the planner ID first; later ones when it was deleted before). */
export function fallbackRelationId(
  entityId: string,
  areaId: string,
  taken: (id: string) => boolean,
): string | undefined {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = writeRelationId(entityId, areaId, attempt);
    if (!taken(id)) return id;
  }
  return undefined;
}

/**
 * The load-time migration of a legacy `properties.areaId` (migratePropertyRelations in lib/db.ts): a task that is in a
 * project inherits the Area of its project, so the property is dropped WITHOUT creating a task-level link.
 */
export function legacyAreaIdBecomesRelation(entityType: string, inProject: boolean) {
  return !(entityType === "task" && inProject);
}

export function enforceAreaWriteInvariants(input: {
  current: AreaWriteState;
  next: AreaWriteState;
  tombstones: readonly { id: string }[];
  /** Tombstones before this write; a revived old relation is not a new Area choice. */
  previousTombstones?: readonly { id: string }[];
  now: number;
}): AreaWriteResult {
  const { current, next, now } = input;
  const tombstoned = new Set(input.tombstones.map((item) => item.id));
  const previouslyTombstoned = new Set((input.previousTombstones ?? input.tombstones).map((item) => item.id));
  const report: AreaWriteReport = {
    droppedProjectTaskAreaLinks: 0, tasksInheritingFromProject: 0, fallbackAssigned: 0,
    fallbackAreasCreated: 0, duplicateAreaLinksDropped: 0, legacyAreaIdsCanonicalized: 0,
    legacyAreaLabelsCanonicalized: 0,
    areaKindsRestored: 0, fallbackUnavailable: 0,
  };
  const currentEntities = new Map(current.entities.map((entity) => [entity.id, entity]));
  const nextEntities = new Map(next.entities.map((entity) => [entity.id, entity]));
  // A raw full-snapshot write must not rename/archive/delete the system fallback Area.
  // An invalid deletion would tombstone its deterministic ID and permanently block 2a.
  for (const area of current.entities) {
    if (!isFallbackArea(area, current.entities)) continue;
    const after = nextEntities.get(area.id);
    if (!after || after.type !== "area" || after.workspaceId !== area.workspaceId ||
        after.title !== area.title || after.status !== area.status || after.status !== "active" ||
        tombstoned.has(area.id)) throw new AreaWriteInvalid();
  }
  const currentRelations = new Map(current.relations.map((relation) => [relation.id, relation]));
  // The kind of a workspace that already exists comes from the STORED record, so a write cannot redeclare a shared
  // workspace as personal (and get a private "Nezařazeno" in it); only a workspace new in this write uses its own.
  const kinds = workspaceKinds(next.entities);
  const storedKinds = workspaceKinds(current.entities);
  for (const entity of current.entities) {
    if (entity.type !== "workspace") continue;
    const stored = storedKinds.get(entity.workspaceId);
    if (stored) kinds.set(entity.workspaceId, stored); else kinds.delete(entity.workspaceId);
  }

  const entities = new Map<string, Entity>(next.entities.map((entity) => [entity.id, entity]));
  const dropped = new Set<string>();
  const added: Relation[] = [];
  const createdAreas: Entity[] = [];
  // touched entity -> whether its relations changed
  const touched = new Map<string, boolean>();
  const touch = (id: string, relations: boolean) => touched.set(id, (touched.get(id) ?? false) || relations);
  const edit = (id: string, change: (entity: Entity) => Entity) => {
    const entity = entities.get(id);
    if (entity) entities.set(id, change(entity));
  };

  const isNewRelation = (relation: Relation) => {
    const before = currentRelations.get(relation.id);
    return !before || before.sourceEntityId !== relation.sourceEntityId
      || before.targetEntityId !== relation.targetEntityId || before.relationType !== relation.relationType;
  };
  // A task is "in a project" only through a belongs_to_project relation or a projectId whose target is a LIVE project
  // of that snapshot; a dangling reference (deleted project) does not count.
  const projectSources = (relations: readonly Relation[], list: readonly Entity[]) => {
    const live = new Set(list.filter((entity) => entity.type === "project").map((entity) => entity.id));
    const ids = new Set<string>();
    for (const relation of relations) {
      if (relation.relationType === "belongs_to_project" && live.has(relation.targetEntityId)) ids.add(relation.sourceEntityId);
    }
    for (const entity of list) {
      const projectId = entity.properties.projectId;
      if (entity.type === "task" && textValue(projectId) && live.has(String(projectId))) ids.add(entity.id);
    }
    return ids;
  };
  const projectBefore = projectSources(current.relations, current.entities);
  const projectAfter = projectSources(next.relations, next.entities);
  // This write made the project of a task disappear (or created the task with a dangling reference): the reference is
  // removed and the task is a standalone task that gets the fallback Area (R3). Untouched dangling ones are legacy.
  for (const task of next.entities) {
    if (task.type !== "task" || projectAfter.has(task.id) || !textValue(task.properties.projectId)) continue;
    if (!projectBefore.has(task.id) && currentEntities.has(task.id)) continue;
    edit(task.id, (entity) => {
      const properties = { ...entity.properties };
      delete properties.projectId;
      return { ...entity, properties };
    });
    touch(task.id, false);
  }
  const areaLinksOf = new Map<string, Relation[]>();
  for (const relation of next.relations) {
    if (relation.relationType !== "belongs_to_area") continue;
    const list = areaLinksOf.get(relation.sourceEntityId) ?? [];
    list.push(relation);
    areaLinksOf.set(relation.sourceEntityId, list);
  }
  const liveLinks = (id: string) => (areaLinksOf.get(id) ?? []).filter((relation) => !dropped.has(relation.id));
  const drop = (relation: Relation) => {
    dropped.add(relation.id);
    touch(relation.sourceEntityId, true);
  };
  const removeAreaIdProperty = (id: string) => {
    edit(id, (entity) => {
      const properties = { ...entity.properties };
      delete properties.areaId;
      return { ...entity, properties };
    });
    touch(id, false);
  };

  const sortedTasks = next.entities.filter((entity) => entity.type === "task")
    .sort((a, b) => compare(a.id, b.id));

  // R1 / R2: a task in a project has no Area of its own.
  for (const task of sortedTasks) {
    if (!projectAfter.has(task.id)) continue;
    const before = currentEntities.get(task.id);
    const gainsProject = Boolean(before) && !projectBefore.has(task.id);
    const links = liveLinks(task.id);
    const toDrop = gainsProject ? links : links.filter(isNewRelation);
    for (const relation of toDrop) drop(relation);
    const areaIdProperty = task.properties.areaId;
    const propertyIsNew = areaIdProperty !== undefined && (gainsProject || !before || before.properties.areaId !== areaIdProperty);
    if (propertyIsNew) removeAreaIdProperty(task.id);
    // Also strip newly supplied legacy free-text labels: a task that enters a
    // project inherits the project Area even when a legacy client sent a label.
    const areaLabel = task.properties.area;
    const labelIsNew = areaLabel !== undefined && (gainsProject || !before || before.properties.area !== areaLabel);
    if (labelIsNew) {
      edit(task.id, (entity) => {
        const properties = { ...entity.properties };
        delete properties.area;
        return { ...entity, properties };
      });
      touch(task.id, false);
    }
    if (toDrop.length || propertyIsNew || labelIsNew) {
      if (gainsProject) report.tasksInheritingFromProject += 1;
      else report.droppedProjectTaskAreaLinks += toDrop.length + (propertyIsNew ? 1 : 0) + (labelIsNew ? 1 : 0);
    }
  }

  // Canonicalize an areaId newly supplied by a legacy client, but do not touch
  // unchanged historical properties during unrelated writes. A project task has
  // already had its invalid task-level areaId removed by R1/R2 above.
  const takenIds = new Set<string>([
    ...currentRelations.keys(), ...next.relations.map((relation) => relation.id),
    ...entities.keys(), ...tombstoned,
  ]);
  const explicitChoices = new Map<string, string>();
  for (const item of [...next.entities].sort((a, b) => compare(a.id, b.id))) {
    if (item.type !== "project" && (item.type !== "task" || projectAfter.has(item.id))) continue;
    const raw = item.properties.areaId;
    if (raw === undefined) continue;
    const before = currentEntities.get(item.id);
    if (before && before.properties.areaId === raw) continue;
    if (!textValue(raw)) throw new AreaWriteInvalid();
    const area = entities.get(String(raw));
    if (!area || area.type !== "area" || area.workspaceId !== item.workspaceId ||
        area.status !== "active" || tombstoned.has(area.id)) throw new AreaWriteInvalid();
    explicitChoices.set(item.id, area.id);
    if (!liveLinks(item.id).some((link) => link.targetEntityId === area.id)) {
      const id = fallbackRelationId(item.id, area.id, (candidate) => takenIds.has(candidate));
      if (!id) throw new AreaWriteInvalid();
      takenIds.add(id);
      const canonical: Relation = {
        id, workspaceId: item.workspaceId, sourceEntityId: item.id,
        targetEntityId: area.id, relationType: "belongs_to_area", createdAt: now,
      };
      added.push(canonical);
      areaLinksOf.set(item.id, [...(areaLinksOf.get(item.id) ?? []), canonical]);
      touch(item.id, true);
    }
    removeAreaIdProperty(item.id);
    report.legacyAreaIdsCanonicalized += 1;
  }

  // Normalize legacy free-text Areas introduced by new writes. The offline 2a planner
  // uses the same normalizedLabel/generatedAreaId rules; ambiguous or deleted labels
  // fail closed rather than silently leaving a new record requiring migration.
  for (const item of [...next.entities].sort((a, b) => compare(a.id, b.id))) {
    if (item.type !== "project" && (item.type !== "task" || projectAfter.has(item.id))) continue;
    const label = item.properties.area;
    if (label === undefined || label === null) continue;
    const before = currentEntities.get(item.id);
    if (before && before.properties.area === label) continue;
    if (typeof label !== "string" || displayLabel(label).length > 1000) {
      throw new AreaWriteInvalid();
    }
    if (!displayLabel(label)) {
      // The offline planner treats an empty legacy label as unassigned.
      edit(item.id, (entity) => {
        const properties = { ...entity.properties };
        delete properties.area;
        return { ...entity, properties };
      });
      touch(item.id, false);
      continue;
    }
    // An explicit link/ID wins over the obsolete label; R4 and the final cleanup
    // below remove its old property, preserving the user's current explicit choice.
    if (textValue(item.properties.areaId) || liveLinks(item.id).length) continue;
    const matching = [...entities.values(), ...createdAreas].filter((candidate) =>
      candidate.type === "area" && candidate.workspaceId === item.workspaceId &&
      normalizedLabel(candidate.title) === normalizedLabel(label));
    if (matching.length > 1 || matching.some((area) => area.status !== "active")) throw new AreaWriteInvalid();
    let area = matching[0];
    if (!area) {
      const kind = kinds.get(item.workspaceId);
      if (!kind) throw new AreaWriteInvalid();
      const title = displayLabel(label);
      const id = generatedAreaId(item.workspaceId, title);
      if (tombstoned.has(id) || takenIds.has(id)) throw new AreaWriteInvalid();
      area = { id, type: "area", title, status: "active", workspaceId: item.workspaceId,
        properties: { kind: areaKindForWorkspace(kind) }, createdAt: now, updatedAt: now };
      createdAreas.push(area);
      takenIds.add(id);
    }
    const relationId = fallbackRelationId(item.id, area.id, (candidate) => takenIds.has(candidate));
    if (!relationId) throw new AreaWriteInvalid();
    takenIds.add(relationId);
    const canonical: Relation = {
      id: relationId, workspaceId: item.workspaceId, sourceEntityId: item.id,
      targetEntityId: area.id, relationType: "belongs_to_area", createdAt: now,
    };
    added.push(canonical);
    areaLinksOf.set(item.id, [...(areaLinksOf.get(item.id) ?? []), canonical]);
    touch(item.id, true);
    edit(item.id, (entity) => {
      const properties = { ...entity.properties };
      delete properties.area;
      return { ...entity, properties };
    });
    touch(item.id, false);
    report.legacyAreaLabelsCanonicalized += 1;
  }

  // R4: an explicit new Area choice replaces previous links, including older
  // existing links. Multiple pre-existing legacy links are untouched unless
  // this write has introduced a new choice.
  for (const id of [...areaLinksOf.keys()].sort(compare)) {
    const links = liveLinks(id);
    if (links.length < 2) continue;
    const fresh = links.filter((link) => isNewRelation(link) && !previouslyTombstoned.has(link.id));
    const revived = links.filter((link) => previouslyTombstoned.has(link.id) && !currentRelations.has(link.id));
    if (!fresh.length && !revived.length && !explicitChoices.has(id)) continue;
    // The user's new choice wins regardless of clock skew on an old link.
    const stillCurrent = links.filter((link) => currentRelations.has(link.id));
    const candidates = explicitChoices.has(id)
      ? links.filter((link) => link.targetEntityId === explicitChoices.get(id))
      : fresh.length ? fresh : stillCurrent.length ? stillCurrent : revived;
    const newest = [...candidates].sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))[0];
    if (!newest) throw new AreaWriteInvalid();
    for (const relation of links) {
      if (relation.id === newest.id) continue;
      drop(relation);
      report.duplicateAreaLinksDropped += 1;
    }
  }

  // A newly assigned canonical link also supersedes stale legacy areaId/area
  // properties, even if that entity had no previous canonical link at all.
  // Do not change untouched legacy properties in unrelated saves.
  for (const item of [...next.entities].sort((a, b) => compare(a.id, b.id))) {
    if (item.type !== "project" && (item.type !== "task" || projectAfter.has(item.id))) continue;
    if (!explicitChoices.has(item.id) &&
        !liveLinks(item.id).some((link) => isNewRelation(link) && !previouslyTombstoned.has(link.id))) continue;
    const currentItem = entities.get(item.id);
    if (!currentItem || (currentItem.properties.areaId === undefined &&
        currentItem.properties.area === undefined)) continue;
    edit(item.id, (entity) => {
      const properties = { ...entity.properties };
      delete properties.areaId;
      delete properties.area;
      return { ...entity, properties };
    });
    touch(item.id, false);
  }

  // R3: new projects, new standalone tasks and tasks that leave their project get the fallback Area.
  const hasArea = (entity: Entity) =>
    liveLinks(entity.id).length > 0 || textValue(entity.properties.areaId) || textValue(entity.properties.area);
  const needsFallback: Entity[] = [];
  for (const entity of next.entities) {
    if (entity.type === "project") {
      if (!currentEntities.has(entity.id)) needsFallback.push(entity);
    } else if (entity.type === "task" && !projectAfter.has(entity.id)) {
      if (!currentEntities.has(entity.id) || projectBefore.has(entity.id)) needsFallback.push(entity);
    }
  }
  needsFallback.sort((a, b) => compare(a.id, b.id));
  // One fallback decision per workspace (the plan does not depend on the item), made when first needed.
  const fallbackFor = new Map<string, Entity | undefined>();
  const fallbackOf = (workspaceId: string): Entity | undefined => {
    if (fallbackFor.has(workspaceId)) return fallbackFor.get(workspaceId);
    const plan = planFallbackArea({
      workspaceId, kind: kinds.get(workspaceId),
      entities: [...entities.values(), ...createdAreas].filter((item) => item.type === "area"),
      tombstonedIds: tombstoned, now,
    });
    let area: Entity | undefined;
    if (plan.status === "existing") area = plan.area;
    else if (plan.status === "create") {
      area = plan.area;
      createdAreas.push(area);
      report.fallbackAreasCreated += 1;
    }
    fallbackFor.set(workspaceId, area);
    return area;
  };
  for (const entity of needsFallback) {
    if (hasArea(entity)) continue;
    const area = fallbackOf(entity.workspaceId);
    const relationId = area && fallbackRelationId(entity.id, area.id,
      (candidate) => tombstoned.has(candidate) || takenIds.has(candidate) || entities.has(candidate) || candidate === area!.id);
    if (!area || !relationId) {
      report.fallbackUnavailable += 1;
      continue;
    }
    takenIds.add(relationId);
    added.push({
      id: relationId, workspaceId: entity.workspaceId, sourceEntityId: entity.id,
      targetEntityId: area.id, relationType: "belongs_to_area", createdAt: now,
    });
    touch(entity.id, true);
    report.fallbackAssigned += 1;
  }

  // R5: an Area that is new or changed in this write carries its workspace's kind.
  for (const entity of next.entities) {
    if (entity.type !== "area") continue;
    const before = currentEntities.get(entity.id);
    if (before && stable(before) === stable(entity)) continue;
    const kind = kinds.get(entity.workspaceId);
    if (!kind) continue;
    const expected = areaKindForWorkspace(kind);
    if (entity.properties.kind === expected) continue;
    edit(entity.id, (area) => ({ ...area, properties: { ...area.properties, kind: expected } }));
    touch(entity.id, false);
    report.areaKindsRestored += 1;
  }

  // Entities the invariants changed look changed to every device (and win a base-less merge).
  for (const [id, relationsChanged] of [...touched].sort(([a], [b]) => compare(a, b))) {
    edit(id, (entity) => ({
      ...entity,
      updatedAt: Math.max(now, entity.updatedAt + 1),
      properties: relationsChanged
        ? { ...entity.properties, relationsUpdatedAt: Math.max(now, Number(entity.properties.relationsUpdatedAt || 0) + 1) }
        : entity.properties,
    }));
  }

  const addedAreas = createdAreas.sort((a, b) => compare(a.id, b.id));
  const resultEntities = [...entities.values(), ...addedAreas];
  const resultRelations = [
    ...next.relations.filter((relation) => !dropped.has(relation.id)),
    ...added.filter((relation) => !dropped.has(relation.id)).sort((a, b) => compare(a.id, b.id)),
  ];
  const changed = dropped.size > 0 || added.length > 0 || addedAreas.length > 0 || touched.size > 0;
  return {
    entities: resultEntities,
    relations: resultRelations,
    droppedRelationIds: [...dropped].sort(compare),
    report,
    changed,
  };
}
