import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-revision-cursors-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
const previousData = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const resources = [];

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const writer = new DatabaseSync(stage.databasePath);
  writer.exec("PRAGMA foreign_keys = ON");
  writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('shared','shared','alice')").run();
  writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('area-shared','Shared','shared','shared','alice')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area-shared','alice','admin')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area-shared','bob','viewer')").run();
  const insert = writer.prepare(
    "INSERT INTO tasks(id,project_id,area_id,title) VALUES (?,NULL,?,?)",
  );
  for (let i = 1; i <= 4; i++) {
    insert.run(`p-0${i}`, stage.unassignedAreaId, `Personal ${i}`);
  }
  for (let i = 1; i <= 3; i++) insert.run(`s-0${i}`, "area-shared", `Shared ${i}`);
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory,
    expectedRestoreGeneration: stage.restoreGeneration,
  });
  const ctx = { stage, writer, authority };
  resources.push(ctx);
  return ctx;
}

after(() => {
  for (const { authority, writer } of resources) {
    authority.close();
    writer.close();
  }
  if (previousData === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previousData;
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
  rmSync(root, { recursive: true, force: true });
});

const ids = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.tasks.map(t => t.id);
};
const invalid = { ok: false, reason: "invalid_request", tasks: [], nextCursor: null };
const stale = { ok: false, reason: "stale_cursor", tasks: [], nextCursor: null };
const denied = { ok: false, reason: "unauthorized", tasks: [], nextCursor: null };

test("signed page cursors traverse one unchanged store without duplicates", () => {
  const { authority } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  const first = authority.list(alice.sessionToken, { scope: "personal", limit: 2 });
  assert.deepEqual(ids(first), ["p-01", "p-02"]);
  assert.ok(first.nextCursor);
  assert.notEqual(first.nextCursor, "p-02", "never return an unsigned task ID");
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const second = authority.list(alice.sessionToken, {
    scope: "personal", limit: 2, cursor: first.nextCursor,
  });
  assert.deepEqual(ids(second), ["p-03", "p-04"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(ids(authority.list(alice.sessionToken, { scope: "personal" })),
    ["p-01", "p-02", "p-03", "p-04"]);
});

test("a signed cursor rejects a changed staging snapshot without exposing tasks", () => {
  const { authority, writer, stage } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  const first = authority.list(alice.sessionToken, { scope: "personal", limit: 2 });
  assert.deepEqual(ids(first), ["p-01", "p-02"]);
  writer.prepare("UPDATE tasks SET title='Modified' WHERE id='p-03'").run();

  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "personal", limit: 2, cursor: first.nextCursor,
  }), stale);
  const restarted = authority.list(alice.sessionToken, { scope: "personal", limit: 2 });
  assert.deepEqual(ids(restarted), ["p-01", "p-02"]);
  assert.ok(restarted.nextCursor);
  assert.deepEqual(ids(authority.list(alice.sessionToken, {
    scope: "personal", limit: 2, cursor: restarted.nextCursor,
  })), ["p-03", "p-04"]);

  writer.prepare("INSERT INTO tasks(id,project_id,area_id,title) VALUES (?,NULL,?,?)")
    .run("p-00", stage.unassignedAreaId, "Inserted ahead of page");
  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "personal", limit: 2, cursor: restarted.nextCursor,
  }), stale);
  assert.deepEqual(ids(authority.list(alice.sessionToken, {
    scope: "personal", limit: 2,
  })), ["p-00", "p-01"]);
});

test("revoked Area membership invalidates cursors and current direct reads", () => {
  const { authority, writer } = fixture();
  const bob = authority.issue("bob");
  assert.ok(bob);
  const first = authority.list(bob.sessionToken, { scope: "shared", limit: 1 });
  assert.deepEqual(ids(first), ["s-01"]);
  assert.ok(first.nextCursor);

  writer.prepare("DELETE FROM area_members WHERE area_id='area-shared' AND user_id='bob'").run();
  assert.deepEqual(authority.list(bob.sessionToken, {
    scope: "shared", limit: 1, cursor: first.nextCursor,
  }), stale);
  assert.deepEqual(ids(authority.list(bob.sessionToken, { scope: "shared" })), []);
  assert.deepEqual(authority.detail(bob.sessionToken, { taskId: "s-02" }),
    { ok: false, reason: "unavailable", task: null });
});

test("cursors reject tampering, scope changes, other sessions and raw keyset IDs", () => {
  const { authority } = fixture();
  const alice = authority.issue("alice");
  const sibling = authority.issue("alice");
  const bob = authority.issue("bob");
  assert.ok(alice && sibling && bob);
  const first = authority.list(alice.sessionToken, { scope: "personal", limit: 1 });
  assert.ok(first.ok && first.nextCursor);
  const cursor = first.nextCursor;
  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "shared", cursor,
  }), invalid);
  assert.deepEqual(authority.list(sibling.sessionToken, {
    scope: "personal", cursor,
  }), invalid);
  assert.deepEqual(authority.list(bob.sessionToken, {
    scope: "personal", cursor,
  }), invalid);
  const altered = cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a");
  for (const bad of ["", "not-a-cursor", altered, "x".repeat(4097)]) {
    assert.deepEqual(authority.list(alice.sessionToken, {
      scope: "personal", cursor: bad,
    }), invalid);
  }
  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "personal", afterTaskId: "p-01",
  }), invalid);

  assert.equal(authority.revoke(alice.sessionToken), true);
  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "personal", cursor,
  }), denied);
  assert.deepEqual(ids(authority.list(sibling.sessionToken, { scope: "personal" })),
    ["p-01", "p-02", "p-03", "p-04"]);
});

test("restore-generation invalidation takes precedence over a matching old cursor", () => {
  const { authority, writer } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  const first = authority.list(alice.sessionToken, { scope: "personal", limit: 1 });
  assert.ok(first.nextCursor);
  writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(randomUUID());
  assert.deepEqual(authority.list(alice.sessionToken, {
    scope: "personal", cursor: first.nextCursor,
  }), denied);
  assert.equal(authority.issue("alice"), null);
});
