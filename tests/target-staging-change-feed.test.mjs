import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.2a: bootstrap, Area bootstrap and the authorized change feed over HTTP.
// Synthetic identities and temp stores only; changes between requests are raw SQL in a
// separate process, as an operator or a parallel command would commit them.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c2a-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const REAL_NODE = process.execPath;
const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY", "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const SECRET = "synthetic-r2c2a-session-secret-2026-10-30";
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = SECRET;
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const feedCursor = await import("../lib/target-staging-feed-cursor.ts");
const readProcess = await import("../lib/target-staging-read-process.ts");
const { GET: FEED } = await import("../app/api/target-staging/changes/route.ts");

after(() => {
  process.execPath = REAL_NODE;
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const base = "http://localhost:3001/api/target-staging/";
let counter = 0;

/**
 * Identities: alice (A, admin of family-area, store owner), bob (B, editor), carol (C, viewer),
 * dave (D, member of nothing), erin (admin of other-area, "T", which B/C/D are never members of).
 */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, name), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol", "dave", "erin"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
      .run(`${user}-personal`, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other','shared','erin')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','other','erin')").run();
  const member = db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)");
  member.run("family-area", "alice", "admin");
  member.run("family-area", "bob", "editor");
  member.run("family-area", "carol", "viewer");
  member.run("other-area", "erin", "admin");
  const task = db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)");
  task.run("f-1", "family-area", "Family one", "alice");
  task.run("f-2", "family-area", "Family two", "bob");
  task.run("f-3", "family-area", "Family three", null);
  task.run("f-4", "family-area", "Family four", "alice");
  task.run("f-5", "family-area", "Family five", "bob");
  task.run("o-1", "other-area", "Other one", "erin");
  task.run("o-2", "other-area", "Other two", null);
  task.run("p-alice-1", stage.unassignedAreaId, "Alice private one", null);
  task.run("p-bob-1", "bob-private", "Bob private one", null);
  task.run("p-dave-1", "dave-private", "Dave private one", null);
  db.close();
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const fixture = { name, stage, store, databasePath: stage.databasePath, client: `10.3.0.${counter}` };
  activate(fixture);
  return fixture;
}

function activate(fixture) {
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fixture.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fixture.stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}

/** Raw SQL in a SEPARATE process. */
function mutate(fixture, sql) {
  const run = spawnSync(REAL_NODE, ["-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1]);
     db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
     db.exec(process.argv[2]); db.close();`,
    fixture.databasePath, sql], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}
const removeMemberSql = (user, area = "family-area") => `BEGIN;
  UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='${user}' AND area_id='${area}';
  DELETE FROM area_members WHERE area_id='${area}' AND user_id='${user}'; COMMIT;`;
const addMemberSql = (user, role, area = "family-area") =>
  `INSERT INTO area_members(area_id,user_id,role) VALUES ('${area}','${user}','${role}');`;
/** Delete a task the way the command does: tombstone at the next sequence first, then DELETE. */
const deleteTaskSql = id => `BEGIN;
  INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms)
    SELECT t.id, COALESCE(t.area_id,(SELECT area_id FROM projects WHERE id=t.project_id)), t.revision+1,
      (SELECT COALESCE(MAX(seq),0)+1 FROM change_log), ${Date.now()} FROM tasks t WHERE t.id='${id}';
  DELETE FROM tasks WHERE id='${id}'; COMMIT;`;
const titleSql = (id, title) => `UPDATE tasks SET title='${title}' WHERE id='${id}';`;

const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
function login(fixture, user) {
  const issued = durable.issueDurableTargetStagingSession(fixture.store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return { ...issued, cookie: sessionCookie(issued.sessionToken), user };
}
const ownerCookie = () => `${sessionCookieName}=${createSessionToken()}`;

const feedRequest = (fixture, cookie, cursor, extra = "") => FEED(new Request(
  `${base}changes${cursor ? "?cursor=" + cursor : ""}${extra}`,
  { headers: { cookie, "x-forwarded-for": fixture.client } }));
const okJson = async (responsePromise, label = "") => {
  const response = await responsePromise;
  const text = await response.text();
  assert.equal(response.status, 200, `${label} status ${response.status}: ${text.slice(0, 300)}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return JSON.parse(text);
};
const page = (fx, who, cursor, label) => okJson(feedRequest(fx, who.cookie ?? who, cursor), label);

/** Follow `more` until the page chain ends. Returns everything served plus the final cursor. */
async function drain(fx, who, cursor = null, onPage = async () => {}) {
  const items = [];
  const phases = [];
  let pages = 0;
  for (;;) {
    const body = await page(fx, who, cursor, `drain page ${pages}`);
    pages++;
    phases.push(body.phase);
    items.push(...body.items);
    cursor = body.cursor;
    if (body.phase === "area_bootstrap" ? body.done : !body.more) return { items, cursor, pages, phases, last: body };
    await onPage(pages, body);
  }
}

/** Minimal client applier: revision order, tombstone precedence, scope/access removal. */
function applyAll(state, items) {
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (item.type === "upsert") {
      const current = state.items.get(key);
      if (state.tombstones.has(key)) continue;
      if (current && current.revision > item.revision && current.areaId === item.areaId) continue;
      state.items.set(key, { revision: item.revision, areaId: item.areaId, title: item.title });
    } else if (item.type === "tombstone") {
      state.tombstones.add(key);
      state.items.delete(key);
    } else if (item.type === "left_scope") {
      if (state.items.get(key)?.areaId === item.areaId) state.items.delete(key);
    } else if (item.type === "access_lost") {
      for (const [k, v] of state.items) if (v.areaId === item.areaId) state.items.delete(k);
    }
  }
  return state;
}
const newState = () => ({ items: new Map(), tombstones: new Set() });
const view = state => [...state.items].map(([key, v]) => `${key}|${v.areaId}|${v.title}`).sort();
const types = items => items.map(item => item.type);
const decrypt = token => {
  const opened = feedCursor.openStagingFeedCursor(SECRET, token);
  assert.equal(opened.ok, true);
  return opened.claims;
};
const seedBulk = (fx, count, area = "family-area") => {
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const insert = db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  for (let i = 1; i <= count; i++) insert.run(`bt-${String(i).padStart(3, "0")}`, area, `Bulk ${i}`);
  db.close();
};

test("bootstrap: current state of exactly the readable Areas, 100 per page, then a feed cursor", async () => {
  const fx = makeFixture();
  seedBulk(fx, 230);
  const [a, b, d] = ["alice", "bob", "dave"].map(user => login(fx, user));
  const first = await page(fx, a, null, "first page");
  assert.equal(first.phase, "bootstrap");
  assert.equal(first.items.length, 100);
  assert.equal(first.more, true);
  assert.equal(decrypt(first.cursor).pos.ph, "b");
  const all = await drain(fx, a);
  assert.deepEqual(all.phases, ["bootstrap", "bootstrap", "bootstrap"]);
  assert.equal(all.items.length, 235 + 1, "235 family tasks + alice's private task");
  assert.equal(new Set(all.items.map(i => i.id)).size, all.items.length, "no duplicates");
  assert.equal(all.last.more, false);
  assert.equal(decrypt(all.cursor).pos.ph, "f", "the last bootstrap page hands out a feed cursor");
  // Keyset order: (areaId, kind, id) ascending, never an offset.
  const keys = all.items.map(i => [i.areaId, i.kind, i.id]);
  assert.deepEqual(keys, [...keys].sort((x, y) => (x.join("\0") < y.join("\0") ? -1 : 1)));
  const shared = all.items.find(i => i.id === "f-2");
  assert.deepEqual(Object.keys(shared).sort(), ["areaId", "areaKind", "assignedToMe", "effectiveAreaId",
    "id", "kind", "projectId", "revision", "title", "type"]);
  assert.equal(JSON.stringify(all.items).includes("bob"), false, "no other identity ids in rows");

  // B and D never see foreign Areas, private tasks of others or other members.
  const bState = await drain(fx, b);
  assert.deepEqual(bState.items.map(i => i.areaId).filter((v, i, arr) => arr.indexOf(v) === i).sort(),
    ["bob-private", "family-area"]);
  assert.equal(JSON.stringify(bState.items).includes("Other"), false);
  const dState = await drain(fx, d);
  assert.deepEqual(dState.items.map(i => i.id), ["p-dave-1"]);
});

test("bootstrap barrier: change, delete and move after the first page converge with an atomic read", async () => {
  const fx = makeFixture();
  seedBulk(fx, 230);
  const b = login(fx, "bob");
  const state = newState();
  const boot = await drain(fx, b, null, async pageNumber => {
    if (pageNumber !== 1) return;
    mutate(fx, `${titleSql("bt-200", "Changed later")}
      ${deleteTaskSql("bt-010")} ${deleteTaskSql("bt-150")}
      UPDATE tasks SET area_id='other-area' WHERE id='bt-220';
      INSERT INTO tasks(id,area_id,title) VALUES ('a-new','family-area','Inserted before the served keys');`);
  });
  applyAll(state, boot.items);
  const replay = await drain(fx, b, boot.cursor);
  applyAll(state, replay.items);
  assert.equal(replay.last.more, false);
  assert.ok(types(replay.items).includes("left_scope"), "B left bt-220's scope");
  assert.ok(types(replay.items).includes("tombstone"));

  const atomic = newState();
  applyAll(atomic, (await drain(fx, b)).items);
  assert.deepEqual(view(state), view(atomic), "bootstrap + feed from W == atomic read");
  const flat = view(state).join("\n");
  assert.ok(flat.includes("bt-200|family-area|Changed later"));
  assert.ok(flat.includes("a-new|family-area"));
  for (const gone of ["bt-010", "bt-150", "bt-220"]) assert.equal(flat.includes(gone), false, gone);
});

test("keyset: deleting an earlier item between pages does not skip an unchanged later item", async () => {
  const fx = makeFixture();
  seedBulk(fx, 130);
  const a = login(fx, "alice");
  const first = await page(fx, a, null);
  const lastServed = first.items[first.items.length - 1].id;
  // Delete a served item (it is before the page boundary): offset paging would skip a neighbour.
  mutate(fx, deleteTaskSql(first.items[3].id));
  const second = await page(fx, a, first.cursor);
  const served = new Set([...first.items, ...second.items].map(i => i.id));
  const everyone = ["f-1", "f-2", "f-3", "f-4", "f-5", "p-alice-1",
    ...Array.from({ length: 130 }, (_, i) => `bt-${String(i + 1).padStart(3, "0")}`)];
  const missing = everyone.filter(id => id !== first.items[3].id && !served.has(id));
  assert.deepEqual(missing, [], `skipped after deleting an earlier item (boundary ${lastServed})`);
});

test("bootstrap: an Area lost since bootstrap start is skipped and announced once (only to a former member)", async () => {
  const fx = makeFixture();
  seedBulk(fx, 130);
  mutate(fx, addMemberSql("bob", "viewer", "other-area"));
  const b = login(fx, "bob");
  const boot = await drain(fx, b, null, async pageNumber => {
    if (pageNumber === 1) mutate(fx, removeMemberSql("bob", "other-area"));
  });
  assert.equal(boot.items.some(i => i.areaId === "other-area" && i.type === "upsert"), false);
  assert.deepEqual(boot.items.filter(i => i.type === "access_lost"), [{ type: "access_lost", areaId: "other-area" }]);
  // D was never a member of any shared Area: nothing is announced, whatever happens to them.
  const d = login(fx, "dave");
  assert.deepEqual((await drain(fx, d)).items.filter(i => i.type !== "upsert"), []);
});

/** n shared Areas z-area-NNN (alice admin, bob viewer), one task each; raw SQL in one transaction. */
const seedAreas = (fx, count) => {
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, "0");
    db.exec(`INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('zw-${n}','shared','alice');
      INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('z-area-${n}','Z ${n}','shared','zw-${n}','alice');
      INSERT INTO area_members(area_id,user_id,role) VALUES ('z-area-${n}','alice','admin'),('z-area-${n}','bob','viewer');
      INSERT INTO tasks(id,area_id,title) VALUES ('z-task-${n}','z-area-${n}','Z task ${n}');`);
  }
  db.exec("COMMIT");
  db.close();
};

test("bootstrap: >100 Areas lost mid-bootstrap -> every page <=100 items, each notice once, no data", async () => {
  const fx = makeFixture();
  seedAreas(fx, 250);
  const b = login(fx, "bob");
  const pages = [];
  const boot = await drain(fx, b, null, async (pageNumber, body) => {
    pages.push(body);
    if (pageNumber === 1) mutate(fx, "DELETE FROM area_members WHERE user_id='bob' AND area_id LIKE 'z-area-%';");
  });
  pages.push(boot.last);
  assert.ok(pages.length >= 3);
  for (const body of pages) assert.ok(body.items.length <= 100, `page of ${body.items.length}`);
  const served = new Set(pages[0].items.filter(i => i.type === "upsert").map(i => i.areaId));
  const lostAreas = boot.items.filter(i => i.type === "access_lost").map(i => i.areaId);
  assert.equal(new Set(lostAreas).size, lostAreas.length, "each notice exactly once");
  // Unserved Areas, plus the page-1 boundary Area (served, then lost) which is also announced.
  const boundary = decrypt(pages[0].cursor).pos.k[0];
  const unserved = lostAreas.filter(id => !served.has(id));
  assert.equal(unserved.length, 250 - [...served].filter(a => a.startsWith("z-area-")).length);
  assert.ok(lostAreas.filter(id => served.has(id)).every(id => id === boundary));
  for (const body of pages.slice(1)) {
    assert.equal(body.items.some(i => i.type === "upsert"), false, "no data from lost Areas");
  }
  // Every Area is either served on page 1 or announced as lost: nothing disappears silently.
  for (let i = 0; i < 250; i++) {
    const id = `z-area-${String(i).padStart(4, "0")}`;
    assert.ok(served.has(id) || lostAreas.includes(id), id);
  }
  assert.equal(decrypt(boot.cursor).pos.ph, "f");
});

test("feed: more relevant Areas than the staging bound -> 409 resync_required, never 503", async () => {
  const fx = makeFixture();
  const a = login(fx, "alice");
  const start = await drain(fx, a);
  seedAreas(fx, 1001);
  const response = await feedRequest(fx, a.cookie, start.cursor);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "resync_required" });
});

test("hidden activity: 50 changes in an Area the actor cannot see change neither response nor position", async () => {
  const fx = makeFixture();
  for (const user of ["dave", "bob"]) {
    const who = login(fx, user);
    const start = await drain(fx, who);
    const poll1 = await page(fx, who, start.cursor);
    const hidden = Array.from({ length: 48 }, (_, i) => titleSql("o-1", `Hidden ${user} ${i}`)).join("") +
      deleteTaskSql("o-2") + addMemberSql("carol", "viewer", "other-area");
    mutate(fx, hidden);
    const poll2 = await page(fx, who, poll1.cursor);
    const strip = ({ cursor, ...rest }) => JSON.stringify(rest);
    assert.equal(strip(poll2), strip(poll1), `${user}: identical response content`);
    assert.deepEqual(poll1.items, []);
    assert.notEqual(poll2.cursor, poll1.cursor, "fresh nonce every time");
    assert.equal(poll2.cursor.length, poll1.cursor.length);
    assert.deepEqual(decrypt(poll2.cursor), decrypt(poll1.cursor), `${user}: identical position`);
    assert.deepEqual(decrypt(poll1.cursor), decrypt(start.cursor), `${user}: position never moved`);
    mutate(fx, "DELETE FROM area_members WHERE area_id='other-area' AND user_id='carol';");
  }
});

test("B removed: only access_lost and no data, also for a second device; later activity stays silent", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  const device1 = await drain(fx, b);
  const device2 = await drain(fx, b);
  mutate(fx, `${titleSql("f-5", "Edited while B was a member")} ${removeMemberSql("bob")}
    ${titleSql("f-3", "Edited after removal")} ${deleteTaskSql("f-4")}`);
  for (const device of [device1, device2]) {
    const body = await page(fx, b, device.cursor);
    assert.deepEqual(body.items, [{ type: "access_lost", areaId: "family-area" }]);
    assert.equal(JSON.stringify(body).includes("Family"), false);
    assert.equal(JSON.stringify(body).includes("Edited"), false);
    const again = await page(fx, b, body.cursor);
    assert.deepEqual(again.items, []);
  }
  // A fresh bootstrap after removal contains no family data at all.
  const fresh = await drain(fx, b);
  assert.deepEqual(fresh.items.map(i => i.areaId), ["bob-private"]);
});

test("remove + re-add between polls: access_lost then access_granted, nothing from the gap, Area bootstrap is current", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  const start = await drain(fx, b);
  mutate(fx, `${removeMemberSql("bob")} ${titleSql("f-3", "Gap title")} ${deleteTaskSql("f-4")}`);
  mutate(fx, addMemberSql("bob", "editor"));
  mutate(fx, titleSql("f-1", "After re-add"));
  const body = await page(fx, b, start.cursor);
  // f-2 / f-5 were unassigned BEFORE the removal, while B was still a member (visible then).
  assert.deepEqual(types(body.items), ["upsert", "upsert", "access_lost", "access_granted", "upsert"]);
  assert.deepEqual(body.items.slice(0, 2).map(i => i.id), ["f-2", "f-5"]);
  assert.equal(body.items[2].areaId, "family-area");
  assert.equal(body.items[3].role, "editor");
  assert.equal(body.items[4].title, "After re-add");
  assert.equal(JSON.stringify(body.items).includes("Gap title"), false);
  assert.equal(types(body.items).includes("tombstone"), false, "no tombstone from the gap");
  // The area cursor is encrypted, identity-bound and carries the grant, not the log head.
  const area = decrypt(body.items[3].areaCursor);
  assert.equal(area.pos.ph, "a");
  assert.equal(area.pos.a, "family-area");
  const bootstrapped = await drain(fx, b, body.items[3].areaCursor);
  assert.equal(bootstrapped.last.done, true);
  assert.equal(bootstrapped.last.cursor, null, "no feed cursor from an Area bootstrap");
  assert.deepEqual(bootstrapped.items.map(i => i.id).sort(), ["f-1", "f-2", "f-3", "f-5"]);
  assert.equal(bootstrapped.items.find(i => i.id === "f-3").title, "Gap title", "current state incl. unchanged tasks");
});

test("new member D: access_granted and an Area bootstrap with every existing task", async () => {
  const fx = makeFixture();
  const d = login(fx, "dave");
  const start = await drain(fx, d);
  mutate(fx, addMemberSql("dave", "viewer"));
  const body = await page(fx, d, start.cursor);
  assert.deepEqual(types(body.items), ["access_granted"]);
  assert.equal(body.items[0].role, "viewer");
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["areaCursor", "areaId", "role", "type"]);
  const area = await drain(fx, d, body.items[0].areaCursor);
  assert.deepEqual(area.items.map(i => i.id).sort(), ["f-1", "f-2", "f-3", "f-4", "f-5"]);
  assert.equal(area.last.phase, "area_bootstrap");
  assert.equal(area.last.done, true);
  // The main feed cursor is unaffected and continues without re-sending the history.
  assert.deepEqual((await page(fx, d, body.cursor)).items, []);
  // An Area cursor of a lost Area serves nothing and reveals nothing.
  mutate(fx, removeMemberSql("dave"));
  const lost = await page(fx, d, body.items[0].areaCursor);
  assert.deepEqual(lost, { phase: "area_bootstrap", items: [], done: true, cursor: null });
});

test("moving a task out of B's Area: left_scope for the old Area and nothing about the target", async () => {
  const fx = makeFixture();
  const [b, erin] = ["bob", "erin"].map(user => login(fx, user));
  const startB = await drain(fx, b);
  const startErin = await drain(fx, erin);
  mutate(fx, "UPDATE tasks SET area_id='other-area' WHERE id='f-3';");
  const body = await page(fx, b, startB.cursor);
  assert.deepEqual(body.items, [{ type: "left_scope", kind: "task", id: "f-3", areaId: "family-area" }]);
  assert.equal(JSON.stringify(body).includes("other"), false);
  const target = await page(fx, erin, startErin.cursor);
  assert.deepEqual(types(target.items), ["upsert"]);
  assert.equal(target.items[0].areaId, "other-area");
  assert.equal(JSON.stringify(target).includes("family"), false, "T's member learns nothing of S");
});

test("moving a project (guard dropped as in the change-log tests): left_scope for the project and its tasks", async () => {
  const fx = makeFixture();
  mutate(fx, `INSERT INTO projects(id,area_id,title) VALUES ('pr-1','family-area','Project');
    INSERT INTO tasks(id,project_id,title) VALUES ('pt-1','pr-1','In project one'),('pt-2','pr-1','In project two');`);
  const b = login(fx, "bob");
  const start = await drain(fx, b);
  assert.deepEqual(start.items.filter(i => i.kind === "project"),
    [{ type: "upsert", kind: "project", id: "pr-1", revision: 0, areaId: "family-area", areaKind: "shared", title: "Project" }]);
  // Fixture only (there is no project move command): lift the guard for one statement and
  // restore its exact definition, so the store still passes canonical preflight.
  const raw = new DatabaseSync(fx.databasePath);
  const guard = raw.prepare("SELECT sql FROM sqlite_master WHERE name='project_area_assignment_guard'").get().sql;
  raw.exec("PRAGMA foreign_keys=ON; DROP TRIGGER project_area_assignment_guard");
  raw.exec("UPDATE projects SET area_id='other-area' WHERE id='pr-1'");
  raw.exec(guard);
  raw.close();
  const body = await page(fx, b, start.cursor);
  const left = body.items.map(i => `${i.type}:${i.kind}:${i.id}:${i.areaId}`).sort();
  assert.deepEqual(left, [
    "left_scope:project:pr-1:family-area", "left_scope:task:pt-1:family-area", "left_scope:task:pt-2:family-area"]);
  assert.equal(JSON.stringify(body).includes("other"), false);
});

test("own role change: only that member gets role_changed", async () => {
  const fx = makeFixture();
  const who = Object.fromEntries(["alice", "bob", "carol", "dave"].map(user => [user, login(fx, user)]));
  const start = {};
  for (const [user, session] of Object.entries(who)) start[user] = await drain(fx, session);
  mutate(fx, "UPDATE area_members SET role='editor' WHERE area_id='family-area' AND user_id='carol';");
  assert.deepEqual((await page(fx, who.carol, start.carol.cursor)).items,
    [{ type: "role_changed", areaId: "family-area", role: "editor" }]);
  for (const user of ["alice", "bob", "dave"]) {
    assert.deepEqual((await page(fx, who[user], start[user].cursor)).items, [], user);
  }
});

test("feed paging: 100 entries per page, `more` while full, deleted tasks become tombstones", async () => {
  const fx = makeFixture();
  const a = login(fx, "alice");
  const start = await drain(fx, a);
  mutate(fx, `BEGIN; ${Array.from({ length: 120 }, (_, i) =>
    `INSERT INTO tasks(id,area_id,title) VALUES ('n-${String(i).padStart(3, "0")}','family-area','New ${i}');`).join("")} COMMIT;
    ${titleSql("f-2", "Edited then deleted")} ${deleteTaskSql("f-2")}`);
  const one = await page(fx, a, start.cursor);
  assert.equal(one.items.length, 100);
  assert.equal(one.more, true);
  const two = await page(fx, a, one.cursor);
  assert.equal(two.more, false);
  const all = [...one.items, ...two.items];
  assert.equal(all.filter(i => i.type === "upsert").length, 120);
  assert.deepEqual(all.filter(i => i.type === "tombstone").map(i => i.id), ["f-2"]);
  assert.equal(all.some(i => i.id === "f-2" && i.type === "upsert"), false, "not readable any more: no upsert");
});

test("cursor: tampered / garbage / foreign identity / revokeAll / other store / revokeSession", async () => {
  const fx = makeFixture();
  const [a, b] = ["alice", "bob"].map(user => login(fx, user));
  const start = await drain(fx, a);
  const status = async (who, cursor) => (await feedRequest(fx, who.cookie ?? who, cursor)).status;
  const body = async (who, cursor) => (await feedRequest(fx, who.cookie ?? who, cursor)).json();

  // Tampering at every region (version, nonce, ciphertext, tag), truncation and junk.
  const raw = Buffer.from(start.cursor, "base64url");
  for (const index of [0, 5, 20, raw.length - 1]) {
    const copy = Buffer.from(raw);
    copy[index] ^= 0x01;
    assert.deepEqual(await body(a, copy.toString("base64url")), { code: "cursor_invalid" }, `byte ${index}`);
  }
  for (const junk of ["garbage", "A".repeat(60), start.cursor.slice(0, -4), start.cursor + "A", "%00"]) {
    assert.equal(await status(a, junk), 400, junk);
  }
  const wrongSecret = feedCursor.sealStagingFeedCursor("another-synthetic-secret-of-32-bytes!", decrypt(start.cursor));
  assert.deepEqual(await body(a, wrongSecret), { code: "cursor_invalid" });

  // A's cursor is useless to B; the owner cookie is the same identity as alice (uid alice) -> accepted.
  assert.deepEqual(await body(b, start.cursor), { code: "cursor_invalid" });
  assert.equal(await status(ownerCookie(), start.cursor), 200, "bound to the identity, not to the session/cookie kind");

  // A new session of the same identity continues with the old cursor after revokeSession.
  const second = login(fx, "alice");
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, a.sessionId).ok, true);
  assert.equal(await status(a, start.cursor), 401, "the revoked session itself is dead");
  assert.equal(await status(second, start.cursor), 200, "same identity, new session, same cursor");

  // revokeAllForUser raises the epoch: the old cursor is invalid even for a fresh session.
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "alice").ok, true);
  const third = login(fx, "alice");
  assert.deepEqual(await body(third, start.cursor), { code: "cursor_invalid" });
  const restarted = await drain(fx, third);
  assert.equal(restarted.last.more, false, "a new bootstrap works");
  assert.equal(await status(third, restarted.cursor), 200);

  // Cursor of another store instance (different generation): resync_required, never data.
  const other = makeFixture();
  const alice2 = login(other, "alice");
  const foreign = await feedRequest(other, alice2.cookie, restarted.cursor);
  assert.equal(foreign.status, 409);
  assert.deepEqual(await foreign.json(), { code: "resync_required" });
  assert.equal(foreign.headers.get("cache-control"), "no-store");
});

test("cursor crypto: fresh nonce, AEAD, claims, padding and bounds", () => {
  const claims = { uid: "alice", epoch: 0, gen: "0b7e7c1e-6a1f-4a7e-8c52-3a9d1f0c9a11", pos: { ph: "f", p: 7 } };
  const a = feedCursor.sealStagingFeedCursor(SECRET, claims);
  const b = feedCursor.sealStagingFeedCursor(SECRET, claims);
  assert.notEqual(a, b, "random nonce per token");
  assert.equal(a.length, b.length);
  assert.deepEqual(feedCursor.openStagingFeedCursor(SECRET, a).claims, claims);
  const big = feedCursor.sealStagingFeedCursor(SECRET, { ...claims, pos: { ph: "f", p: 9007199254740 } });
  assert.equal(big.length, a.length, "digits of the position do not change the token length");
  assert.equal(feedCursor.sealStagingFeedCursor("short", claims), null);
  assert.equal(feedCursor.sealStagingFeedCursor(SECRET, { ...claims, uid: "bad id" }), null);
  assert.equal(feedCursor.openStagingFeedCursor(SECRET, "x".repeat(feedCursor.MAX_FEED_CURSOR_LENGTH + 1)).ok, false);
  assert.equal(feedCursor.openStagingFeedCursor(SECRET, "").ok, false);
});

async function withGatedChild(run, between) {
  const gate = path.join(root, `gate-${++counter}`);
  mkdirSync(gate);
  const script = path.join(gate, "node-wrapper.sh");
  writeFileSync(script, `#!/bin/sh
PATH=/usr/bin:/bin
out=$("${REAL_NODE}" "$@")
code=$?
: > "${gate}/done"
while [ ! -e "${gate}/go" ]; do sleep 0.02; done
printf '%s' "$out"
exit $code
`);
  chmodSync(script, 0o755);
  process.execPath = script;
  try {
    const pending = run();
    for (let waited = 0; !existsSync(path.join(gate, "done")); waited += 20) {
      assert.ok(waited < 30_000, "gated child never finished");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await between();
    writeFileSync(path.join(gate, "go"), "");
    return await pending;
  } finally {
    process.execPath = REAL_NODE;
  }
}

test("linearization barrier: membership removed after the snapshot -> 409 read_stale_reload and no data", async () => {

  // Bootstrap page, owner-cookie identity (alice) and a session identity (bob).
  for (const kind of ["session", "owner"]) {
    const fx = makeFixture();
    if (kind === "owner") mutate(fx, "UPDATE area_members SET role='admin' WHERE area_id='family-area' AND user_id='bob'");
    const cookie = kind === "owner" ? ownerCookie() : login(fx, "bob").cookie;
    const response = await withGatedChild(() => feedRequest(fx, cookie, null),
      async () => mutate(fx, removeMemberSql(kind === "owner" ? "alice" : "bob")));
    assert.equal(response.status, 409, kind);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { code: "read_stale_reload" });
    assert.equal(text.includes("Family"), false);
    // The client retries the same cursor (here: none) and now sees the new membership.
    const retry = await okJson(feedRequest(fx, cookie, null), `${kind} retry`);
    assert.equal(retry.items.some(i => i.areaId === "family-area"), false);
  }

  // Feed page with data (an upsert) in a contributing Area, policy change after the snapshot.
  const fx = makeFixture();
  const b = login(fx, "bob");
  const start = await drain(fx, b);
  mutate(fx, titleSql("f-3", "Visible edit"));
  const stale = await withGatedChild(() => feedRequest(fx, b.cookie, start.cursor),
    async () => mutate(fx, `BEGIN; UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob';
      UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'; COMMIT;`));
  assert.equal(stale.status, 409);
  const text = await stale.text();
  assert.deepEqual(JSON.parse(text), { code: "read_stale_reload" });
  assert.equal(text.includes("Visible edit"), false);
  // Same cursor again: the role change arrives, the upsert still carries the current state.
  const retry = await page(fx, b, start.cursor, "retry");
  assert.deepEqual(types(retry.items), ["upsert", "upsert", "upsert", "role_changed"]);
  assert.equal(retry.items.at(-1).role, "viewer");

  // A session revoked after the snapshot wins over a membership change: 401, never 409.
  const dead = login(fx, "carol");
  const startDead = await drain(fx, dead);
  mutate(fx, titleSql("f-3", "Another edit"));
  const unauthorized = await withGatedChild(() => feedRequest(fx, dead.cookie, startDead.cursor), async () => {
    durable.revokeDurableTargetStagingSession(fx.store, dead.sessionId);
    mutate(fx, removeMemberSql("carol"));
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
});

test("HTTP: flag off 404, 401 without a session, no-store, rate limit, bounded cursor, strict query", async () => {
  const fx = makeFixture();
  const a = login(fx, "alice");
  const withFlag = async (value, run) => {
    const previous = process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED;
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = value;
    try { return await run(); } finally { process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = previous; }
  };
  const off = await withFlag("false", () => feedRequest(fx, a.cookie, null));
  assert.equal(off.status, 404);
  assert.equal(off.headers.get("cache-control"), "no-store");
  assert.deepEqual(await off.json(), { error: "Not found" });

  const anonymous = await feedRequest(fx, "", null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  const forged = await feedRequest(fx, sessionCookie("A".repeat(43)), null);
  assert.equal(forged.status, 401);

  const ok = await feedRequest(fx, a.cookie, null);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  // Owner cookie is the configured owner (alice): same bootstrap content.
  const viaOwner = await okJson(feedRequest(fx, ownerCookie(), null), "owner");
  assert.deepEqual(viaOwner.items, (await ok.json()).items);

  // Oversized cursor, unknown / duplicated parameters: 400 before any work.
  const huge = "a".repeat(feedCursor.MAX_FEED_CURSOR_LENGTH + 1);
  assert.equal((await feedRequest(fx, a.cookie, huge)).status, 400);
  assert.equal((await feedRequest(fx, a.cookie, null, "?limit=5")).status, 400);
  assert.equal((await feedRequest(fx, a.cookie, null, "?since=1")).status, 400);
  assert.equal((await feedRequest(fx, a.cookie, "x", "&cursor=y")).status, 400);

  // Rate limit: refused before decrypting or spawning a child (cheap garbage cursors).
  const limited = makeFixture();
  const owner = ownerCookie();
  let blocked = null;
  for (let i = 0; i < 305 && !blocked; i++) {
    const response = await feedRequest(limited, owner, "garbage" + i);
    if (response.status === 429) blocked = response;
    else assert.equal(response.status, 400);
  }
  assert.ok(blocked, "429 after the per-client budget");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
});

const insertTasks = (fx, rows, area = "family-area") => {
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const insert = db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  for (const id of rows) insert.run(id, area, `T ${id.length}`);
  db.close();
};
const ordered = ids => [...ids].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));

test("keyset order is UTF-8 byte order like SQLite BINARY: BMP-high vs astral ids at a page boundary", async () => {
  const fx = makeFixture();
  const specials = ["\uff61x", "\u{1F600}x", ...Array.from({ length: 108 }, (_, i) => `\u{10000}${String(i).padStart(3, "0")}`), ""];
  const plain = Array.from({ length: 92 }, (_, i) => `g-${String(i).padStart(3, "0")}`);
  insertTasks(fx, [...plain, ...specials]);
  const expected = ordered(["f-1", "f-2", "f-3", "f-4", "f-5", ...plain, ...specials.filter(Boolean)]);
  assert.ok(expected.length > 100);
  const a = login(fx, "alice");
  const boot = await drain(fx, a);
  const served = boot.items.filter(i => i.areaId === "family-area").map(i => i.id);
  assert.deepEqual(served, expected, "every item exactly once, in byte order");

  // Area bootstrap (after a grant) uses the same keyset.
  const d = login(fx, "dave");
  const start = await drain(fx, d);
  mutate(fx, addMemberSql("dave", "viewer"));
  const grant = (await page(fx, d, start.cursor)).items[0];
  const area = await drain(fx, d, grant.areaCursor);
  assert.deepEqual(area.items.map(i => i.id), expected);
  assert.ok(area.pages > 1);
});

test("keyset order of Area ids (readable and lost slots) is UTF-8 byte order across a page boundary", async () => {
  const fx = makeFixture();
  // U+FF61 / U+FF62 sort AFTER the emoji in UTF-16 but BEFORE it in UTF-8.
  const [halfwidth, lost, emoji] = ["\uff61-area", "\uff62-lost", "\u{1F600}-area"];
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  for (const [i, area] of [halfwidth, lost, emoji].entries()) {
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'shared', 'alice')").run(`uw-${i}`);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?, ?, 'shared', ?, 'alice')")
      .run(area, `U ${i}`, `uw-${i}`);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'admin'), (?, 'bob', 'viewer')")
      .run(area, area);
  }
  db.exec("COMMIT");
  db.close();
  insertTasks(fx, Array.from({ length: 120 }, (_, i) => `h-${String(i).padStart(3, "0")}`), halfwidth);
  insertTasks(fx, ["l-1", "l-2"], lost);
  insertTasks(fx, Array.from({ length: 30 }, (_, i) => `e-${String(i).padStart(3, "0")}`), emoji);
  const b = login(fx, "bob");
  const boot = await drain(fx, b, null, async pageNumber => {
    // The first page ends inside the U+FF61 Area; the lost slot follows it in byte order.
    if (pageNumber === 1) mutate(fx, removeMemberSql("bob", lost));
  });
  const keys = boot.items.map(i => i.type === "access_lost" ? `lost:${i.areaId}` : `${i.areaId}:${i.id}`);
  assert.equal(new Set(keys).size, keys.length, "nothing served twice");
  assert.deepEqual(boot.items.filter(i => i.areaId === halfwidth).length, 120);
  assert.deepEqual(boot.items.filter(i => i.areaId === emoji).length, 30);
  assert.deepEqual(boot.items.filter(i => i.areaId === lost).map(i => i.type), ["access_lost"], "no data, one notice");
  const areaOrder = [...new Set(boot.items.map(i => i.areaId))].filter(id => [halfwidth, lost, emoji].includes(id));
  assert.deepEqual(areaOrder, [halfwidth, lost, emoji]);
});

test("area bootstrap pages past 100 items including a project and its tasks", async () => {
  const fx = makeFixture();
  mutate(fx, `INSERT INTO projects(id,area_id,title) VALUES ('pr-a','family-area','Big project');`);
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const insert = db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?,?,?)");
  for (let i = 0; i < 120; i++) insert.run(`pt-${String(i).padStart(3, "0")}`, "pr-a", `P ${i}`);
  db.close();
  insertTasks(fx, Array.from({ length: 60 }, (_, i) => `q-${String(i).padStart(3, "0")}`));
  const d = login(fx, "dave");
  const start = await drain(fx, d);
  mutate(fx, addMemberSql("dave", "viewer"));
  const grant = (await page(fx, d, start.cursor)).items[0];
  const pages = [];
  const area = await drain(fx, d, grant.areaCursor, async (n, body) => pages.push(body));
  pages.push(area.last);
  assert.equal(pages.length, 2);
  for (const body of pages) assert.ok(body.items.length <= 100);
  assert.equal(area.items.length, 1 + 120 + 60 + 5);
  assert.equal(new Set(area.items.map(i => `${i.kind}:${i.id}`)).size, area.items.length);
  assert.equal(area.items.filter(i => i.kind === "task" && i.projectId === "pr-a").length, 120);
  assert.equal(area.last.done, true);
});

test("cursor size: one fixed token length, worst-case claims round-trip and reach the child", async () => {
  const gen = "0b7e7c1e-6a1f-4a7e-8c52-3a9d1f0c9a11";
  const lengths = new Set();
  for (const uidLength of [1, 6, 17, 60, 120]) {
    for (const pos of [0, 9, 99999, 9007199254740990]) {
      const token = feedCursor.sealStagingFeedCursor(SECRET, {
        uid: "u".repeat(uidLength), epoch: pos === 0 ? 0 : 9007199254740990, gen, pos: { ph: "f", p: pos } });
      lengths.add(token.length);
    }
  }
  assert.deepEqual([...lengths], [feedCursor.MAX_FEED_CURSOR_LENGTH]);

  const fx = makeFixture();
  const worstIds = ['\\'.repeat(512), '"'.repeat(512), "\u{1F600}".repeat(128)];
  const max = 9007199254740990;
  for (const id of worstIds) {
    for (const pos of [
      { ph: "b", w: max, k: [id, "project", id] },
      { ph: "b", w: max, k: [id, "lost", id] },
      { ph: "a", a: id, w: max, k: ["project", id] },
    ]) {
      const claims = { uid: "u".repeat(120), epoch: max, gen: fx.stage.restoreGeneration, pos };
      const plain = Buffer.byteLength(JSON.stringify({ v: 1, ...claims, iat: max }));
      assert.ok(plain <= feedCursor.FEED_CURSOR_PLAINTEXT_BYTES, `plaintext ${plain}`);
      const token = feedCursor.sealStagingFeedCursor(SECRET, claims);
      assert.equal(token.length, feedCursor.MAX_FEED_CURSOR_LENGTH);
      assert.deepEqual(feedCursor.openStagingFeedCursor(SECRET, token).claims, claims);
      // The decrypted claims travel to the read subprocess as an argument: no smaller limit there.
      const result = await readProcess.readStagingFeedPageInChild({
        stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
        ownerUserId: "alice" }, claims);
      assert.deepEqual(result, { ok: false, reason: "cursor_invalid" });
    }
  }
  // Not well-formed (lone surrogate) or oversized ids can never be sealed.
  const bad = pos => feedCursor.sealStagingFeedCursor(SECRET, { uid: "alice", epoch: 0, gen, pos });
  assert.equal(bad({ ph: "a", a: "x\ud800", w: 0, k: null }), null);
  assert.equal(bad({ ph: "a", a: "x".repeat(513), w: 0, k: null }), null);
});

test("child result parser enforces per-phase item types and next positions", () => {
  const base = { ok: true, more: false, actorUserId: "alice", epoch: 0,
    linearization: { actorUserId: "alice", areas: [] } };
  const parse = value => readProcess.parseStagingFeedResult({ ...base, ...value });
  const lost = [{ type: "access_lost", areaId: "x" }];
  const role = [{ type: "role_changed", areaId: "x", role: "viewer" }];
  const f = { ph: "f", p: 1 };
  const b = { ph: "b", w: 1, k: ["x", "task", "t"] };
  const a = { ph: "a", a: "x", w: 1, k: null };
  assert.ok(parse({ phase: "bootstrap", items: lost, done: false, next: b }));
  assert.ok(parse({ phase: "bootstrap", items: [], done: false, next: f }));
  assert.ok(parse({ phase: "feed", items: role, done: false, next: f }));
  assert.ok(parse({ phase: "area_bootstrap", items: [], done: false, next: a }));
  assert.ok(parse({ phase: "area_bootstrap", items: [], done: true, next: null }));
  assert.equal(parse({ phase: "bootstrap", items: [], done: false, next: a }), null);
  assert.equal(parse({ phase: "bootstrap", items: role, done: false, next: f }), null);
  assert.equal(parse({ phase: "feed", items: [], done: false, next: b }), null);
  assert.equal(parse({ phase: "feed", items: [], done: false, next: a }), null);
  assert.equal(parse({ phase: "area_bootstrap", items: [], done: false, next: f }), null);
  assert.equal(parse({ phase: "area_bootstrap", items: lost, done: true, next: null }), null);
  assert.equal(parse({ phase: "area_bootstrap", items: [], done: false, next: null }), null);
});

test("barrier on an Area-bootstrap page: membership removed after the snapshot -> 409, no data", async () => {
  const fx = makeFixture();
  const d = login(fx, "dave");
  const start = await drain(fx, d);
  mutate(fx, addMemberSql("dave", "viewer"));
  const grant = (await page(fx, d, start.cursor)).items[0];
  const stale = await withGatedChild(() => feedRequest(fx, d.cookie, grant.areaCursor),
    async () => mutate(fx, removeMemberSql("dave")));
  assert.equal(stale.status, 409);
  const text = await stale.text();
  assert.deepEqual(JSON.parse(text), { code: "read_stale_reload" });
  assert.equal(text.includes("Family"), false);
});

test("feed work budget: many visible-but-unreadable upserts -> more:true, advanced position, nothing leaked", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  const start = await drain(fx, b);
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  const update = db.prepare("UPDATE tasks SET title=? WHERE id='f-3'");
  for (let i = 0; i < 2100; i++) update.run(`Budget secret ${i}`);
  db.exec("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'; DELETE FROM area_members WHERE user_id='bob' AND area_id='family-area'; COMMIT");
  db.close();
  const first = await page(fx, b, start.cursor);
  assert.deepEqual(first.items, []);
  assert.equal(first.more, true);
  assert.ok(decrypt(first.cursor).pos.p > decrypt(start.cursor).pos.p + 2000, "position advanced over skipped entries");
  assert.equal(JSON.stringify(first).includes("Budget"), false);
  const second = await page(fx, b, first.cursor);
  assert.deepEqual(second.items, [{ type: "access_lost", areaId: "family-area" }]);
  assert.equal(second.more, false);
});
