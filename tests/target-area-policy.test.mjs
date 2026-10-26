import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-area-policy-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "untouched");
const oldDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (oldDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldDataDir;
  rmSync(root, { recursive: true, force: true });
});

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { evaluateTargetAreaPolicy: policy, resolveTargetCreateArea: resolve } =
  await import("../lib/target-area-policy.ts");
const store = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, "stage"), ownerUserId: "alice" });
const db = new DatabaseSync(store.databasePath);
db.exec("PRAGMA foreign_keys = ON");
for (const user of ["bob", "cara"]) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
    .run(`personal:${user}`, user);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?, ?, 'private', ?, ?, 'unassigned')")
    .run(`private:${user}`, `${user} private title`, `personal:${user}`, user);
}
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('shared:family','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('area:family','secret family title','shared','shared:family','alice')").run();
for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["cara", "viewer"]]) {
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area:family',?,?)").run(user, role);
}
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project:family','area:family','secret project title')").run();
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project:alice',?,'private secret project')")
  .run(store.unassignedAreaId);
db.close();

const reader = new DatabaseSync(store.databasePath, { readOnly: true });
after(() => reader.close());
const allow = (area) => ({ allowed: true, reason: "allowed", effectiveAreaId: area });
const deny = (reason) => ({ allowed: false, reason, effectiveAreaId: null });
const p = (actorUserId, areaId, permission) => policy(reader, { actorUserId, areaId, permission });
const c = (kind, actorUserId, writeAreaId, extra = {}) =>
  resolve(reader, { kind, actorUserId, writeAreaId, ...extra });

test("private Area belongs only to its actor; unknown identity and Area fail closed", () => {
  for (const permission of ["read", "write", "admin"]) {
    assert.deepEqual(p("alice", store.unassignedAreaId, permission), allow(store.unassignedAreaId));
    assert.deepEqual(p("bob", store.unassignedAreaId, permission), deny("area_unavailable"));
  }
  assert.deepEqual(p("nobody", "area:family", "read"), deny("unknown_actor"));
  assert.deepEqual(p("alice", "area:missing", "read"), deny("area_unavailable"));
  assert.deepEqual(p("alice", "my-plan", "read"), deny("invalid_request"));
});

test("shared member matrix separates read, ordinary write and admin", () => {
  for (const permission of ["read", "write", "admin"]) {
    assert.deepEqual(p("alice", "area:family", permission), allow("area:family"));
  }
  assert.deepEqual(p("bob", "area:family", "read"), allow("area:family"));
  assert.deepEqual(p("bob", "area:family", "write"), allow("area:family"));
  assert.deepEqual(p("bob", "area:family", "admin"), deny("area_unavailable"));
  assert.deepEqual(p("cara", "area:family", "read"), allow("area:family"));
  assert.deepEqual(p("cara", "area:family", "write"), deny("area_unavailable"));
  assert.deepEqual(p("cara", "area:family", "admin"), deny("area_unavailable"));
  assert.deepEqual(p("cara", "private:bob", "read"), deny("area_unavailable"));
});

test("create resolver requires an explicit Area and project-task inheritance", () => {
  assert.deepEqual(c("create_project", "alice", store.unassignedAreaId), allow(store.unassignedAreaId));
  assert.deepEqual(c("create_standalone_task", "bob", "area:family"), allow("area:family"));
  assert.deepEqual(c("create_project_task", "bob", "area:family", { projectId: "project:family" }),
    allow("area:family"));
  assert.deepEqual(c("create_project_task", "bob", "private:bob", { projectId: "project:family" }),
    deny("project_area_mismatch"));
  assert.deepEqual(c("create_project_task", "bob", "area:family", { projectId: "project:alice" }),
    deny("project_unavailable"));
  assert.deepEqual(c("create_project_task", "alice", "area:family", { projectId: "missing" }),
    deny("project_unavailable"));
  assert.deepEqual(c("create_standalone_task", "alice", undefined), deny("invalid_request"));
  assert.deepEqual(c("create_project", "alice", "my-plan"), deny("invalid_request"));
  assert.deepEqual(c("create_project", "alice", "all"), deny("invalid_request"));
  assert.deepEqual(c("create_project", "cara", "area:family"), deny("area_unavailable"));
  assert.deepEqual(c("create_project", "nobody", "area:family"), deny("unknown_actor"));
});

test("task assignee must match the isolated schema and cannot imply publication", () => {
  assert.deepEqual(c("create_standalone_task", "alice", store.unassignedAreaId,
    { assigneeUserId: "alice" }), deny("assignee_unavailable"));
  assert.deepEqual(c("create_project_task", "bob", "area:family",
    { projectId: "project:family", assigneeUserId: "alice" }), allow("area:family"));
  assert.deepEqual(c("create_standalone_task", "bob", "area:family",
    { assigneeUserId: "bob" }), allow("area:family"));
  for (const assigneeUserId of ["cara", "nobody"]) {
    assert.deepEqual(c("create_standalone_task", "bob", "area:family", { assigneeUserId }),
      deny("assignee_unavailable"));
  }
  assert.deepEqual(c("create_standalone_task", "alice", store.unassignedAreaId),
    allow(store.unassignedAreaId));
  assert.deepEqual(c("create_standalone_task", "alice", undefined,
    { assigneeUserId: "bob" }), deny("invalid_request"));
});

test("helper emits no content or membership details and never changes staging/legacy bytes", () => {
  const before = readFileSync(store.databasePath);
  const files = readdirSync(store.directory);
  const denied = c("create_project_task", "cara", "area:family", { projectId: "project:family" });
  assert.deepEqual(denied, deny("area_unavailable"));
  assert.deepEqual(Object.keys(denied).sort(), ["allowed", "effectiveAreaId", "reason"]);
  assert.ok(!JSON.stringify(denied).includes("secret"));
  assert.ok(!JSON.stringify(denied).includes("viewer"));
  assert.deepEqual(readFileSync(store.databasePath), before);
  assert.deepEqual(readdirSync(store.directory), files);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "untouched");
});
