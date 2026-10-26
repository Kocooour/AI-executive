import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r1-preflight-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "never touch");
const oldDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (oldDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldDataDir;
  rmSync(root, { recursive: true, force: true });
});
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore: inspect } = await import("../lib/target-store-preflight.ts");
const fresh = (name) => bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, name), ownerUserId: "owner" });
const check = (store, extra = {}) => inspect({ stagingDirectory: store.directory, ...extra });
function tamper(store, sql) {
  const db = new DatabaseSync(store.databasePath);
  try { db.exec(sql); } finally { db.close(); }
}
const has = (result, code) => assert.ok(!result.ok && result.issues.includes(code), JSON.stringify(result));

test("clean inactive bootstrap passes stage and R2-model inspection without touching bytes", () => {
  const store = fresh("clean");
  const before = readFileSync(store.databasePath);
  assert.deepEqual(check(store, { expectedOwnerUserId: "owner", expectedRestoreGeneration: store.restoreGeneration }),
    { ok: true, mode: "stage", issues: [] });
  assert.deepEqual(check(store, { mode: "r2-model" }), { ok: true, mode: "r2-model", issues: [] });
  has(check(store, { expectedOwnerUserId: "other" }), "expected_owner_mismatch");
  has(check(store, { expectedRestoreGeneration: "wrong" }), "expected_generation_mismatch");
  assert.deepEqual(readFileSync(store.databasePath), before);
});

test("reject unsafe, missing, aliased and corrupt stores without creating files", () => {
  const store = fresh("path-safe");
  const alias = path.join(root, "legacy-alias");
  symlinkSync(legacy, alias, "dir");
  has(inspect({ stagingDirectory: "relative" }), "unsafe_path");
  has(inspect({ stagingDirectory: path.join(root, "absent") }), "unsafe_path");
  has(inspect({ stagingDirectory: legacy }), "unsafe_path");
  has(inspect({ stagingDirectory: alias }), "unsafe_path");
  has(inspect({ stagingDirectory: alias + "/../legacy" }), "unsafe_path");
  const nested = path.join(legacy, "nested");
  mkdirSync(nested);
  const nestedAlias = path.join(root, "nested-alias");
  symlinkSync(nested, nestedAlias, "dir");
  has(inspect({ stagingDirectory: nestedAlias + "/../" }), "unsafe_path");
  const noDb = path.join(root, "empty");
  mkdirSync(noDb);
  has(inspect({ stagingDirectory: noDb }), "missing_database");
  assert.deepEqual(readdirSync(noDb), []);
  const linkDir = path.join(root, "linked-db");
  mkdirSync(linkDir);
  symlinkSync(store.databasePath, path.join(linkDir, "lumi-target.sqlite"));
  has(inspect({ stagingDirectory: linkDir }), "missing_database");
  const corrupt = path.join(root, "corrupt");
  mkdirSync(corrupt);
  const corruptFile = path.join(corrupt, "lumi-target.sqlite");
  writeFileSync(corruptFile, "not sqlite\nprivate task title should never appear");
  const before = readFileSync(corruptFile);
  const result = inspect({ stagingDirectory: corrupt });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes("private task title"));
  assert.deepEqual(readFileSync(corruptFile), before);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "never touch");
});

test("tampered metadata, foreign keys, schema and model relations fail closed", () => {
  const metadata = fresh("metadata");
  tamper(metadata, "UPDATE metadata SET value='true' WHERE key='activated'");
  has(check(metadata), "metadata_invalid");
  const fk = fresh("fk");
  tamper(fk, "PRAGMA foreign_keys=OFF; INSERT INTO projects(id,area_id,title) VALUES ('p','missing','Secret title')");
  has(check(fk), "foreign_key_failed");
  const noTrigger = fresh("no-trigger");
  tamper(noTrigger, "DROP TRIGGER area_conflict_guard");
  has(check(noTrigger), "schema_invalid");
  const task = fresh("task");
  tamper(task, `PRAGMA foreign_keys=OFF;
    INSERT INTO tasks(id,area_id,title) VALUES ('t','missing','Secret title')`);
  has(check(task), "task_area_invalid");
  const assignee = fresh("assignee");
  tamper(assignee, `PRAGMA foreign_keys=OFF;
    DROP TRIGGER task_assignee_insert;
    INSERT INTO identities(id) VALUES ('other');
    INSERT INTO tasks(id,area_id,title,assignee_user_id)
      VALUES ('t','${assignee.unassignedAreaId}','Secret title','other')`);
  has(check(assignee), "assignee_invalid");
  assert.ok(!JSON.stringify(check(assignee)).includes("Secret"));
  const offRole = fresh("off-role");
  tamper(offRole, `DROP TRIGGER task_assignee_insert;
    INSERT INTO identities(id) VALUES ('viewer');
    INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('sw','shared','owner');
    INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('sa','Shared','shared','sw','owner');
    INSERT INTO area_members(area_id,user_id,role) VALUES ('sa','viewer','viewer');
    INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('t','sa','Hidden','viewer')`);
  has(check(offRole), "assignee_invalid");
  const shared = fresh("shared");
  tamper(shared, "INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('s','shared','owner')");
  assert.equal(check(shared).ok, true); // legal incomplete R1 intermediate state
  has(check(shared, { mode: "r2-model" }), "shared_mapping_invalid");
  tamper(shared, "INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('a','Shared','shared','s','owner')");
  has(check(shared, { mode: "r2-model" }), "shared_admin_missing");
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "never touch");
});
