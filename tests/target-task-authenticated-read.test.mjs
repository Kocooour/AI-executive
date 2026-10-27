import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-auth-read-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "untouched");
const previous = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const {
  listAuthenticatedIsolatedTargetTasks: listTasks,
  readAuthenticatedIsolatedTargetTask: readTask,
  TARGET_STAGING_TASK_READ_AUDIENCE: audience,
} = await import("../lib/target-task-authenticated-read.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
const writer = new DatabaseSync(stage.databasePath);
writer.exec("PRAGMA foreign_keys = ON");
writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','alice','admin')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','editor')").run();
const insert = writer.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,?)");
insert.run("alice-private", stage.unassignedAreaId, "Private Alice", null);
insert.run("bob-private-task", "bob-private", "Private Bob", null);
insert.run("shared-alice", "family-area", "For Alice", "alice");
insert.run("shared-bob", "family-area", "For Bob", "bob");
insert.run("shared-unassigned", "family-area", "Unassigned", null);

assert.deepEqual(inspectIsolatedTargetStore({
  stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  mode: "r2-model",
}), { ok: true, mode: "r2-model", issues: [] });

const reader = new DatabaseSync(stage.databasePath, { readOnly: true });
after(() => {
  reader.close();
  writer.close();
  if (previous === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const signingKey = randomBytes(32);
const now = () => Math.floor(Date.now() / 1000);
const claims = (sub, changes = {}) => ({
  v: 1, aud: audience, sub, gen: stage.restoreGeneration,
  iat: now() - 10, exp: now() + 120, ...changes,
});
// This fixture-only signer is NOT part of the runtime module or a session issuer.
const sign = (value, key = signingKey) => {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", key)
    .update("lumi:r2:target-task-read:staging:v1\0").update(payload)
    .digest("base64url");
  return payload + "." + signature;
};
const access = (sub = "alice", changes = {}) =>
  ({ signingKey, sessionToken: sign(claims(sub, changes)) });
const list = (credential, scope, extra = {}) =>
  listTasks(reader, credential, { scope, ...extra });
const detail = (credential, taskId, extra = {}) =>
  readTask(reader, credential, { taskId, ...extra });
const ids = (result) => {
  assert.equal(result.ok, true);
  return result.tasks.map(task => task.id);
};
const noList = { ok: false, reason: "unauthorized", tasks: [], nextCursor: null };
const noDetail = { ok: false, reason: "unauthorized", task: null };
const unavailable = { ok: false, reason: "unavailable", task: null };

test("signed actor identities select distinct personal, assigned and shared views", () => {
  assert.deepEqual(ids(list(access("alice"), "my-plan")), ["alice-private", "shared-alice"]);
  assert.deepEqual(ids(list(access("bob"), "my-plan")), ["bob-private-task", "shared-bob"]);
  assert.deepEqual(ids(list(access("alice"), "personal")), ["alice-private"]);
  assert.deepEqual(ids(list(access("bob"), "personal")), ["bob-private-task"]);
  assert.deepEqual(ids(list(access("bob"), "shared")), ["shared-alice", "shared-bob", "shared-unassigned"]);
  assert.deepEqual(detail(access("bob"), "alice-private"), unavailable);
  assert.equal(detail(access("alice"), "shared-bob").task.id, "shared-bob");
  assert.equal(detail(access("bob"), "bob-private-task").task.areaKind, "private");
});

test("client actor overrides are forbidden even with a valid token", () => {
  const bob = access("bob");
  assert.deepEqual(list(bob, "personal", { actorUserId: "alice" }),
    { ok: false, reason: "invalid_request", tasks: [], nextCursor: null });
  assert.deepEqual(detail(bob, "alice-private", { actorUserId: "alice" }),
    { ok: false, reason: "invalid_request", task: null });
  assert.deepEqual(listTasks(reader, bob, null),
    { ok: false, reason: "invalid_request", tasks: [], nextCursor: null });
  assert.deepEqual(readTask(reader, bob, null),
    { ok: false, reason: "invalid_request", task: null });
});

test("malformed, altered, missing, and incorrectly signed credentials reveal nothing", () => {
  const valid = access();
  const [payload, signature] = valid.sessionToken.split(".");
  const notIssued = [
    { signingKey, sessionToken: "" },
    { signingKey, sessionToken: "a.b.c" },
    { signingKey, sessionToken: "a.@" },
    { signingKey, sessionToken: "a.".repeat(3000) },
    { signingKey, sessionToken: Buffer.from(JSON.stringify(claims("bob"))).toString("base64url") + "." + signature },
    { signingKey, sessionToken: payload + "." + sign(claims("bob")).split(".")[1] },
    { signingKey: randomBytes(32), sessionToken: valid.sessionToken },
    { signingKey: randomBytes(16), sessionToken: valid.sessionToken },
    { signingKey: "not-a-key", sessionToken: valid.sessionToken },
    { sessionToken: valid.sessionToken },
    { signingKey },
    null,
  ];
  for (const credential of notIssued) {
    assert.deepEqual(list(credential, "shared"), noList);
    assert.deepEqual(detail(credential, "shared-alice"), noDetail);
  }
});

test("strict token claims reject expiry, future issuance, oversized lifetime and wrong audience", () => {
  for (const modified of [
    { exp: now() - 1 },
    { iat: now() + 5, exp: now() + 30 },
    { iat: now() - 901, exp: now() + 1 },
    { iat: now() - 10, exp: now() + 901 },
    { aud: "lumi-production" }, { v: 2 }, { sub: "" }, { sub: " alice" },
    { gen: randomUUID() }, { gen: "not-a-uuid" }, { iat: "1" }, { exp: Infinity },
    { exp: now() - 20, iat: now() - 10 },
  ]) {
    const credential = access("alice", modified);
    assert.deepEqual(list(credential, "my-plan"), noList, JSON.stringify(modified));
    assert.deepEqual(detail(credential, "alice-private"), noDetail, JSON.stringify(modified));
  }
  const unexpectedClaim = { ...claims("alice"), actorUserId: "bob" };
  assert.deepEqual(list({ signingKey, sessionToken: sign(unexpectedClaim) }, "shared"), noList);
  assert.deepEqual(list(access("unregistered-user"), "shared"), noList);
});

test("invalid isolated database and activation markers fail closed", () => {
  const broken = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(listTasks(broken, access(), { scope: "shared" }), noList);
    assert.deepEqual(readTask(broken, access(), { taskId: "alice-private" }), noDetail);
  } finally { broken.close(); }
  writer.prepare("UPDATE metadata SET value='true' WHERE key='activated'").run();
  assert.deepEqual(list(access(), "personal"), noList);
  writer.prepare("UPDATE metadata SET value='false' WHERE key='activated'").run();
  writer.prepare("UPDATE metadata SET value='unknown' WHERE key='schema_version'").run();
  assert.deepEqual(detail(access(), "alice-private"), noDetail);
  writer.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
  assert.deepEqual(ids(list(access(), "personal")), ["alice-private"]);
});

test("revoking Area membership takes effect even on still-valid signed credentials", () => {
  const bob = access("bob");
  assert.equal(detail(bob, "shared-bob").ok, true);
  writer.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  writer.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(list(bob, "shared")), []);
  assert.deepEqual(ids(list(bob, "my-plan")), ["bob-private-task"]);
  assert.deepEqual(detail(bob, "shared-bob"), unavailable);
  assert.deepEqual(ids(list(access("alice"), "shared")), ["shared-alice", "shared-bob", "shared-unassigned"]);
});

test("restore generation rotation invalidates issued tokens, with no legacy writes", () => {
  const oldToken = access("alice");
  const replacementGeneration = randomUUID();
  writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(replacementGeneration);
  assert.deepEqual(list(oldToken, "personal"), noList);
  assert.deepEqual(detail(oldToken, "alice-private"), noDetail);
  // A fresh signed claim for the new store generation works with current permissions.
  assert.deepEqual(ids(list(access("alice", { gen: replacementGeneration }), "personal")), ["alice-private"]);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "untouched");
});
