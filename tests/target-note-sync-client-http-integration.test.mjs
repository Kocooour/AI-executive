/**
 * R2d note metadata end-to-end contract across the staging HTTP producer (#195)
 * and the volatile client reconciler (#196/#197). No browser, persistence,
 * external credentials, production data or UI activation.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createStagingNoteHttpClient } from "../lib/target-sync/note-http.ts";

const names = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_SECURITY_ALERT_FILE",
  "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-note-client-integration-"));
const sentinel = path.join(root, "production-sentinel");
mkdirSync(sentinel);
writeFileSync(path.join(sentinel, "keep"), "untouched");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = sentinel;
process.env.AI_EXECUTIVE_SECURITY_ALERT_FILE = path.join(root, "alerts.log");
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" +
  Buffer.alloc(16, 1).toString("base64url") + ":" +
  Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "note-client-integration-aead-secret-long-enough";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { GET } = await import("../app/api/target-staging/note-sync/route.ts");
const { GET: PREVIEW, PATCH: EDIT } =
  await import("../app/api/target-staging/notes/[noteId]/edit/route.ts");
const { DELETE: DELETE_NOTE } =
  await import("../app/api/target-staging/notes/[noteId]/route.ts");

after(() => {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(readFileSync(path.join(sentinel, "keep"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});

function fixture(extra = 0) {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const store = {
    stagingDirectory: stage.directory,
    expectedRestoreGeneration: stage.restoreGeneration,
  };
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const id of ["bob", "carol", "dave"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run("personal-" + id, id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Unassigned','private',?,?,'unassigned')")
      .run("private-" + id, "personal-" + id, id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [id, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(id, role);
  }
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('parent','team-area','Parent')").run();
  for (const id of ["one", "two", "three"]) {
    db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES (?,'team-area',?,'private contents never in feed')")
      .run(id, id);
  }
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('child','parent','Child','private contents never in feed')").run();
  const insert = db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES (?,'team-area',?,'secret')");
  for (let n = 0; n < extra; n++) {
    const id = "n" + String(n).padStart(3, "0");
    insert.run(id, id);
  }
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  return { stage, store };
}

function login(fx, actor) {
  const session = durable.issueDurableTargetStagingSession(fx.store, actor, 900);
  assert.equal(session.ok, true);
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + session.sessionToken;
}
function scope(fx, actor) {
  return { userId: actor, areaId: "team-area", restoreGeneration: fx.stage.restoreGeneration };
}
function transport(cookie, observe = () => {}) {
  return async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    const request = new Request(new URL(url, "http://localhost:3001"), {
      method: "GET", headers: {
        cookie, "x-forwarded-for": "10.22.33.44",
        accept: "application/json",
      }, signal: init.signal,
    });
    const response = await GET(request);
    await observe(response.clone());
    return response;
  };
}
function makeClient(fx, actor, cookie, observe) {
  const client = createStagingNoteHttpClient(transport(cookie, observe));
  client.activate(scope(fx, actor));
  return client;
}
async function preview(cookie) {
  const req = new Request("http://localhost:3001/api/target-staging/notes/one/edit", {
    headers: { cookie, "x-forwarded-for": "10.22.33.44" },
  });
  const response = await PREVIEW(req, { params: Promise.resolve({ noteId: "one" }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function write(cookie, method) {
  const data = { ...await preview(cookie), commandId: randomUUID() };
  if (method === "PATCH") Object.assign(data, { title: "one", body: "Edited contents" });
  const request = new Request("http://localhost:3001/api/target-staging/notes/one" +
    (method === "PATCH" ? "/edit" : ""), {
    method, headers: {
      cookie, origin: "http://localhost:3001", "content-type": "application/json",
      "x-lumi-target-protocol": "1", "x-forwarded-for": "10.22.33.44",
    }, body: JSON.stringify(data),
  });
  const response = method === "PATCH"
    ? await EDIT(request, { params: Promise.resolve({ noteId: "one" }) })
    : await DELETE_NOTE(request, { params: Promise.resolve({ noteId: "one" }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
}
const applied = result => assert.equal(result.kind, "applied", JSON.stringify(result));

test("real 205-note HTTP bootstrap stays hidden until complete; edit/delete journal advances client", async () => {
  const fx = fixture(201);
  const bob = login(fx, "bob");
  const client = makeClient(fx, "bob", bob);
  for (let i = 0; i < 2; i++) {
    const result = await client.pull();
    applied(result);
    assert.equal(result.phase, "bootstrap");
    assert.equal(result.more, true);
    assert.deepEqual(client.read(), [], "no partial Area manifest may be released");
  }
  const complete = await client.pull();
  applied(complete);
  assert.equal(complete.phase, "changes");
  assert.equal(complete.more, false);
  assert.equal(client.read().length, 205);
  assert.ok(client.read().some(note => note.id === "child" &&
    note.projectId === "parent" && typeof note.parentRevision === "number"));
  assert.equal(JSON.stringify(client.read()).includes("private contents"), false);

  await write(bob, "PATCH");
  await write(bob, "DELETE");
  applied(await client.pull());
  assert.equal(client.read().length, 204);
  assert.equal(client.read().some(note => note.id === "one"), false);
  assert.equal(client.read().some(note => note.id === "two"), true);
});

test("real producer rejects cross-actor cursor and nonmember access; viewer can bootstrap", async () => {
  const fx = fixture(201);
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  let bobCursor;
  const bobClient = makeClient(fx, "bob", bob, async response => {
    if (response.status === 200) bobCursor = (await response.json()).cursor;
  });
  applied(await bobClient.pull());
  assert.deepEqual(bobClient.read(), []);
  const carolClient = makeClient(fx, "carol", carol);
  applied(await carolClient.pull());
  assert.deepEqual(carolClient.read(), []);

  const replay = await GET(new Request("http://localhost:3001/api/target-staging/note-sync?" +
    new URLSearchParams({ areaId: "team-area", cursor: bobCursor }), {
    headers: { cookie: carol, "x-forwarded-for": "10.22.33.44" },
  }));
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { code: "resync_required" });

  const outsider = makeClient(fx, "dave", dave);
  assert.deepEqual(await outsider.pull(), { kind: "locked" });
  assert.deepEqual(outsider.read(), []);
  assert.equal(outsider.currentScope(), null);
  applied(await carolClient.pull());
  applied(await carolClient.pull());
  assert.equal(carolClient.read().length, 205);
});

test("Area removal between real HTTP bootstrap pages locks and discards hidden state", async () => {
  const fx = fixture(201), bob = login(fx, "bob");
  const client = makeClient(fx, "bob", bob);
  applied(await client.pull());
  assert.deepEqual(client.read(), []);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  db.close();
  assert.deepEqual(await client.pull(), { kind: "locked" });
  assert.equal(client.currentScope(), null);
  assert.deepEqual(client.read(), []);
  assert.deepEqual(await client.pull(), { kind: "inactive" });
});

test("raw unjournaled note creation triggers real 409 and cursorless full rebootstrap", async () => {
  const fx = fixture(), bob = login(fx, "bob");
  const client = makeClient(fx, "bob", bob);
  applied(await client.pull());
  assert.equal(client.read().length, 4);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('late','team-area','Late','private')")
    .run();
  db.close();
  assert.deepEqual(await client.pull(), { kind: "resync_required" });
  assert.deepEqual(client.read(), []);
  applied(await client.pull());
  assert.equal(client.read().length, 5);
  assert.equal(client.read().some(note => note.id === "late"), true);
});

test("durable session revocation causes HTTP 401 and local cache wipe", async () => {
  const fx = fixture(), bob = login(fx, "bob");
  const client = makeClient(fx, "bob", bob);
  applied(await client.pull());
  assert.equal(client.read().length, 4);
  const hash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const current = durable.verifyDurableTargetStagingSessionLive(fx.store, hash);
  assert.equal(current.ok, true);
  durable.revokeDurableTargetStagingSession(fx.store, current.sessionId);
  assert.deepEqual(await client.pull(), { kind: "locked" });
  assert.equal(client.currentScope(), null);
  assert.deepEqual(client.read(), []);
});
