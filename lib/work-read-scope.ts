// D3 preparation: pure read-model for the three user-facing work scopes.
// This is NOT an authorization layer: callers must supply only server-authorized
// personal/shared workspace IDs and the already-authorized entity snapshot.
// Do not connect it to the UI until the 2a/2b/2c migration and preservation gates
// documented in docs/ARCHITECTURE.md are complete and independently verified.
import type { Entity, Relation } from "./db";
import { sameValue } from "./field-merge";

export type WorkReadScope = "my-plan" | "personal" | "shared";

export interface WorkScopeInput {
  scope: WorkReadScope;
  actorUserId: string;
  personalWorkspaceId: string;
  authorizedSharedWorkspaceIds: readonly string[];
  entities: readonly Entity[];
  relations: readonly Relation[];
}

export interface ScopedWork {
  tasks: Entity[];
  projects: Entity[];
}

function canonicalEntities(entities: readonly Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const entity of entities) {
    const previous = byId.get(entity.id);
    // A canonical ID must never resolve to two different revisions or scopes.
    // Refuse an inconsistent snapshot instead of arbitrarily choosing a copy.
    if (previous && !sameValue(previous, entity)) {
      throw new Error("Conflicting canonical entity ID in work scope snapshot");
    }
    if (!previous) byId.set(entity.id, entity);
  }
  return [...byId.values()];
}

/**
 * Select a working list without changing an entity's ID, revision or workspace.
 *
 * - personal: all of the actor's authorized private work;
 * - shared: all visible shared work, including unassigned and other members' tasks;
 * - my-plan: private work plus only tasks explicitly assigned to this actor
 *   from shared workspaces. A shared project appears in the Projects list only
 *   if it contains an active task assigned to the actor.
 *
 * This selector is read-only. It NEVER grants authorization or chooses the
 * workspace/Area of a write. A project-detail view must query its separately
 * authorized full project contents rather than use this Projects summary.
 */
export function selectScopedWork(input: WorkScopeInput): ScopedWork {
  const { scope, actorUserId, personalWorkspaceId, authorizedSharedWorkspaceIds, entities, relations } = input;
  if (scope !== "my-plan" && scope !== "personal" && scope !== "shared") {
    throw new Error("Unsupported work read scope");
  }
  if (!actorUserId.trim() || !personalWorkspaceId.trim() || personalWorkspaceId === "all") {
    throw new Error("Work scope requires an actor and a personal workspace");
  }
  const sharedIds = new Set(authorizedSharedWorkspaceIds);
  if (sharedIds.has(personalWorkspaceId) || sharedIds.has("all") || sharedIds.has("")) {
    throw new Error("Personal and shared workspace scopes must not overlap");
  }

  const authorizedEntities = canonicalEntities(
    entities.filter((entity) =>
      entity.workspaceId === personalWorkspaceId || sharedIds.has(entity.workspaceId)),
  );
  const isPersonal = (entity: Entity) => entity.workspaceId === personalWorkspaceId;
  const isShared = (entity: Entity) => sharedIds.has(entity.workspaceId);
  const assignedToActor = (entity: Entity) =>
    entity.properties.assigneeUserId === actorUserId;
  const inScope = (entity: Entity) =>
    scope === "personal" ? isPersonal(entity)
      : scope === "shared" ? isShared(entity)
      : isPersonal(entity) || (isShared(entity) && assignedToActor(entity));

  const tasks = authorizedEntities.filter((entity) =>
    entity.type === "task" && inScope(entity));

  if (scope !== "my-plan") {
    return {
      tasks,
      projects: authorizedEntities.filter((entity) => entity.type === "project" && inScope(entity)),
    };
  }

  // The Projects overview in My Plan includes a shared project only if one
  // *open* assigned task belongs to it. Cross-workspace relations cannot qualify.
  const projectsById = new Map(authorizedEntities
    .filter((entity) => entity.type === "project")
    .map((project) => [project.id, project]));
  const sharedProjectIds = new Set<string>();
  const assignedOpenTasks = new Map(tasks
    .filter((task) => isShared(task) && task.status === "open")
    .map((task) => [task.id, task]));
  for (const relation of relations) {
    if (relation.relationType !== "belongs_to_project") continue;
    const task = assignedOpenTasks.get(relation.sourceEntityId);
    const project = projectsById.get(relation.targetEntityId);
    if (!task || !project || !isShared(project)) continue;
    if (task.workspaceId !== project.workspaceId || relation.workspaceId !== task.workspaceId) continue;
    sharedProjectIds.add(project.id);
  }

  return {
    tasks,
    projects: authorizedEntities.filter((entity) => entity.type === "project"
      && (isPersonal(entity) || sharedProjectIds.has(entity.id))),
  };
}
