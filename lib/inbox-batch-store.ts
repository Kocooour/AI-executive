import { ensureDailyBackup, getDatabase } from "./server-store";
import type { Entity, Relation } from "./db";
import { randomUUID } from "node:crypto";
import { enforceAreaWritesInTransaction, readAreaRows } from "./area-write-store";

// The batch MUST NOT be implemented as a full-snapshot PUT followed by a
// three-way merge: a remotely removed member could otherwise be dropped while
// the other members are committed. One authoritative SQLite transaction is
// the commit boundary for the complete selection.
export interface InboxBatchRequest {
  workspaceId: string;
  restoreGeneration: number;
  selection: Array<{ id: string; updatedAt: number }>;
  action: "today" | "tomorrow" | "someday" | "waiting" | "organize";
  date?: string;
  targets?: Array<{ id: string; type: "project" | "area"; updatedAt: number; title: string }>;
}

export class InboxBatchStale extends Error {
  constructor() { super("Inbox batch changed; review the current selection again"); }
}

// The request itself cannot be applied under the Area model (not a stale selection).
export class InboxBatchInvalid extends Error {
  constructor() { super("Inbox batch cannot be applied; review the selection and destination"); }
}

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 240;
const validRevision = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

export function validateInboxBatch(value: unknown): asserts value is InboxBatchRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid Inbox batch");
  const b = value as Partial<InboxBatchRequest>;
  if (typeof b.workspaceId !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(b.workspaceId) ||
      b.workspaceId === "all" || !validRevision(b.restoreGeneration) ||
      !Array.isArray(b.selection) || b.selection.length < 1 || b.selection.length > 50 ||
      b.selection.some(item => !item || !validId(item.id) || !validRevision(item.updatedAt)) ||
      new Set(b.selection.map(item => item.id)).size !== b.selection.length ||
      !["today", "tomorrow", "someday", "waiting", "organize"].includes(String(b.action))) {
    throw new Error("Invalid Inbox batch");
  }
  if ((b.action === "today" || b.action === "tomorrow") &&
      (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
       Number.isNaN(Date.parse(b.date + "T00:00:00Z")) ||
       new Date(b.date + "T00:00:00Z").toISOString().slice(0, 10) !== b.date)) {
    throw new Error("Invalid Inbox batch date");
  }
  if (b.targets !== undefined &&
      (!Array.isArray(b.targets) || b.targets.length > 2 ||
       b.targets.some(t => !t || !validId(t.id) ||
         !["project", "area"].includes(t.type) || !validRevision(t.updatedAt) ||
         typeof t.title !== "string") ||
       new Set(b.targets.map(t => t.type)).size !== b.targets.length)) {
    throw new Error("Invalid Inbox batch targets");
  }
  if (b.action === "organize" ? !b.targets?.length : Boolean(b.targets?.length)) {
    throw new Error("Invalid Inbox batch destination");
  }
  // 2a part 4: a task in a project has no Area of its own, so one batch never sets both (the UI offers one).
  if (b.targets && b.targets.length > 1) throw new Error("Invalid Inbox batch targets");
}

export function commitInboxBatch(batch: InboxBatchRequest) {
  validateInboxBatch(batch);
  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const meta = database.prepare("SELECT value FROM metadata WHERE key = ?");
    const generation = Number((meta.get("restoreGeneration") as { value?: string } | undefined)?.value ?? 0);
    if (generation !== batch.restoreGeneration) throw new InboxBatchStale();
    const lookup = database.prepare("SELECT payload FROM entities WHERE id = ?");
    const getEntity = (id: string): Entity | null => {
      const row = lookup.get(id) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as Entity : null;
    };
    const workspace = getEntity(`workspace:${batch.workspaceId}`);
    if (!workspace || workspace.type !== "workspace" || workspace.status !== "active" ||
        workspace.workspaceId !== batch.workspaceId) throw new InboxBatchStale();
    const tasks = batch.selection.map(selected => {
      const entity = getEntity(selected.id);
      if (!entity || entity.type !== "task" || entity.workspaceId !== batch.workspaceId ||
          entity.status !== "open" || entity.properties.inbox !== true ||
          entity.updatedAt !== selected.updatedAt ||
          (Array.isArray(entity.properties.syncConflicts) && entity.properties.syncConflicts.length > 0)) {
        throw new InboxBatchStale();
      }
      return entity;
    });
    const targets = (batch.targets || []).map(target => {
      const entity = getEntity(target.id);
      if (!entity || entity.type !== target.type || entity.status !== "active" ||
          entity.workspaceId !== batch.workspaceId || entity.updatedAt !== target.updatedAt ||
          entity.title !== target.title) throw new InboxBatchStale();
      return { ...target, relationType: target.type === "project" ? "belongs_to_project" : "belongs_to_area" };
    });
    const now = Date.now();
    const areaBefore = readAreaRows(database);
    const updateEntity = database.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?");
    const deleteRelation = database.prepare("DELETE FROM relations WHERE id = ?");
    const insertRelation = database.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)");
    const relations = targets.length
      ? database.prepare("SELECT id, payload FROM relations").all() as Array<{ id: string; payload: string }>
      : [];
    // An Area chosen for a task that is already in a project would be a task-level Area link, which the model
    // forbids (the task inherits its project's Area). The whole batch is refused instead of silently skipping tasks,
    // so the reviewed selection is applied completely or not at all.
    if (targets.some(target => target.relationType === "belongs_to_area")) {
      const inProject = new Set(areaBefore.relations
        .filter(link => link.relationType === "belongs_to_project").map(link => link.sourceEntityId));
      if (tasks.some(task => inProject.has(task.id) || typeof task.properties.projectId === "string" && task.properties.projectId)) {
        throw new InboxBatchInvalid();
      }
    }
    for (const task of tasks) {
      for (const target of targets) {
        for (const row of relations) {
          const link = JSON.parse(row.payload) as Relation;
          if (link.sourceEntityId === task.id && link.relationType === target.relationType) deleteRelation.run(row.id);
        }
        const link: Relation = {
          id: randomUUID(), workspaceId: batch.workspaceId, sourceEntityId: task.id,
          targetEntityId: target.id, relationType: target.relationType, createdAt: now,
        };
        insertRelation.run(link.id, JSON.stringify(link), link.createdAt);
      }
      const fields: Record<string, unknown> =
        batch.action === "today" || batch.action === "tomorrow" || batch.action === "someday"
          ? { when: batch.date || "", today: batch.action === "today", someday: batch.action === "someday" }
          : batch.action === "waiting"
            ? { waiting: true, waitingSince: now, waitingFor: "", followUpDate: "" }
            : { relationsUpdatedAt: now };
      const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
      const next: Entity = {
        ...task, updatedAt: Math.max(now, task.updatedAt + 1),
        properties: {
          ...task.properties, ...fields, inbox: false,
          activity: [...activity, { at: now, action: "inbox triaged: batch " + batch.action }].slice(-50),
        },
      };
      updateEntity.run(JSON.stringify(next), next.updatedAt, task.id);
    }
    // Choosing a project removes the tasks' own Area links (they inherit); a task that ends up without any Area
    // keeps the workspace fallback. Only what this batch changed is touched.
    enforceAreaWritesInTransaction(database, areaBefore, now);
    const revision = Number((meta.get("revision") as { value?: string } | undefined)?.value ?? 0) + 1;
    const setMeta = database.prepare("INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    setMeta.run("revision", String(revision));
    setMeta.run("updatedAt", String(now));
    database.exec("COMMIT");
    return { revision, affected: tasks.length };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
