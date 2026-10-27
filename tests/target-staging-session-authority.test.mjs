import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-ephemeral-sessions-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
const oldData = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
const store = {
  stagingDirectory: stage.directory,
  expectedRestoreGeneration: stage.restoreGeneration,
};
const writer = new DatabaseSync(stage.databasePath);
writer.exec("PRAGMA foreign_keys = ON");
writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob private','private','bob-personal','bob','unassigned')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','alice','admin')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','editor')").run();
const insert = writer.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,?)");
insert.run("private-alice", stage.unassignedAreaId, "Alice private", null);
insert.run("private-bob", "bob-private", "Bob private", null);
insert.run("shared-alice", "family-area", "Alice assigned", "alice");
insert.run("shared-bob", "family-area", "Bob assigned", "bob");
const authorities = [];
const authority = () => {
  const a = new TargetStagingSessionAuthority(store);
  authorities.push(a);
  return a;
};

after(() => {
  for (const a of authorities) a.close();
  writer.close();
  if (oldData === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldData;
  rmSync(root, { recursive: true, force: true });
});

const noList = { ok: false, reason: "unauthorized", tasks: [], nextCursor: null };
const noDetail = { ok: false, reason: "unauthorized", task: null };

function ids(result) {
  assert.equal(result.ok, true);
  return result.tasks.map(t => t.id);
}

test("dedicated ephemeral sessions have unique signed jti and enforce live Area ACL", () => {
  const sessions = authority();
  const alice1 = sessions.issue("alice");
  const alice2 = sessions.issue("alice");
  const bob = sessions.issue("bob");
  assert.ok(alice1);
  assert.ok(alice2);
  assert.ok(bob);
  assert.notEqual(alice1.sessionToken, alice2.sessionToken);
  const claims = JSON.parse(Buffer.from(alice1.sessionToken.split(".")[0], "base64url"));
  assert.ok(claims.jti);
  assert.equal(claims.sub, "alice");
  assert.equal(claims.gen, stage.restoreGeneration);
  assert.ok(claims.exp - claims.iat <= 900);
  assert.deepEqual(ids(sessions.list(alice1.sessionToken, { scope: "my-plan" })),
    ["private-alice", "shared-alice"]);
  assert.deepEqual(ids(sessions.list(bob.sessionToken, { scope: "personal" })),
    ["private-bob"]);
  assert.deepEqual(sessions.detail(bob.sessionToken, { taskId: "private-alice" }),
    { ok: false, reason: "unavailable", task: null });
  assert.equal(sessions.detail(bob.sessionToken, { taskId: "shared-bob" }).ok, true);
  assert.deepEqual(sessions.list(bob.sessionToken, {
    scope: "personal", actorUserId: "alice",
  }), { ok: false, reason: "invalid_request", tasks: [], nextCursor: null });
  assert.deepEqual(sessions.detail(bob.sessionToken, {
    taskId: "private-alice", actorUserId: "alice",
  }), { ok: false, reason: "invalid_request", task: null });
  assert.equal(Object.hasOwn(sessions, "signingKey"), false);
});

test("invalid principal, absent actor, forged token and invalid lifetime never issue or read", () => {
  const sessions = authority();
  for (const actor of ["missing", "", " bob", "alice\n"]) {
    assert.equal(sessions.issue(actor), null);
  }
  for (const lifetime of [-1, 0, 901, 1.5, Number.NaN, "5"]) {
    assert.equal(sessions.issue("alice", lifetime), null);
  }
  const a = sessions.issue("alice");
  assert.ok(a);
  const tampered = a.sessionToken.slice(0, -1) + (a.sessionToken.endsWith("a") ? "b" : "a");
  for (const token of ["", "a.b", "a.b.c", tampered, null]) {
    assert.deepEqual(sessions.list(token, { scope: "personal" }), noList);
    assert.deepEqual(sessions.detail(token, { taskId: "private-alice" }), noDetail);
    assert.equal(sessions.revoke(token), false);
  }
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("single-session revocation does not disable sibling; actor revocation disables all", () => {
  const sessions = authority();
  const first = sessions.issue("alice");
  const second = sessions.issue("alice");
  const bob = sessions.issue("bob");
  assert.ok(first && second && bob);
  assert.equal(sessions.revoke(first.sessionToken), true);
  assert.equal(sessions.revoke(first.sessionToken), false);
  assert.deepEqual(sessions.list(first.sessionToken, { scope: "personal" }), noList);
  assert.deepEqual(sessions.detail(first.sessionToken, { taskId: "private-alice" }), noDetail);
  assert.deepEqual(ids(sessions.list(second.sessionToken, { scope: "personal" })), ["private-alice"]);
  assert.equal(sessions.revokeActor("alice"), 1);
  assert.equal(sessions.revokeActor("alice"), 0);
  assert.deepEqual(sessions.list(second.sessionToken, { scope: "personal" }), noList);
  assert.deepEqual(ids(sessions.list(bob.sessionToken, { scope: "personal" })), ["private-bob"]);
});

test("new authority and close invalidate existing sessions without persisted revocation data", () => {
  const before = authority();
  const token = before.issue("alice");
  assert.ok(token);
  const afterRestart = authority();
  assert.deepEqual(afterRestart.list(token.sessionToken, { scope: "personal" }), noList);
  assert.deepEqual(afterRestart.detail(token.sessionToken, { taskId: "private-alice" }), noDetail);
  const replacement = afterRestart.issue("alice");
  assert.ok(replacement);
  before.close();
  assert.deepEqual(before.list(token.sessionToken, { scope: "personal" }), noList);
  assert.equal(before.issue("alice"), null);
  assert.equal(before.revoke(token.sessionToken), false);
  afterRestart.close();
  assert.deepEqual(afterRestart.list(replacement.sessionToken, { scope: "personal" }), noList);
});

test("expiration is enforced and removed from the in-process active registry", () => {
  const clock = Date.now;
  const start = clock();
  const sessions = authority();
  try {
    Date.now = () => start;
    const issued = sessions.issue("alice", 2);
    assert.ok(issued);
    assert.equal(sessions.list(issued.sessionToken, { scope: "personal" }).ok, true);
    Date.now = () => start + 3000;
    assert.deepEqual(sessions.list(issued.sessionToken, { scope: "personal" }), noList);
    assert.deepEqual(sessions.detail(issued.sessionToken, { taskId: "private-alice" }), noDetail);
    assert.equal(sessions.revoke(issued.sessionToken), false);
  } finally {
    Date.now = clock;
  }
});

test("bad generation, activation and missing staging store fail closed at issuance and read", () => {
  const sessions = authority();
  const existing = sessions.issue("alice");
  assert.ok(existing);
  writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(randomUUID());
  assert.deepEqual(sessions.list(existing.sessionToken, { scope: "personal" }), noList);
  assert.equal(sessions.issue("alice"), null);
  writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'")
    .run(stage.restoreGeneration);

  writer.prepare("UPDATE metadata SET value='true' WHERE key='activated'").run();
  assert.deepEqual(sessions.detail(existing.sessionToken, { taskId: "private-alice" }), noDetail);
  assert.equal(sessions.issue("alice"), null);
  writer.prepare("UPDATE metadata SET value='false' WHERE key='activated'").run();
  assert.equal(sessions.list(existing.sessionToken, { scope: "personal" }).ok, true);

  const absent = new TargetStagingSessionAuthority({
    stagingDirectory: path.join(root, "missing"), expectedRestoreGeneration: stage.restoreGeneration,
  });
  authorities.push(absent);
  assert.equal(absent.issue("alice"), null);
  assert.deepEqual(absent.list(existing.sessionToken, { scope: "personal" }), noList);
});

test("Area membership revocation applies on next read to an already issued session", () => {
  const sessions = authority();
  const bob = sessions.issue("bob");
  assert.ok(bob);
  assert.equal(sessions.detail(bob.sessionToken, { taskId: "shared-bob" }).ok, true);
  writer.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  writer.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(sessions.list(bob.sessionToken, { scope: "shared" })), []);
  assert.deepEqual(sessions.detail(bob.sessionToken, { taskId: "shared-bob" }),
    { ok: false, reason: "unavailable", task: null });
  assert.deepEqual(ids(sessions.list(bob.sessionToken, { scope: "personal" })), ["private-bob"]);
});
