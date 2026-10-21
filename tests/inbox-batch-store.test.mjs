import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-inbox-b5-cas-"));
process.env.AI_EXECUTIVE_DATA_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const { commitInboxBatch, InboxBatchStale, validateInboxBatch } = await import("../lib/inbox-batch-store.ts");
const database = store.getDatabase();
const read = id => {
  const row = database.prepare("SELECT payload FROM entities WHERE id = ?").get(id);
  return row && JSON.parse(row.payload);
};
const add = (id, type, properties = {}) => {
  const time = Date.now() + 1000;
  const entity = {
    id, type, workspaceId: "personal", title: id, status: type === "task" ? "open" : "active",
    properties, createdAt: time, updatedAt: time,
  };
  database.prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)")
    .run(id, JSON.stringify(entity), entity.updatedAt);
  return entity;
};
const batch = (tasks, action = "today", targets = []) => ({
  workspaceId: "personal", restoreGeneration: store.readSnapshot().restoreGeneration,
  selection: tasks.map(({ id, updatedAt }) => ({ id, updatedAt })),
  action, ...(action === "today" ? { date: "2026-10-21" } : {}), targets,
});

test("commits the whole Inbox batch once with one canonical revision", () => {
  const first = add("b5-atomic-a", "task", { inbox: true });
  const second = add("b5-atomic-b", "task", { inbox: true });
  const project = add("b5-atomic-project", "project");
  const before = store.readSnapshot().revision;
  const result = commitInboxBatch(batch([first, second], "organize",
    [{ id: project.id, type: "project", title: project.title, updatedAt: project.updatedAt }]));
  assert.equal(result.affected, 2);
  assert.equal(result.revision, before + 1);
  for (const task of [first, second]) {
    assert.equal(read(task.id).properties.inbox, false);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM relations WHERE payload LIKE ?").get(`%"sourceEntityId":"${task.id}"%`).n, 1);
  }
});

test("a remotely removed member aborts every other member in the same batch", () => {
  const first = add("b5-removed-a", "task", { inbox: true });
  const second = add("b5-removed-b", "task", { inbox: true });
  const submitted = batch([first, second]);
  database.prepare("DELETE FROM entities WHERE id = ?").run(first.id);
  const before = store.readSnapshot().revision;
  assert.throws(() => commitInboxBatch(submitted), InboxBatchStale);
  assert.equal(store.readSnapshot().revision, before);
  assert.equal(read(second.id).properties.inbox, true);
});

test("a project renamed after Review rejects the batch before touching tasks or relations", () => {
  const first = add("b5-target-a", "task", { inbox: true });
  const second = add("b5-target-b", "task", { inbox: true });
  const target = add("b5-target-project", "project");
  const submitted = batch([first, second], "organize",
    [{ id: target.id, type: "project", updatedAt: target.updatedAt, title: target.title }]);
  const updated = { ...target, title: "Renamed after review", updatedAt: target.updatedAt + 1 };
  database.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(updated), updated.updatedAt, target.id);
  const before = store.readSnapshot().revision;
  assert.throws(() => commitInboxBatch(submitted), InboxBatchStale);
  assert.equal(store.readSnapshot().revision, before);
  assert.deepEqual([read(first.id).properties.inbox, read(second.id).properties.inbox], [true, true]);
});

test("SQLite failure while writing a later task rolls back earlier task and relations", () => {
  const first = add("b5-rollback-a", "task", { inbox: true });
  const second = add("b5-rollback-b", "task", { inbox: true });
  const project = add("b5-rollback-project", "project");
  database.exec(`CREATE TRIGGER b5_test_fail BEFORE UPDATE ON entities
    WHEN NEW.id = 'b5-rollback-b' BEGIN SELECT RAISE(ABORT, 'b5 simulated failure'); END;`);
  const before = store.readSnapshot().revision;
  try {
    assert.throws(() => commitInboxBatch(batch([first, second], "organize",
      [{ id: project.id, type: "project", title: project.title, updatedAt: project.updatedAt }])));
  } finally {
    database.exec("DROP TRIGGER b5_test_fail");
  }
  assert.equal(store.readSnapshot().revision, before);
  assert.deepEqual([read(first.id).properties.inbox, read(second.id).properties.inbox], [true, true]);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM relations WHERE payload LIKE '%b5-rollback-%'").get().n, 0);
});

test("strict validation rejects duplicate IDs, an aggregate workspace and stale restore generation", () => {
  const task = add("b5-other", "task", { inbox: true });
  const valid = batch([task]);
  assert.throws(() => validateInboxBatch({ ...valid, selection: [valid.selection[0], valid.selection[0]] }));
  assert.throws(() => validateInboxBatch({ ...valid, workspaceId: "all" }));
  const before = store.readSnapshot().revision;
  assert.throws(() => commitInboxBatch({ ...valid, restoreGeneration: (valid.restoreGeneration ?? 0) + 1 }), InboxBatchStale);
  assert.equal(store.readSnapshot().revision, before);
  assert.equal(read(task.id).properties.inbox, true);
});
