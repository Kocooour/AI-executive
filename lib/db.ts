import Dexie, { type Table } from "dexie";

export type EntityType = "area" | "project" | "task" | "note" | "workspace";

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  content?: string;
  status: string;
  workspaceId: string;
  properties: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Relation {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  createdAt: number;
}

export const personalWorkspaceId = "personal";

export function defaultWorkspaceEntity(now = Date.now()): Entity {
  return {
    id: "workspace:personal",
    type: "workspace",
    title: "Personal",
    status: "active",
    workspaceId: personalWorkspaceId,
    properties: {
      kind: "personal",
      role: "owner",
      members: [{ id: "owner", role: "owner" }],
    },
    createdAt: now,
    updatedAt: now,
  };
}

class ExecutiveDB extends Dexie {
  entities!: Table<Entity, string>;
  relations!: Table<Relation, string>;

  constructor() {
    super("ai-executive");
    this.version(1).stores({ entities: "id,type,status,workspaceId,updatedAt" });
    this.version(2).stores({
      entities: "id,type,status,workspaceId,updatedAt",
      relations: "id,workspaceId,sourceEntityId,targetEntityId,relationType",
    });
  }
}

export const db = new ExecutiveDB();

export async function ensureDefaultWorkspace() {
  if (!(await db.entities.get("workspace:personal"))) {
    // A local placeholder until the server copy arrives. Timestamp 0 means it can never win a
    // merge against the real workspace, which the server always has.
    await db.entities.add(defaultWorkspaceEntity(0));
    return true;
  }
  return false;
}

export async function seed() {
  if (await db.entities.where("type").notEqual("workspace").count()) {
    await ensureDefaultWorkspace();
    return;
  }
  const now = Date.now();
  const area = crypto.randomUUID();
  const project = crypto.randomUUID();
  await db.entities.bulkAdd([
    { id: area, type: "area", title: "Work", status: "active", workspaceId: personalWorkspaceId, properties: {}, createdAt: now, updatedAt: now },
    { id: project, type: "project", title: "Lumi", status: "active", workspaceId: personalWorkspaceId, properties: { areaId: area }, createdAt: now, updatedAt: now },
    { id: crypto.randomUUID(), type: "note", title: "Product direction", content: "Local-first, calm and extensible.", status: "active", workspaceId: personalWorkspaceId, properties: { projectId: project }, createdAt: now, updatedAt: now },
    { id: crypto.randomUUID(), type: "task", title: "Zavolat Petrovi", status: "open", workspaceId: personalWorkspaceId, properties: { area: "Work", projectId: project, today: true, inbox: false }, createdAt: now, updatedAt: now },
    { id: crypto.randomUUID(), type: "task", title: "Objednat servis", status: "open", workspaceId: personalWorkspaceId, properties: { area: "Cars", today: true, inbox: false }, createdAt: now, updatedAt: now },
  ]);
  await ensureDefaultWorkspace();
}

export async function migratePropertyRelations() {
  const all = await db.entities.toArray();
  await db.transaction("rw", db.entities, db.relations, async () => {
    for (const entity of all) {
      const properties = { ...entity.properties } as Record<string, unknown>;
      let changed = false;
      for (const [key, relationType] of [
        ["projectId", "belongs_to_project"],
        ["areaId", "belongs_to_area"],
      ] as const) {
        const target = properties[key];
        if (typeof target !== "string" || !target) continue;
        const exists = await db.relations
          .where("sourceEntityId")
          .equals(entity.id)
          .filter(
            (relation) =>
              relation.relationType === relationType &&
              relation.targetEntityId === target,
          )
          .first();
        if (!exists) {
          await db.relations.add({
            id: crypto.randomUUID(),
            workspaceId: entity.workspaceId,
            sourceEntityId: entity.id,
            targetEntityId: target,
            relationType,
            createdAt: Date.now(),
          });
        }
        delete properties[key];
        changed = true;
      }
      if (changed) {
        await db.entities.update(entity.id, {
          properties,
          updatedAt: Date.now(),
        });
      }
    }
  });
}
