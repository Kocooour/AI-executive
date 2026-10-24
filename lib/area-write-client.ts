// 2a part 4, client side: immediate UI consistency for new writes. The server stays the authority
// (lib/area-write-invariants.ts runs on every save); these helpers only make the local copy agree with it.
// All functions expect to run inside a Dexie "rw" transaction over entities and relations.
import { db, type Entity, type Relation } from "./db";
import { areaKindForWorkspace, type WorkspaceKind } from "./area-ids";
import { planFallbackArea } from "./area-write-invariants";

export async function workspaceKindOf(workspaceId: string): Promise<WorkspaceKind | undefined> {
  const workspace = await db.entities.get(`workspace:${workspaceId}`);
  const kind = workspace?.properties.kind;
  if (kind === "personal" || kind === "shared") return kind;
  return workspaceId === "personal" ? "personal" : undefined;
}

/** The `kind` an Area created in this workspace must carry (undefined: unknown workspace). */
export async function areaKindOf(workspaceId: string): Promise<"private" | "shared" | undefined> {
  const kind = await workspaceKindOf(workspaceId);
  return kind ? areaKindForWorkspace(kind) : undefined;
}

const hasText = (value: unknown) => typeof value === "string" && value.trim() !== "";

/**
 * Gives a project or a standalone task that has no Area the workspace's fallback Area ("Nezařazeno" /
 * "Nezařazeno (původní sdílené)"): an existing one with that label is reused, otherwise the planner's deterministic
 * Area is created locally (with its `kind`). Returns the new link, or undefined when the item already has an Area or
 * the fallback is unavailable (the server reports/handles that case).
 */
export async function assignFallbackArea(entity: Entity, now: number): Promise<Relation | undefined> {
  if (entity.type !== "project" && entity.type !== "task") return undefined;
  if (hasText(entity.properties.areaId)) return undefined;
  const links = await db.relations.where("sourceEntityId").equals(entity.id)
    .filter((relation) => relation.relationType === "belongs_to_area").count();
  if (links > 0) return undefined;
  const plan = planFallbackArea({
    workspaceId: entity.workspaceId,
    kind: await workspaceKindOf(entity.workspaceId),
    entities: await db.entities.where("workspaceId").equals(entity.workspaceId).filter((item) => item.type === "area").toArray(),
    tombstonedIds: new Set(),
    now,
  });
  if (plan.status === "unavailable") return undefined;
  if (plan.status === "create") await db.entities.add(plan.area);
  const link: Relation = {
    id: crypto.randomUUID(), workspaceId: entity.workspaceId, sourceEntityId: entity.id,
    targetEntityId: plan.area.id, relationType: "belongs_to_area", createdAt: now,
  };
  await db.relations.add(link);
  return link;
}

/** Removes every Area link of a task (it inherits the Area of its project). Returns how many were removed. */
export async function dropTaskAreaLinks(taskId: string): Promise<number> {
  const links = await db.relations.where("sourceEntityId").equals(taskId)
    .filter((relation) => relation.relationType === "belongs_to_area").toArray();
  if (links.length) await db.relations.bulkDelete(links.map((relation) => relation.id));
  return links.length;
}

export async function taskIsInProject(task: Entity): Promise<boolean> {
  if (hasText(task.properties.projectId)) return true;
  return (await db.relations.where("sourceEntityId").equals(task.id)
    .filter((relation) => relation.relationType === "belongs_to_project").count()) > 0;
}
