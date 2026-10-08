import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-store-net-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");

const task = (id) => ({ id, type: "task", title: id, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 });
const ids = (snapshot) => snapshot.entities.filter((entity) => entity.type !== "workspace").map((entity) => entity.id).sort();
const save = (entities, deletedIds = []) => {
  const current = store.readSnapshot();
  return store.replaceSnapshot(current.revision, [...current.entities.filter((entity) => entity.type === "workspace"), ...entities], [], deletedIds);
};
const twenty = Array.from({ length: 20 }, (_, index) => task(`t${String(index).padStart(2, "0")}`));

test("a save at the current revision that silently drops the store is answered as a conflict", () => {
  assert.equal(save(twenty).conflict, false);
  const emptied = save([task("only-one")]);
  assert.equal(emptied.conflict, true);
  assert.equal(emptied.snapshot.entities.filter((entity) => entity.type !== "workspace").length, 20);
  assert.deepEqual(ids(store.readSnapshot()), twenty.map((entity) => entity.id));
});

test("the copy returned with the conflict lets the device merge and save without loss", () => {
  const refused = save([task("only-one")]);
  const merged = [...refused.snapshot.entities.filter((entity) => entity.type !== "workspace"), task("only-one")];
  const saved = store.replaceSnapshot(refused.snapshot.revision, [...refused.snapshot.entities.filter((entity) => entity.type === "workspace"), ...merged], []);
  assert.equal(saved.conflict, false);
  assert.equal(ids(store.readSnapshot()).length, 21);
});

test("deletions the device announces are accepted, however many", () => {
  const current = ids(store.readSnapshot());
  const gone = current.slice(0, 15);
  const result = save(store.readSnapshot().entities.filter((entity) => entity.type !== "workspace" && !gone.includes(entity.id)), gone);
  assert.equal(result.conflict, false);
  assert.equal(ids(store.readSnapshot()).length, 6);
});

test("a few unannounced drops and a small store are not blocked", () => {
  // Six records left: dropping five of them is within the limit of five.
  const kept = store.readSnapshot().entities.filter((entity) => entity.type !== "workspace").slice(0, 1);
  assert.equal(save(kept).conflict, false);
  assert.equal(ids(store.readSnapshot()).length, 1);
  assert.equal(save([]).conflict, false);
});

test("the rule: more than five records and more than a quarter of the store", () => {
  const snapshot = (count) => ({ revision: 1, entities: Array.from({ length: count }, (_, index) => task(`e${index}`)), relations: [], tombstones: [], updatedAt: 1 });
  const keep = (count, total) => Array.from({ length: count }, (_, index) => task(`e${index + (total - count)}`));
  assert.equal(store.dropsTooMuch(snapshot(100), keep(94, 100), []), false);  // 6 dropped, 6 % of the store
  assert.equal(store.dropsTooMuch(snapshot(100), keep(74, 100), []), true);   // 26 dropped
  assert.equal(store.dropsTooMuch(snapshot(100), keep(75, 100), []), false);  // exactly a quarter
  assert.equal(store.dropsTooMuch(snapshot(8), keep(2, 8), []), true);        // 6 of 8
  assert.equal(store.dropsTooMuch(snapshot(8), keep(3, 8), []), false);       // 5 of 8
  assert.equal(store.dropsTooMuch(snapshot(8), [], Array.from({ length: 8 }, (_, index) => `e${index}`)), false);
  assert.equal(store.dropsTooMuch(snapshot(0), [], []), false);
});

test("a save that silently drops the links between records that stay is refused too", () => {
  // Fresh ids: earlier tests left tombstones for some of the t.. ids.
  const relation = (index) => ({ id: `r${index}`, workspaceId: "personal", sourceEntityId: `link-task-${index}`, targetEntityId: "project-x", relationType: "belongs_to_project", createdAt: 1 });
  const project = { ...task("project-x"), type: "project", status: "active" };
  const current = store.readSnapshot();
  const workspaces = current.entities.filter((entity) => entity.type === "workspace");
  const tasks = Array.from({ length: 20 }, (_, index) => task(`link-task-${index}`));
  const links = Array.from({ length: 12 }, (_, index) => relation(index));
  assert.equal(store.replaceSnapshot(current.revision, [...workspaces, ...tasks, project], links, []).conflict, false);
  const before = store.readSnapshot();
  assert.equal(before.relations.length, 12);
  // All records sent, all links missing, nothing announced.
  const refused = store.replaceSnapshot(before.revision, before.entities, [], []);
  assert.equal(refused.conflict, true);
  assert.equal(store.readSnapshot().relations.length, 12);
  // Removing one link at a time, as the app does, is accepted.
  assert.equal(store.replaceSnapshot(before.revision, before.entities, before.relations.slice(1), []).conflict, false);
  // Links that go with an announced deletion of the project are not counted.
  const now = store.readSnapshot();
  const withoutProject = now.entities.filter((entity) => entity.id !== "project-x");
  assert.equal(store.replaceSnapshot(now.revision, withoutProject, [], ["project-x"]).conflict, false);
  assert.equal(store.readSnapshot().relations.length, 0);
});

test("the link rule on its own", () => {
  const entities = Array.from({ length: 10 }, (_, index) => task(`e${index}`));
  const links = Array.from({ length: 10 }, (_, index) => ({ id: `l${index}`, workspaceId: "personal", sourceEntityId: `e${index}`, targetEntityId: `e${(index + 1) % 10}`, relationType: "related", createdAt: 1 }));
  const snapshot = { revision: 1, entities, relations: links, tombstones: [], updatedAt: 1 };
  assert.equal(store.dropsTooMuch(snapshot, entities, [], links.slice(5)), false);   // 5 links gone
  assert.equal(store.dropsTooMuch(snapshot, entities, [], links.slice(6)), true);    // 6 links gone
  assert.equal(store.dropsTooMuch(snapshot, entities, [], []), true);
  // Every link touches an announced record: not counted.
  assert.equal(store.dropsTooMuch(snapshot, entities.slice(0, 3), entities.slice(3).map((entity) => entity.id), []), false);
});
