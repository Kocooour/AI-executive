import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const keys = ["NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_SECURITY_ALERT_FILE",
  "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-structural-relations-"));
const legacy = path.join(root, "production-sentinel");
mkdirSync(legacy); writeFileSync(path.join(legacy, "keep"), "untouched");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_SECURITY_ALERT_FILE = path.join(root, "alerts.log");
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH =
  "scrypt:" + Buffer.alloc(16, 1).toString("base64url") + ":" +
  Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "staging-structural-relations-secret-long-enough";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED = "true";
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/projects/[projectId]/relations/route.ts");
const { parseStagingStructuralRelations } =
  await import("../lib/target-staging-read-process.ts");
const { readStagingProjectStructuralRelationsInChild } =
  await import("../lib/target-staging-read-process.ts");
const { verifyStagingReadBeforeRelease } =
  await import("../lib/target-staging-http-identity.ts");

after(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  assert.equal(readFileSync(path.join(legacy, "keep"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const id of ["bob", "carol", "dave"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run("personal-" + id, id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Private','private',?,?,'unassigned')")
      .run("private-" + id, "personal-" + id, id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [id, role] of [["alice","admin"],["bob","editor"],["carol","viewer"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(id,role);
  }
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','team-area','Secret project')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('q','team-area','Other project')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('private-p',?,'Private secret')")
    .run(stage.unassignedAreaId);
  const task = db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?,'p','Sensitive task')");
  task.run("t1");task.run("t2");
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('hidden','private-p','Very secret task')").run();
  const note = db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES (?,'p','Private title','Do not leak body')");
  note.run("n1");note.run("n2");
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('hidden-note','private-p','Hidden','Hidden body')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  return { stage, store: { stagingDirectory: stage.directory,
    expectedRestoreGeneration: stage.restoreGeneration } };
}
function login(fx, actor) {
  const issued = durable.issueDurableTargetStagingSession(fx.store, actor, 900);
  assert.equal(issued.ok, true);
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + issued.sessionToken;
}
const owner = () => sessionCookieName + "=" + createSessionToken();
async function get(cookie, projectId = "p", query = "") {
  const request = new Request("http://localhost:3001/api/target-staging/projects/" +
    encodeURIComponent(projectId) + "/relations" + query, {
    headers: cookie ? { cookie, "x-forwarded-for": "10.49.22.33" } :
      { "x-forwarded-for": "10.49.22.33" },
  });
  const response = await GET(request, { params: Promise.resolve({ projectId }) });
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}

test("staging structural edges: current roles, real session, signed cursor, strict external DTO", async () => {
  const fx = fixture();
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED = "false";
  assert.equal((await get(bob)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED = "true";
  assert.equal((await get(null)).status, 401);
  assert.deepEqual(await get(dave), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await get(bob, "private-p"), { status: 404, body: { error: "Not found" } });
  assert.equal((await get(owner(), "private-p")).status, 200);
  const first = await get(bob, "p", "?limit=1");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.relations, [{
    predicate: "contains_note", projectId: "p", targetId: "n1",
  }]);
  assert.equal(first.body.hasMore, true);
  assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  for (const word of ["Sensitive", "Private title", "Do not leak", "hidden", "role",
    "member", "secret", "epoch", "stamp", "taskGuardIds", "policyRevision"]) {
    assert.equal(JSON.stringify(first.body).includes(word), false, word);
  }
  assert.deepEqual(Object.keys(first.body).sort(), ["hasMore", "nextCursor", "relations"]);
  const next = await get(bob, "p", "?limit=1&cursor=" + first.body.nextCursor);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(next.body.relations.map(r => r.targetId), ["n2"]);
  assert.equal((await get(carol)).status, 200, "viewer may read canonical structural links");
  assert.equal((await get(dave, "p", "?cursor=" + first.body.nextCursor)).status, 400);
  assert.equal((await get(bob, "q", "?cursor=" + first.body.nextCursor)).status, 400);
  assert.equal((await get(bob, "p", "?actor=alice")).status, 400);
  assert.equal((await get(bob, "p", "?limit=51")).status, 400);
  assert.equal((await get(bob, "p", "?limit=1&limit=1")).status, 400);
  const all = await get(bob);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.relations.map(x => x.targetId), ["n1","n2","t1","t2"]);
  assert.equal(all.body.nextCursor, null);
});

test("stale relation cursor fails and current membership / note stamp revoke release", async () => {
  const fx = fixture(), bob = login(fx, "bob");
  const first = await get(bob, "p", "?limit=1");
  assert.equal(first.status, 200);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  // Parentage changes must stale old continuation even after a revert.
  db.prepare("UPDATE notes SET project_id='q' WHERE id='n2'").run();
  assert.equal((await get(bob, "p", "?limit=1&cursor="+first.body.nextCursor)).status, 409);
  const restored = await get(bob, "p");
  assert.deepEqual(restored.body.relations.map(x=>x.targetId), ["n1","t1","t2"]);
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal((await get(bob)).status, 404);
  const carol = login(fx, "carol");
  const auth = await readStagingProjectStructuralRelationsInChild({
    ...fx.store, ownerUserId: "alice", sessionTokenHash: durable.hashTargetStagingSessionToken(
      carol.split("=")[1]),
  }, "p", 2, 0);
  assert.equal(auth?.ok, true, JSON.stringify(auth));
  const identity = { kind: "session",
    tokenHash: durable.hashTargetStagingSessionToken(carol.split("=")[1]) };
  const request = new Request("http://localhost/api/target-staging/projects/p/relations",
    { headers: { cookie: carol } });
  const release = () => verifyStagingReadBeforeRelease(request, identity, fx.store, "alice",
    auth.page.linearization,
    { projectId: "p", areaId: auth.page.stamp.areaId, taskIds: auth.page.taskGuardIds },
    undefined, undefined, auth.page.stamp);
  assert.equal(release(), "ok");
  db.prepare("UPDATE notes SET body='Changed' WHERE id='n1'").run();
  assert.equal(release(), "stale", "note mutation invalidates snapshot even without title/body in DTO");
  db.close();
});

test("strict child DTO refuses extra keys, forged relationships and hidden metadata", () => {
  const a = { ok: true, relations: [{
    predicate: "contains_note", projectId: "p", targetId: "n1",
  }], hasMore: false, revision: "a".repeat(64), taskGuardIds: [],
  stamp: { areaId: "team-area", epoch: 0, contentRevision: 1, head: 1 },
  linearization: { actorUserId: "bob", areas: [{
    areaId: "team-area", areaKind: "shared", policyRevision: 0, access: "editor",
  }] } };
  assert.ok(parseStagingStructuralRelations(a, "p", 5)?.ok);
  assert.equal(parseStagingStructuralRelations({ ...a, noteBody: "secret" }, "p", 5), null);
  assert.equal(parseStagingStructuralRelations({ ...a, relations: [{
    predicate: "linked_to", projectId: "p", targetId: "n1",
  }] }, "p", 5), null);
  assert.equal(parseStagingStructuralRelations({ ...a, relations: [{
    predicate: "contains_note", projectId: "q", targetId: "n1",
  }] }, "p", 5), null);
  assert.equal(parseStagingStructuralRelations({ ...a, taskGuardIds: ["foreign-task"] }, "p", 5), null);
});
