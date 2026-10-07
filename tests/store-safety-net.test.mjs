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
