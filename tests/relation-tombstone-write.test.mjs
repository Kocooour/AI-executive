import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

// A tombstone may name a relation ID (a crafted or stale request). The server write and the sync merge must never
// keep that relation live beside its tombstone, which the shared snapshot validation rejects.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-relation-tombstone-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_SESSION_SECRET = randomBytes(48).toString("base64");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const sync = await import("../lib/server-sync.ts");

const now = Date.now();
const entity = (id, type, title) => ({ id, type, title, status: "open", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
const task = entity("task-1", "task", "Task");
const area = entity("area-1", "area", "Area");
const relation = { id: "rel-1", workspaceId: "personal", sourceEntityId: task.id, targetEntityId: area.id, relationType: "belongs_to_area", createdAt: now };

test("a deleted relation ID with both endpoints still live drops the relation and keeps its tombstone", () => {
  let snapshot = store.readSnapshot();
  const workspace = snapshot.entities.find((item) => item.id === "workspace:personal");
  let result = store.replaceSnapshot(snapshot.revision, [workspace, task, area], [relation], [], [], snapshot.restoreGeneration);
  assert.equal(result.conflict, false);
  snapshot = store.readSnapshot();
  assert.deepEqual(snapshot.relations.map((item) => item.id), [relation.id]);

  result = store.replaceSnapshot(snapshot.revision, snapshot.entities, snapshot.relations, [relation.id], [], snapshot.restoreGeneration);
  assert.equal(result.conflict, false);
  const stored = store.readSnapshot();
  assert.doesNotThrow(() => store.validateSnapshot(stored));
  assert.equal(stored.relations.some((item) => item.id === relation.id), false);
  assert.ok(stored.tombstones.some((item) => item.id === relation.id));
  assert.deepEqual(stored.entities.filter((item) => item.id !== "workspace:personal").map((item) => item.id).sort(), [area.id, task.id]);
});

test("the sync merge does not bring back a relation the server has tombstoned", () => {
  const server = { revision: 3, entities: [task, area], relations: [], tombstones: [{ id: relation.id, deletedAt: now }] };
  const withoutBase = sync.mergeSnapshots(server, [task, area], [relation]);
  assert.equal(withoutBase.relations.some((item) => item.id === relation.id), false);
  const withBase = sync.mergeSnapshots(server, [task, area], [relation], { entities: [task, area], relations: [relation] });
  assert.equal(withBase.relations.some((item) => item.id === relation.id), false);
});
