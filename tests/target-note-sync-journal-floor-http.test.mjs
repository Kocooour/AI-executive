// Independent tester scenarios (R2d note journal retention): HTTP note sync around
// compaction floors, incl. lifecycle create/move changes (regression for the
// note-sync child DTO parser that rejected upsert/leave).
// Tester A scratch tests: note journal retention floor, client behaviour, capacity, CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const names = ["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_SECURITY_ALERT_FILE","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET","AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY","AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED","AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-note-floor-http-"));
const legacy = path.join(root, "sentinel"); (await import("node:fs")).mkdirSync(legacy);
writeFileSync(path.join(legacy, "keep"), "untouched");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_SECURITY_ALERT_FILE = path.join(root, "alerts.log");
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") + ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "tester-a-note-journal-secret-long-enough-0123";
for (const k of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED"]) process.env[k] = "true";
const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS } =
  await import(R + "/lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import(R + "/lib/target-store-preflight.ts");
const durable = await import(R + "/lib/target-staging-durable-session.ts");
const { TargetStagingSessionAuthority } = await import(R + "/lib/target-staging-session-authority.ts");
const { previewTargetNoteWrite } = await import(R + "/lib/target-note-write-contract.ts");
const { applyNoteSyncPage, emptyNoteSyncPageState, readableNoteMetadata } = await import(R + "/lib/target-sync/note-pages.ts");
const { GET } = await import(R + "/app/api/target-staging/note-sync/route.ts");
const { GET: PREVIEW, PATCH: EDIT } = await import(R + "/app/api/target-staging/notes/[noteId]/edit/route.ts");
const { DELETE: DELETE_NOTE } = await import(R + "/app/api/target-staging/notes/[noteId]/route.ts");
const { compactTargetStagingNoteJournal } = await import(R + "/lib/target-staging-note-journal-compaction.ts");
const { sealTargetNoteSyncCursor } = await import(R + "/lib/target-note-sync-cursor.ts");

const opened = [];
after(() => {
  for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  for (const d of opened) { try { d.close(); } catch {} }
  assert.equal(readFileSync(path.join(legacy, "keep"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ipN = 0;
const nextIp = () => `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}`;

function fixture() {
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice" });
  const db = new DatabaseSync(stage.databasePath); db.exec("PRAGMA foreign_keys=ON");
  for (const id of ["bob", "carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run("personal-" + id, id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Unassigned','private',?,?,'unassigned')")
      .run("private-" + id, "personal-" + id, id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [id, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(id, role);
  for (const id of ["one", "two", "three"]) db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES (?,'team-area',?,'Body')").run(id, id);
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('mine','private-bob','mine','Body')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const authority = new TargetStagingSessionAuthority(store);
  opened.push(authority);
  return { stage, store, authority, db: () => { const d = new DatabaseSync(stage.databasePath); d.exec("PRAGMA foreign_keys=ON"); opened.push(d); return d; } };
}
const cookieFor = (fx, who) => {
  const s = durable.issueDurableTargetStagingSession(fx.store, who, 900);
  assert.equal(s.ok, true, JSON.stringify(s));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + s.sessionToken;
};
async function http(cookie, method, area, cursor, limit = 100) {
  const url = new URL("http://localhost:3001/api/target-staging/note-sync");
  url.searchParams.set("areaId", area); url.searchParams.set("limit", String(limit));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const r = await GET(new Request(url, { headers: { cookie, "x-forwarded-for": nextIp() } }));
  return { status: r.status, body: await r.json() };
}
/** Real-client style loop: follow pages until caught up; resync clears state (caller re-bootstraps). */
async function pullAll(state, cookie, area = "team-area", limit = 100) {
  let cur = state;
  for (let i = 0; i < 50; i++) {
    const r = await http(cookie, "GET", area, cur.cursor ?? undefined, limit);
    if (r.status === 409) { assert.ok(["resync_required"].includes(r.body.code), JSON.stringify(r.body));
      return { kind: "resync", state: emptyNoteSyncPageState() }; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = applyNoteSyncPage(cur, r.body);
    if (!res.ok) return { kind: "client_" + res.reason, state: emptyNoteSyncPageState() };
    cur = res.state;
    if (!r.body.more) return { kind: "applied", state: cur, last: r.body };
  }
  throw new Error("too many pages");
}
const visible = st => readableNoteMetadata(st).map(n => [n.id, n.revision]).sort();
const live = (db, area) => db.prepare("SELECT id,revision FROM notes WHERE area_id=? ORDER BY id").all(area).map(r => [r.id, r.revision]);
async function edit(fx, who, noteId, body) {
  const cookie = cookieFor(fx, who);
  const ctx = { params: Promise.resolve({ noteId }) };
  const h = { cookie, "x-forwarded-for": nextIp() };
  const p = await PREVIEW(new Request(`http://localhost:3001/api/target-staging/notes/${noteId}/edit`, { headers: h }), ctx);
  assert.equal(p.status, 200);
  const r = await EDIT(new Request(`http://localhost:3001/api/target-staging/notes/${noteId}/edit`, { method: "PATCH",
    body: JSON.stringify({ ...await p.json(), commandId: randomUUID(), title: noteId, body }),
    headers: { ...h, origin: "http://localhost:3001", "content-type": "application/json", "x-lumi-target-protocol": "1" } }), ctx);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}
async function del(fx, who, noteId) {
  const cookie = cookieFor(fx, who);
  const ctx = { params: Promise.resolve({ noteId }) };
  const h = { cookie, "x-forwarded-for": nextIp() };
  const p = await PREVIEW(new Request(`http://localhost:3001/api/target-staging/notes/${noteId}/edit`, { headers: h }), ctx);
  assert.equal(p.status, 200);
  const r = await DELETE_NOTE(new Request(`http://localhost:3001/api/target-staging/notes/${noteId}`, { method: "DELETE",
    body: JSON.stringify({ ...await p.json(), commandId: randomUUID() }),
    headers: { ...h, origin: "http://localhost:3001", "content-type": "application/json", "x-lumi-target-protocol": "1" } }), ctx);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
}
function lifecycleCreate(fx, actor, areaId, projectId, noteId) {
  const s = fx.authority.issueWritable(actor); assert.ok(s, "writable session");
  const req = { kind: "create", noteId, commandId: randomUUID(), restoreGeneration: fx.stage.restoreGeneration,
    areaId, projectId, title: noteId, body: "Body" };
  const r = fx.authority.changeNoteLifecycle(s.sessionToken, req);
  assert.deepEqual(r, { ok: true });
}
function lifecycleMove(fx, actor, noteId, areaId) {
  const s = fx.authority.issueWritable(actor); assert.ok(s, "writable session");
  const db = fx.db();
  const p = previewTargetNoteWrite(db, actor, noteId); assert.equal(p.ok, true, JSON.stringify(p));
  const r = fx.authority.changeNoteLifecycle(s.sessionToken, { kind: "move", noteId, commandId: randomUUID(),
    restoreGeneration: fx.stage.restoreGeneration, writeAreaId: p.writeAreaId, expectedRevision: p.expectedRevision,
    areaId, projectId: null, confirmShare: true });
  assert.deepEqual(r, { ok: true });
}
const floors = db => Object.fromEntries(db.prepare("SELECT area_id,floor_seq,revision FROM note_journal_floors").all()
  .map(r => [r.area_id, [r.floor_seq, r.revision]]));
const seqs = (db, a) => db.prepare("SELECT seq FROM note_change_journal WHERE area_id=? ORDER BY seq").all(a).map(r => r.seq);

/* Real-time timeline: HTTP writes are stamped by real clock in the child, so instead of mocking time
 * we read each journal row's committed_at_ms and pick the operator `now` as (timestamp + N days).
 * Retention cutoff = now - retention, so the split point lands exactly on a recorded event. */
const committed = (db, area) => Object.fromEntries(db.prepare("SELECT seq,committed_at_ms AS t FROM note_change_journal WHERE area_id=?")
  .all(area).map(r => [r.seq, r.t]));
const compactNow = (fx, now) => compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now });
async function timeline(fx) {
  const boot = await pullAll(emptyNoteSyncPageState(), cookieFor(fx, "bob"));
  assert.equal(boot.kind, "applied");
  await edit(fx, "bob", "mine", "v2"); await sleep(3);    // private-bob seq 1
  await edit(fx, "bob", "one", "v2");  await sleep(3);    // team seq 1  one r1
  await edit(fx, "bob", "two", "v2");  await sleep(3);    // team seq 2  two r1
  await del(fx, "bob", "three");       await sleep(3);    // team seq 3  delete three
  await edit(fx, "bob", "two", "v3");  await sleep(3);    // team seq 4  two r2
  await edit(fx, "bob", "one", "v3");  await sleep(3);    // team seq 5  one r2
  return { K0: boot.state.cursor, B: boot.state };
}

test("timeline: retention 7 floor, behind/at/above clients, resync, rebootstrap, dense seq", async () => {
  const fx = fixture();
  const db = fx.db();
  const { K0, B } = await timeline(fx);
  assert.deepEqual(seqs(db, "team-area"), [1, 2, 3, 4, 5]);
  assert.deepEqual(seqs(db, "private-bob"), [1]);
  // A takes a partial page (limit 2) and stops; C takes limit 3. Both keep these cursors.
  const pA = await http(cookieFor(fx, "bob"), "GET", "team-area", K0, 2);
  assert.equal(pA.status, 200, JSON.stringify(pA.body));
  assert.equal(pA.body.more, true); assert.equal(pA.body.changes.length, 2);
  const cursorA = pA.body.cursor; // afterSeq 2
  const A = applyNoteSyncPage(B, pA.body).state;
  const pC = await http(cookieFor(fx, "bob"), "GET", "team-area", K0, 3);
  assert.equal(pC.status, 200); assert.equal(pC.body.changes.length, 3);
  const cursorC = pC.body.cursor; // afterSeq 3
  const C = applyNoteSyncPage(B, pC.body).state;
  const rB = await pullAll(B, cookieFor(fx, "bob"));
  assert.equal(rB.kind, "applied");
  assert.deepEqual(visible(rB.state), live(db, "team-area"), "B (all events) equals live");
  assert.deepEqual(floors(db)["team-area"], [0, 0]);

  // Operator clock: first recent event (team seq 4) is exactly at the cutoff -> floor 3.
  const ts = committed(db, "team-area");
  const now = ts[4] + 7 * DAY;
  const comp = compactNow(fx, now);
  assert.deepEqual(comp, { ok: true, areas: 2, deleted: 4 }, JSON.stringify(comp));
  assert.deepEqual(floors(db)["team-area"], [3, 1]);
  assert.deepEqual(floors(db)["private-bob"], [1, 1]);
  assert.deepEqual(floors(db)["area:unassigned:alice"], [0, 0]);
  assert.deepEqual(seqs(db, "team-area"), [4, 5]);
  assert.deepEqual(seqs(db, "private-bob"), []);
  assert.deepEqual(compactNow(fx, now), { ok: true, areas: 0, deleted: 0 }, "repeat is a no-op");
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 30, now }),
    { ok: true, areas: 0, deleted: 0 }, "a 30-day run never lowers the floor");
  assert.deepEqual(floors(db)["team-area"], [3, 1]);

  const behind = await http(cookieFor(fx, "bob"), "GET", "team-area", cursorA, 100);
  assert.deepEqual({ status: behind.status, body: behind.body }, { status: 409, body: { code: "resync_required" } });
  const rAbehind = await pullAll(A, cookieFor(fx, "bob"));
  assert.equal(rAbehind.kind, "resync", "client A (behind floor) is told to resync");
  const rA = await pullAll(emptyNoteSyncPageState(), cookieFor(fx, "bob"));
  assert.equal(rA.kind, "applied", "rebootstrap after resync");
  assert.deepEqual(visible(rA.state), live(db, "team-area"), "rebootstrap equals live notes");

  const atFloor = await http(cookieFor(fx, "bob"), "GET", "team-area", cursorC, 100);
  assert.equal(atFloor.status, 200, JSON.stringify(atFloor.body));
  assert.deepEqual(atFloor.body.changes.map(c => [c.kind, c.noteId, c.revision]),
    [["edit", "two", 2], ["edit", "one", 2]]);
  const rC = await pullAll(C, cookieFor(fx, "bob"));
  assert.equal(rC.kind, "applied");
  assert.deepEqual(visible(rC.state), live(db, "team-area"));
  const rB2 = await pullAll(rB.state, cookieFor(fx, "bob"));
  assert.equal(rB2.kind, "applied");
  assert.deepEqual(visible(rB2.state), live(db, "team-area"));

  await sleep(3); await edit(fx, "bob", "two", "v4");
  assert.deepEqual(seqs(db, "team-area"), [4, 5, 6], "dense continuation after the floor");
  for (const [name, st] of [["A", rA.state], ["B", rB2.state], ["C", rC.state]]) {
    const r = await pullAll(st, cookieFor(fx, "bob"));
    assert.equal(r.kind, "applied", name);
    assert.deepEqual(visible(r.state), live(db, "team-area"), name + " after new event");
  }
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory,
    expectedRestoreGeneration: fx.stage.restoreGeneration, mode: "r2-model" }).ok, true);
  db.close();
});

test("private Area fully compacted: bootstrap at floor, next event is floor+1, exact-floor cursor served", async () => {
  const fx = fixture();
  const db = fx.db();
  await edit(fx, "bob", "mine", "v2");
  const t = committed(db, "private-bob")[1];
  assert.deepEqual(compactNow(fx, t + 8 * DAY), { ok: true, areas: 1, deleted: 1 });
  assert.deepEqual(floors(db)["private-bob"], [1, 1]);
  const boot = await http(cookieFor(fx, "bob"), "GET", "private-bob");
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.deepEqual(boot.body.entries.map(e => e.id), ["mine"]);
  await sleep(3); await edit(fx, "bob", "mine", "v3");
  assert.deepEqual(seqs(db, "private-bob"), [2], "sequence continues at floor+1");
  const next = await http(cookieFor(fx, "bob"), "GET", "private-bob", boot.body.cursor);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.deepEqual(next.body.changes, [{ kind: "edit", noteId: "mine", projectId: null, revision: 2 }]);
  db.close();
});

test("full compaction of team Area: sequences never reused, old cursor refused, rebootstrap works", async () => {
  const fx = fixture();
  const db = fx.db();
  const { K0 } = await timeline(fx);
  const ts = committed(db, "team-area");
  const comp = compactNow(fx, ts[5] + 8 * DAY);
  assert.deepEqual(comp, { ok: true, areas: 2, deleted: 6 }, JSON.stringify(comp));
  assert.deepEqual(floors(db)["team-area"], [5, 1], "floor = MAX(seq) when nothing is recent");
  assert.deepEqual(seqs(db, "team-area"), []);
  const stale = await http(cookieFor(fx, "bob"), "GET", "team-area", K0);
  assert.deepEqual({ status: stale.status, body: stale.body }, { status: 409, body: { code: "resync_required" } });
  const boot = await http(cookieFor(fx, "bob"), "GET", "team-area");
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  assert.deepEqual(boot.body.entries.map(e => e.id).sort(), ["one", "two"]);
  await sleep(3); await edit(fx, "bob", "two", "v4");
  assert.deepEqual(seqs(db, "team-area"), [6], "next sequence after floor 5 is 6");
  const tail = await http(cookieFor(fx, "bob"), "GET", "team-area", boot.body.cursor);
  assert.equal(tail.status, 200, JSON.stringify(tail.body));
  assert.deepEqual(tail.body.changes, [{ kind: "edit", noteId: "two", projectId: null, revision: 3 }]);
  db.close();
});

test("retention 30 compacts nothing: full history still served from the bootstrap cursor", async () => {
  const fx = fixture();
  const db = fx.db();
  const { K0 } = await timeline(fx);
  const ts = committed(db, "team-area");
  // 7-day retention would compact everything here; 30-day must not.
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 30, now: ts[5] + 8 * DAY }),
    { ok: true, areas: 0, deleted: 0 });
  assert.deepEqual(seqs(db, "team-area"), [1, 2, 3, 4, 5]);
  const p = await http(cookieFor(fx, "bob"), "GET", "team-area", K0, 100);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.changes.length, 5);
  db.close();
});

test("multi-page bootstrap spanning a compaction still completes; cursor at head after full compaction is served empty", async () => {
  const fx = fixture();
  const db = fx.db();
  await edit(fx, "bob", "one", "v2"); await sleep(3);
  await edit(fx, "bob", "two", "v2"); await sleep(3);
  await del(fx, "bob", "three");
  const ts = committed(db, "team-area");
  const p1 = await http(cookieFor(fx, "bob"), "GET", "team-area", undefined, 1);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.phase, "bootstrap"); assert.equal(p1.body.more, true);
  assert.deepEqual(p1.body.entries.map(e => e.id), ["one"]);
  const comp = compactNow(fx, ts[3] + 8 * DAY);
  assert.deepEqual(comp, { ok: true, areas: 1, deleted: 3 }, JSON.stringify(comp));
  const p2 = await http(cookieFor(fx, "bob"), "GET", "team-area", p1.body.cursor, 1);
  assert.equal(p2.status, 200, "bootstrap continuation after compaction: " + JSON.stringify(p2.body));
  assert.deepEqual(p2.body.entries.map(e => e.id), ["two"]);
  assert.equal(p2.body.more, false);
  const p3 = await http(cookieFor(fx, "bob"), "GET", "team-area", p2.body.cursor, 100);
  assert.equal(p3.status, 200, JSON.stringify(p3.body));
  assert.equal(p3.body.phase, "changes");
  assert.deepEqual(p3.body.changes, [], "cursor at head == floor is served with no events");
  await sleep(3); await edit(fx, "bob", "two", "v3");
  const p4 = await http(cookieFor(fx, "bob"), "GET", "team-area", p3.body.cursor, 100);
  assert.equal(p4.status, 200, JSON.stringify(p4.body));
  assert.deepEqual(p4.body.changes, [{ kind: "edit", noteId: "two", projectId: null, revision: 2 }]);
  db.close();
});

test("PROBE idempotent no-op compaction: anchor/intent growth", async () => {
  const fx = fixture();
  const db = fx.db();
  await edit(fx, "bob", "one", "v2");
  const anchorRows = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%anchor%'").all().map(r => r.name);
    return Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
  };
  const before = anchorRows();
  const r1 = compactNow(fx, Date.now() + 1);
  const mid = anchorRows();
  const r2 = compactNow(fx, Date.now() + 1);
  const after = anchorRows();
  db.close();
});

test("lifecycle create/move changes are released over HTTP note-sync (child DTO accepts upsert/leave)", async () => {
  const fx = fixture();
  const db = fx.db();
  const boot = await pullAll(emptyNoteSyncPageState(), cookieFor(fx, "bob"));
  assert.equal(boot.kind, "applied");
  await edit(fx, "bob", "one", "v2");
  await sleep(3); lifecycleCreate(fx, "alice", "team-area", null, "c1");
  assert.deepEqual(seqs(db, "team-area"), [1, 2]);
  const r = await http(cookieFor(fx, "bob"), "GET", "team-area", boot.state.cursor, 100);
  assert.equal(r.status, 200, "PROBE P1 actual status " + r.status + " " + JSON.stringify(r.body));
  assert.deepEqual(r.body.changes.map(c => c.kind), ["edit", "upsert"]);
  db.close();
});

test("PROBE capacity: permanent edit-audit cap (4096) is the real write ceiling; journal space freed by compaction does not lift it", () => {
  const fx = fixture();
  const db = fx.db();
  assert.equal(TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS, 8192);
  db.exec("BEGIN IMMEDIATE");
  const upd = db.prepare("UPDATE notes SET body=? WHERE id='one'");
  const ins = db.prepare(`INSERT INTO note_edit_audit
    (receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,revision_before,revision_after,
     expected_revision,restore_generation,committed_at_ms) VALUES (?,'alice','one',NULL,'team-area',0,?,?,?,?,?)`);
  for (let i = 0; i < 4096; i++) {
    upd.run("b" + i);
    ins.run("cap-" + i, i, i + 1, "a".repeat(64), fx.stage.restoreGeneration, 1_000_000 + i);
  }
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_change_journal").get().n, 4096);
  upd.run("over");
  assert.throws(() => ins.run("cap-over", 4096, 4097, "a".repeat(64), fx.stage.restoreGeneration, 2_000_000),
    /note audit capacity reached/);
  // Emulate what compaction does to the journal (floor raise + guarded delete of rows <= floor).
  // Real compaction is not used here because the synthetic audit rows fail canonical preflight.
  db.prepare("UPDATE note_journal_floors SET floor_seq=4096, revision=1 WHERE area_id='team-area'").run();
  assert.equal(db.prepare("DELETE FROM note_change_journal WHERE area_id='team-area' AND seq<=4096").run().changes, 4096);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_change_journal").get().n, 0, "journal rows freed");
  assert.throws(() => db.prepare("DELETE FROM note_edit_audit WHERE receipt_key='cap-0'").run(),
    "audits cannot be removed, so compaction cannot free the audit cap");
  // Expected per R2D-NOTE-JOURNAL-RETENTION "komprese kapacitu uvolni": a new edit should be possible again.
  assert.throws(() => ins.run("cap-after", 4096, 4097, "a".repeat(64), fx.stage.restoreGeneration, 3_000_000),
    /note audit capacity reached/, "PROBE: edit still refused after journal space is freed");
  db.close();
});

test("CLI: strict arguments, content-free JSON, exit codes", () => {
  const fx = fixture();
  const run = (...args) => {
    const r = spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs",
      "scripts/target-staging-compact-note-journal.mjs", ...args], { encoding: "utf8", cwd: R });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const dir = fx.stage.directory, gen = fx.stage.restoreGeneration;
  const cases = [
    [["--directory", dir, "--generation", gen, "--retention-days", "6"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days", "7"], 0],
    [["--directory", dir, "--generation", gen, "--retention-days", "36500"], 0],
    [["--directory", dir, "--generation", gen, "--retention-days", "36501"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days", "-7"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days", "7.5"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days", "7", "--retention-days", "8"], 1],
    [["--directory", dir, "--generation", gen, "--retention-days", "--generation"], 1],
    [["--directory", dir, "--generation", gen, "--extra", "1"], 1],
    [["--directory", "relative/dir", "--generation", gen], 1],
    [["--generation", gen], 1],
    [["--directory", dir], 1],
    [["--directory", dir, "--generation", randomUUID()], 1],
    [[], 1],
  ];
  for (const [args, status] of cases) {
    const r = run(...args);
    assert.equal(r.status, status, JSON.stringify(args) + " " + r.out + r.err);
    const body = JSON.parse(r.out);
    if (status === 0) assert.deepEqual(Object.keys(body).sort(), ["areas", "deleted", "ok"]);
    else assert.deepEqual(Object.keys(body).sort(), ["ok", "reason"]);
    assert.equal(r.out.includes(root), false, "no paths in output");
    assert.equal(r.out.includes(gen), false, "no generation in output");
    assert.equal(r.err.includes(root) || r.err.includes(gen), false, "no stderr leak");
  }
  // Retention flag default (30) and a valid no-op.
  const d = run("--directory", dir, "--generation", gen);
  assert.deepEqual(JSON.parse(d.out), { ok: true, areas: 0, deleted: 0 });
  // Wrong generation -> unavailable, no detail.
  const w = run("--directory", dir, "--generation", randomUUID());
  assert.deepEqual(JSON.parse(w.out), { ok: false, reason: "unavailable" });
});
