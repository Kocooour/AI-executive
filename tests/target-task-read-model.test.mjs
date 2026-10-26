import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-task-read-"));
const legacy = path.join(dir, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "unchanged");
const previous = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { listIsolatedTargetTasks, readIsolatedTargetTask } = await import("../lib/target-task-read-model.ts");
const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(dir, "stage"), ownerUserId: "alice" });
const writer = new DatabaseSync(stage.databasePath);
writer.exec("PRAGMA foreign_keys = ON");

for (const name of ["bob", "cara", "dana"]) {
  writer.prepare("INSERT INTO identities(id) VALUES (?)").run(name);
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(name, name);
  writer.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?,?,'private',?,?,'unassigned')`).run(`private:${name}`, name, name, name);
}
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
writer.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id)
  VALUES ('area:family','Family','shared','family','alice')`).run();
for (const [name, role] of [["alice", "admin"], ["bob", "editor"], ["cara", "viewer"]]) {
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area:family',?,?)").run(name, role);
}
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('club','shared','bob')").run();
writer.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id)
  VALUES ('area:club','Club','shared','club','bob')`).run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area:club','bob','admin')").run();
const p = writer.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
p.run("p-alice", stage.unassignedAreaId, "Private project");
p.run("p-family", "area:family", "Shared project");
const t = writer.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,?,?,?,?)");
for (const row of [
  ["a-private", null, stage.unassignedAreaId, "Alice private", null],
  ["a-child", "p-alice", null, "Alice child", null],
  ["b-private", null, "private:bob", "Bob private", null],
  ["c-private", null, "private:cara", "Cara private", null],
  ["d-private", null, "private:dana", "Dana private", null],
  ["s-bob", null, "area:family", "For Bob", "bob"],
  ["s-alice", null, "area:family", "For Alice", "alice"],
  ["s-unassigned", null, "area:family", "For nobody", null],
  ["s-child", "p-family", null, "Project child", "bob"],
  ["s-club", null, "area:club", "Club task", "bob"],
]) t.run(...row);
const reader = new DatabaseSync(stage.databasePath, { readOnly: true });
after(() => {
  reader.close(); writer.close();
  if (previous === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const list = (actorUserId, scope, extra = {}) =>
  listIsolatedTargetTasks(reader, { actorUserId, scope, ...extra });
const detail = (actorUserId, taskId) => readIsolatedTargetTask(reader, { actorUserId, taskId });
const ids = (result) => {
  assert.equal(result.ok, true);
  return result.tasks.map(item => item.id);
};

test("Můj plán includes private and assigned shared, not other or unassigned tasks", () => {
  assert.deepEqual(ids(list("alice", "my-plan")), ["a-child", "a-private", "s-alice"]);
  assert.deepEqual(ids(list("bob", "my-plan")), ["b-private", "s-bob", "s-child", "s-club"]);
  assert.deepEqual(ids(list("cara", "my-plan")), ["c-private"]);
  assert.deepEqual(ids(list("dana", "my-plan")), ["d-private"]);
});
test("personal and shared scopes use current membership, viewer can read", () => {
  assert.deepEqual(ids(list("alice", "personal")), ["a-child", "a-private"]);
  assert.deepEqual(ids(list("bob", "personal")), ["b-private"]);
  assert.deepEqual(ids(list("cara", "shared")), ["s-alice", "s-bob", "s-child", "s-unassigned"]);
  assert.deepEqual(ids(list("bob", "shared")), ["s-alice", "s-bob", "s-child", "s-club", "s-unassigned"]);
  assert.deepEqual(ids(list("dana", "shared")), []);
  assert.deepEqual(ids(list("missing-user", "shared")), []);
});
test("direct read protects private data and uses inherited project Area", () => {
  const unavailable = { ok: false, reason: "unavailable", task: null };
  assert.deepEqual(detail("bob", "a-child"), unavailable);
  assert.deepEqual(detail("bob", "a-private"), unavailable);
  assert.deepEqual(detail("bob", "missing-task"), unavailable);
  assert.deepEqual(detail("dana", "s-bob"), unavailable);
  assert.deepEqual(detail("cara", "s-club"), unavailable);
  assert.deepEqual(detail("missing-user", "s-bob"), unavailable);
  const child = detail("cara", "s-child");
  assert.equal(child.ok, true);
  assert.equal(child.task.effectiveAreaId, "area:family");
  assert.equal(child.task.projectId, "p-family");
  assert.equal(child.task.assigneeUserId, "bob");
});
test("keyset paging preserves IDs and never expands membership", () => {
  const expected = ids(list("bob", "shared"));
  const seen = [];
  let cursor = null;
  do {
    const page = list("bob", "shared", { limit: 2, afterTaskId: cursor });
    assert.equal(page.ok, true);
    assert.ok(page.tasks.length <= 2);
    seen.push(...page.tasks.map(row => row.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(ids(list("dana", "shared", { afterTaskId: "a-child" })), []);
});
test("invalid inputs and schema failure return no task content", () => {
  const invalid = { ok: false, reason: "invalid_request", tasks: [], nextCursor: null };
  for (const scope of ["all", "area:family", "", null]) assert.deepEqual(list("alice", scope), invalid);
  for (const limit of [0, 101, 1.5]) assert.deepEqual(list("alice", "shared", { limit }), invalid);
  assert.deepEqual(list("alice", "shared", { afterTaskId: " " }), invalid);
  assert.deepEqual(detail("alice", ""), { ok: false, reason: "invalid_request", task: null });
  const broken = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(listIsolatedTargetTasks(broken, { actorUserId: "alice", scope: "shared" }),
      { ok: false, reason: "query_failed", tasks: [], nextCursor: null });
    assert.deepEqual(readIsolatedTargetTask(broken, { actorUserId: "alice", taskId: "s-bob" }),
      { ok: false, reason: "query_failed", task: null });
  } finally { broken.close(); }
});
test("read helpers never mutate staging or legacy storage", () => {
  const before = readFileSync(stage.databasePath);
  list("bob", "shared"); detail("cara", "s-child");
  assert.deepEqual(readFileSync(stage.databasePath), before);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "unchanged");
});
test("revocation removes list and direct-read access immediately", () => {
  writer.exec("BEGIN IMMEDIATE");
  try {
    writer.prepare(`UPDATE tasks SET assignee_user_id = NULL
      WHERE assignee_user_id='bob' AND (area_id='area:family' OR project_id='p-family')`).run();
    writer.prepare("DELETE FROM area_members WHERE area_id='area:family' AND user_id='bob'").run();
    writer.exec("COMMIT");
  } catch (e) { writer.exec("ROLLBACK"); throw e; }
  assert.deepEqual(ids(list("bob", "shared")), ["s-club"]);
  assert.deepEqual(ids(list("bob", "my-plan")), ["b-private", "s-club"]);
  assert.deepEqual(detail("bob", "s-child"), { ok: false, reason: "unavailable", task: null });
  assert.deepEqual(ids(list("cara", "shared")), ["s-alice", "s-bob", "s-child", "s-unassigned"]);
});
