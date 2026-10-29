import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.1 schema v8: change log, tombstones and their SQLite guards, on synthetic
// temp stores only. Raw SQL goes through node:sqlite directly (the triggers, not
// the commands, are the boundary under test).
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c1-log-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
const oldDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_MAX_TOMBSTONES } =
  await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const dbs = [];

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  dbs.push(db);
  for (const user of ["bob", "carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, user, `${user}-personal`, user);
  }
  for (const [workspace, area] of [["team", "team-area"], ["other", "other-area"]]) {
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'shared', 'alice')").run(workspace);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?, ?, 'shared', ?, 'alice')")
      .run(area, area, workspace);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'admin')").run(area);
  }
  return { stage, db };
}
after(() => {
  for (const db of dbs) { try { db.close(); } catch { /* already closed */ } }
  if (oldDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldDataDir;
  rmSync(root, { recursive: true, force: true });
});

const plain = rows => rows.map(row => ({ ...row }));
const logRows = (db, afterSeq = 0) => plain(db.prepare(
  `SELECT seq, entity_kind AS kind, entity_id AS id, area_id AS area, op, revision,
          member_user_id AS who, member_role AS role FROM change_log WHERE seq > ? ORDER BY seq`).all(afterSeq));
/** Order-insensitive compare of one operation's entries (trigger firing order is not a contract). */
const brief = rows => rows.map(r => `${r.kind}:${r.id}:${r.area}:${r.op}:${r.revision ?? ""}`).sort();
const maxSeq = db => db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM change_log").get().n;
const contentRevision = (db, area) => db.prepare("SELECT content_revision AS n FROM areas WHERE id=?").get(area).n;
const policyRevision = (db, area) => db.prepare("SELECT policy_revision AS n FROM areas WHERE id=?").get(area).n;

/** Delete a task the way the command does: tombstone first (at the next seq), then DELETE. */
function tombstoneAndDelete(db, taskId, now = Date.now()) {
  const task = db.prepare(`SELECT t.revision AS revision, COALESCE(t.area_id, p.area_id) AS area
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(taskId);
  const seq = maxSeq(db) + 1;
  db.prepare("INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES (?,?,?,?,?)")
    .run(taskId, task.area, task.revision + 1, seq, now);
  db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
  return { ...task, seq };
}

test("schema v8: tombstone and change-log tables exist, are content-free and v7 fails preflight", () => {
  assert.equal(TARGET_STORE_SCHEMA_VERSION, 8);
  const { stage, db } = fixture();
  for (const table of ["task_tombstones", "project_tombstones"]) {
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name),
      ["id", "area_id", "revision", "change_seq", "deleted_at_ms"]);
  }
  assert.deepEqual(db.prepare("PRAGMA table_info(change_log)").all().map(c => c.name),
    ["seq", "entity_kind", "entity_id", "area_id", "op", "revision", "member_user_id", "member_role"]);
  // No FK from the title audit to tasks any more (rows outlive a deleted task); no FK to projects/tasks at all.
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list(task_title_audit)").all().map(f => f.table).sort(), ["areas", "identities"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list(task_delete_audit)").all().map(f => f.table).sort(), ["areas", "identities"]);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);

  // A v7 store (no migration) fails preflight and must be re-bootstrapped.
  const v7 = fixture();
  v7.db.exec(`DROP TABLE task_delete_audit; DROP TABLE change_log; UPDATE metadata SET value='7' WHERE key='schema_version'`);
  const old = inspectIsolatedTargetStore({ stagingDirectory: v7.stage.directory, mode: "r2-model" });
  assert.equal(old.ok, false);
  assert.ok(old.issues.includes("schema_invalid") || old.issues.includes("metadata_invalid"), JSON.stringify(old));
});

test("task insert, update and revision advance log exactly one 'upsert' each; no-ops and unrelated writes log nothing", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t1','team-area','one')").run();
  assert.deepEqual(logRows(db).filter(r => r.id === "t1").map(({ seq, ...r }) => r), [
    { kind: "task", id: "t1", area: "team-area", op: "upsert", revision: 0, who: null, role: null }]);
  let mark = maxSeq(db);
  db.prepare("UPDATE tasks SET title='two' WHERE id='t1'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:t1:team-area:upsert:1"]);
  mark = maxSeq(db);
  db.prepare("UPDATE tasks SET title='two' WHERE id='t1'").run(); // same value: no revision, no log
  assert.deepEqual(logRows(db, mark), []);
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='t1'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:t1:team-area:upsert:2"]);
  mark = maxSeq(db);
  // A direct revision-only increment is one upsert as well (not two via the cascade).
  db.prepare("UPDATE tasks SET revision=revision+1 WHERE id='t1'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:t1:team-area:upsert:3"]);
  mark = maxSeq(db);
  assert.throws(() => db.prepare("UPDATE tasks SET revision=10 WHERE id='t1'").run(), /revision must increment by one/);
  assert.deepEqual(logRows(db, mark), []);
  // Changes to other tables (Area title) do not log task entries.
  db.prepare("UPDATE areas SET title='renamed' WHERE id='other-area'").run();
  assert.deepEqual(logRows(db, mark), []);
  // A task inserted into a project logs the project's Area.
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p1','other-area','P')").run();
  mark = maxSeq(db);
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('t2','p1','in project')").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:t2:other-area:upsert:0"]);
});

test("moving a task between Areas logs one 'leave' (old Area) and one 'upsert' (new Area), and bumps both epochs once", () => {
  const { db, stage } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('m1',?,'private')").run(stage.unassignedAreaId);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('pm','other-area','P')").run();
  const privateEpoch = contentRevision(db, stage.unassignedAreaId);
  const teamEpoch = contentRevision(db, "team-area");
  let mark = maxSeq(db);
  db.prepare("UPDATE tasks SET area_id='team-area' WHERE id='m1'").run();
  assert.deepEqual(brief(logRows(db, mark)), [
    `task:m1:${stage.unassignedAreaId}:leave:1`, "task:m1:team-area:upsert:1"].sort());
  assert.equal(contentRevision(db, stage.unassignedAreaId), privateEpoch + 1);
  assert.equal(contentRevision(db, "team-area"), teamEpoch + 1);

  // Move into a project in another Area: the project's Area is the effective one.
  mark = maxSeq(db);
  db.prepare("UPDATE tasks SET area_id=NULL, project_id='pm' WHERE id='m1'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:m1:other-area:upsert:2", "task:m1:team-area:leave:2"]);
  // Re-parenting inside the SAME effective Area is an upsert only: no 'leave'.
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('pm2','other-area','P2')").run();
  mark = maxSeq(db);
  db.prepare("UPDATE tasks SET project_id='pm2' WHERE id='m1'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["task:m1:other-area:upsert:3"]);
});

test("area_members insert, delete and role change log 'membership' entries with the role after the change", () => {
  const { db } = fixture();
  const mark = maxSeq(db);
  const policy = policyRevision(db, "team-area");
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','viewer')").run();
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run(); // same role: nothing
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(logRows(db, mark).map(({ seq, ...r }) => r), [
    { kind: "membership", id: "team-area", area: "team-area", op: "member_add", revision: null, who: "bob", role: "viewer" },
    { kind: "membership", id: "team-area", area: "team-area", op: "member_role", revision: null, who: "bob", role: "editor" },
    { kind: "membership", id: "team-area", area: "team-area", op: "member_remove", revision: null, who: "bob", role: null },
  ]);
  assert.equal(policyRevision(db, "team-area"), policy + 3);
  // The bootstrap-time admin memberships of the fixture are in the log too.
  assert.ok(logRows(db).filter(r => r.op === "member_add" && r.who === "alice").length >= 2);
});

test("projects log upsert on insert and title change; a project Area change stays forbidden and logs nothing", () => {
  const { db } = fixture();
  const mark = maxSeq(db);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','team-area','P')").run();
  db.prepare("UPDATE projects SET title='P2' WHERE id='p'").run();
  assert.deepEqual(brief(logRows(db, mark)), ["project:p:team-area:upsert:0", "project:p:team-area:upsert:1"]);
  const after = maxSeq(db);
  assert.throws(() => db.prepare("UPDATE projects SET area_id='other-area' WHERE id='p'").run(), /project move requires R2 confirmation/);
  assert.deepEqual(logRows(db, after), []);
});

test("with the Area guard dropped, a project move logs leave+upsert for the project and EVERY child task and bumps both epochs once", () => {
  // Fixture-only: such a database no longer passes canonical preflight.
  const { db } = fixture();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('mp','team-area','Moving')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('c1','mp','child 1')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('c2','mp','child 2')").run();
  db.prepare("UPDATE tasks SET title='child 2 edited' WHERE id='c2'").run(); // revision 1
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('standalone','team-area','stays')").run();
  db.exec("DROP TRIGGER project_area_assignment_guard");
  const revisions = () => plain(db.prepare("SELECT id, revision FROM tasks ORDER BY id").all());
  const taskRevisionsBefore = revisions();
  const projectRevision = db.prepare("SELECT revision FROM projects WHERE id='mp'").get().revision;
  const oldEpoch = contentRevision(db, "team-area");
  const newEpoch = contentRevision(db, "other-area");
  const mark = maxSeq(db);
  db.prepare("UPDATE projects SET area_id='other-area' WHERE id='mp'").run();
  assert.deepEqual(brief(logRows(db, mark)), [
    `project:mp:team-area:leave:${projectRevision}`, `project:mp:other-area:upsert:${projectRevision}`,
    "task:c1:team-area:leave:0", "task:c1:other-area:upsert:0",
    "task:c2:team-area:leave:1", "task:c2:other-area:upsert:1",
  ].sort());
  assert.deepEqual(revisions(), taskRevisionsBefore, "child task revisions do not change");
  assert.equal(contentRevision(db, "team-area"), oldEpoch + 1);
  assert.equal(contentRevision(db, "other-area"), newEpoch + 1);
  // The moved children now resolve to the new Area through the view.
  assert.deepEqual(plain(db.prepare("SELECT task_id, effective_area_id FROM task_effective_areas WHERE task_id IN ('c1','c2','standalone') ORDER BY task_id").all()), [
    { task_id: "c1", effective_area_id: "other-area" }, { task_id: "c2", effective_area_id: "other-area" },
    { task_id: "standalone", effective_area_id: "team-area" }]);
});

test("change_log: strictly monotonic, append-only, no replacement, positive seq only", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('a','team-area','a')").run();
  db.prepare("UPDATE tasks SET title='b' WHERE id='a'").run();
  const seqs = logRows(db).map(r => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(seqs.every((seq, i) => i === 0 || seq === seqs[i - 1] + 1), "automatic seqs are gap-free");

  const insert = (seq) => db.prepare(`INSERT INTO change_log(seq,entity_kind,entity_id,area_id,op,revision)
    VALUES (?,'task','x','team-area','upsert',0)`).run(seq);
  const top = maxSeq(db);
  assert.throws(() => db.prepare("UPDATE change_log SET entity_id='x' WHERE seq=1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM change_log WHERE seq=?").run(top), /append-only/);
  assert.throws(() => db.exec("DELETE FROM change_log"), /append-only/);
  assert.throws(() => insert(top), /replacement is forbidden/);
  assert.throws(() => insert(1), /replacement is forbidden/);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO change_log(seq,entity_kind,entity_id,area_id,op,revision)
    VALUES (?,'task','x','team-area','upsert',0)`).run(top), /replacement is forbidden/);
  assert.throws(() => insert(0), /CHECK constraint/);
  assert.throws(() => insert(-5), /CHECK constraint/);
  assert.equal(maxSeq(db), top);
  // An explicit HIGHER seq is accepted; afterwards a lower unused seq is not.
  insert(top + 100);
  assert.throws(() => insert(top + 50), /must increase/);
  db.prepare("UPDATE tasks SET title='c' WHERE id='a'").run();
  assert.equal(maxSeq(db), top + 101, "automatic ids continue above the highest explicit one");
  // Shape CHECKs tie op to kind and nullability.
  const raw = (kind, op, revision, who, role, entity = "x", area = "team-area") =>
    db.prepare(`INSERT INTO change_log(entity_kind,entity_id,area_id,op,revision,member_user_id,member_role)
      VALUES (?,?,?,?,?,?,?)`).run(kind, entity, area, op, revision, who, role);
  assert.throws(() => raw("task", "member_add", 0, null, null), /CHECK constraint/);
  assert.throws(() => raw("task", "upsert", null, null, null), /CHECK constraint/);
  assert.throws(() => raw("task", "upsert", 0, "bob", null), /CHECK constraint/);
  assert.throws(() => raw("membership", "upsert", null, "bob", "viewer", "team-area"), /CHECK constraint/);
  assert.throws(() => raw("membership", "member_add", null, "bob", null, "team-area"), /CHECK constraint/);
  assert.throws(() => raw("membership", "member_remove", null, "bob", "viewer", "team-area"), /CHECK constraint/);
  assert.throws(() => raw("membership", "member_add", 3, "bob", "viewer", "team-area"), /CHECK constraint/);
  assert.throws(() => raw("membership", "member_add", null, "bob", "viewer", "not-the-area"), /CHECK constraint/);
  assert.throws(() => raw("note", "upsert", 0, null, null), /CHECK constraint/);
});

test("tombstone then DELETE: log entry carries the tombstone's change_seq, the OLD Area epoch advances, the ID is gone for good", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('d1','team-area','secret title')").run();
  db.prepare("UPDATE tasks SET title='edited' WHERE id='d1'").run();
  const epoch = contentRevision(db, "team-area");
  const mark = maxSeq(db);
  const removed = tombstoneAndDelete(db, "d1", 1_700_000_000_000);
  assert.equal(removed.revision, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='d1'").get().n, 0);
  const tomb = { ...db.prepare("SELECT * FROM task_tombstones WHERE id='d1'").get() };
  assert.deepEqual(tomb, { id: "d1", area_id: "team-area", revision: 2, change_seq: mark + 1, deleted_at_ms: 1_700_000_000_000 });
  assert.deepEqual(logRows(db, mark), [{ seq: mark + 1, kind: "task", id: "d1", area: "team-area", op: "tombstone", revision: 2, who: null, role: null }]);
  assert.equal(contentRevision(db, "team-area"), epoch + 1);
  // Content-free: no title anywhere in tombstone or log.
  assert.ok(!JSON.stringify([tomb, logRows(db)]).includes("title"));

  // Re-creating the ID is rejected in every flavor; revision and tombstone remain (no ABA).
  const reinsert = "INSERT INTO tasks(id,area_id,title) VALUES ('d1','team-area','resurrected')";
  assert.throws(() => db.exec(reinsert), /task replacement is not allowed/);
  assert.throws(() => db.exec(reinsert.replace("INSERT", "INSERT OR REPLACE")), /task replacement is not allowed/);
  assert.throws(() => db.exec(reinsert.replace("INSERT", "INSERT OR IGNORE").replace("'team-area'", "'other-area'")), /task replacement is not allowed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='d1'").get().n, 0);
  assert.deepEqual({ ...db.prepare("SELECT * FROM task_tombstones WHERE id='d1'").get() }, tomb);
  // Renaming another task onto the tombstoned ID is blocked (IDs immutable).
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('d2','team-area','other')").run();
  assert.throws(() => db.prepare("UPDATE tasks SET id='d1' WHERE id='d2'").run(), /task ID is immutable/);
  assert.throws(() => db.prepare("UPDATE OR REPLACE tasks SET id='d1' WHERE id='d2'").run(), /task ID is immutable/);
  // Tombstones are immutable, permanent and non-replaceable.
  assert.throws(() => db.prepare("UPDATE task_tombstones SET revision=revision+1 WHERE id='d1'").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE task_tombstones SET area_id='other-area' WHERE id='d1'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM task_tombstones WHERE id='d1'").run(), /permanent/);
  assert.throws(() => db.exec("DELETE FROM task_tombstones"), /permanent/);
  // Two independent BEFORE INSERT guards (existing ID; consistency with a live task) both refuse.
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('d1','team-area',9,99,1)").run(), /replacement is forbidden|must match/);
  assert.throws(() => db.prepare("INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('d1','team-area',9,99,1)").run(), /replacement is forbidden|must match/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('d1','team-area',2,?,1)").run(tomb.change_seq), /replacement is forbidden|must match/);
  assert.deepEqual({ ...db.prepare("SELECT * FROM task_tombstones WHERE id='d1'").get() }, tomb);
});

test("deleting needs a matching tombstone: missing, wrong revision, wrong Area and wrong seq are all refused", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('g','team-area','x')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('gp','team-area','P')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('gc','gp','inherited')").run();
  const next = () => maxSeq(db) + 1;
  const tomb = (id, area, revision, seq = next()) => db.prepare(
    "INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES (?,?,?,?,1)").run(id, area, revision, seq);
  assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='g'").run(), /task deletion requires tombstone protocol/);
  assert.throws(() => tomb("g", "team-area", 0), /CHECK constraint|must match/);
  assert.throws(() => tomb("g", "team-area", 2), /must match/);
  assert.throws(() => tomb("g", "other-area", 1), /must match/);
  assert.throws(() => tomb("g", "team-area", 1, next() + 1), /must match/);
  assert.throws(() => tomb("g", "team-area", 1, next() - 1), /replacement is forbidden|must match/);
  assert.throws(() => tomb("never-existed", "team-area", 1), /must match/);
  // An inherited-Area task is tombstoned in the PROJECT's Area, never "no Area".
  assert.throws(() => tomb("gc", "other-area", 1), /must match/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n, 0);

  // A correct tombstone, then the task changes: the deletion guard refuses (revision no longer +1).
  tomb("g", "team-area", 1);
  db.prepare("UPDATE tasks SET title='changed after tombstone' WHERE id='g'").run();
  assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='g'").run(), /task deletion requires tombstone protocol/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='g'").get().n, 1);

  // Another log row between tombstone and DELETE breaks the sequence: the DELETE rolls back as a whole.
  tomb("gc", "team-area", 1);
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('noise','team-area','x')").run();
  assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='gc'").run(), /must increase|replacement is forbidden/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='gc'").get().n, 1);
});

test("project tombstone: refused with tasks or without a matching tombstone, logged on delete, ID never reusable", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('pp','team-area','P')").run();
  db.prepare("UPDATE projects SET title='P2' WHERE id='pp'").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('child','pp','c')").run();
  const tomb = (revision, area = "team-area", seq = maxSeq(db) + 1) => db.prepare(
    "INSERT INTO project_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('pp',?,?,?,5)").run(area, revision, seq);
  assert.throws(() => db.prepare("DELETE FROM projects WHERE id='pp'").run(), /project deletion requires tombstone protocol/);
  assert.throws(() => tomb(1), /must match/);
  assert.throws(() => tomb(2, "other-area"), /must match/);
  assert.throws(() => tomb(2, "team-area", maxSeq(db) + 2), /must match/);
  // A project with a task is never deleted, tombstone or not (even with FKs off).
  db.exec("SAVEPOINT early");
  tomb(2);
  db.exec("PRAGMA foreign_keys=OFF");
  assert.throws(() => db.prepare("DELETE FROM projects WHERE id='pp'").run(), /project deletion requires tombstone protocol/);
  db.exec("PRAGMA foreign_keys=ON; ROLLBACK TO early; RELEASE early");
  tombstoneAndDelete(db, "child");
  // (A tombstone reserves the NEXT sequence: it is created right before its DELETE, as the command does.)
  tomb(2);
  const epoch = contentRevision(db, "team-area");
  const mark = maxSeq(db);
  db.prepare("DELETE FROM projects WHERE id='pp'").run();
  assert.deepEqual(logRows(db, mark), [{ seq: mark + 1, kind: "project", id: "pp", area: "team-area", op: "tombstone", revision: 2, who: null, role: null }]);
  assert.equal(contentRevision(db, "team-area"), epoch + 1);
  assert.throws(() => db.exec("INSERT INTO projects(id,area_id,title) VALUES ('pp','team-area','again')"), /project replacement is not allowed/);
  assert.throws(() => db.exec("INSERT OR REPLACE INTO projects(id,area_id,title) VALUES ('pp','other-area','again')"), /project replacement is not allowed|project move requires/);
  assert.throws(() => db.prepare("UPDATE project_tombstones SET revision=5 WHERE id='pp'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM project_tombstones WHERE id='pp'").run(), /permanent/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO project_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('pp','team-area',9,500,1)").run(), /replacement is forbidden|must match/);
});

test("deleting an assigned task leaves membership guards intact: the member can then be removed without unassigning", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('assigned','team-area','x','bob')").run();
  assert.throws(() => db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run(), /unassign tasks before removing membership/);
  assert.throws(() => db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run(), /unassign tasks before downgrading/);
  tombstoneAndDelete(db, "assigned");
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  // And a still-assigned sibling keeps the guard.
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('assigned2','team-area','x','bob')").run();
  assert.throws(() => db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run(), /unassign tasks before removing membership/);
});

test("tombstone capacity fails closed at TARGET_STAGING_MAX_TOMBSTONES and preflight stays green at the cap", () => {
  const { db, stage } = fixture();
  const insertTask = db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?, 'team-area', 'x')");
  db.exec("BEGIN");
  for (let i = 0; i < TARGET_STAGING_MAX_TOMBSTONES; i++) {
    insertTask.run(`cap-${i}`);
    tombstoneAndDelete(db, `cap-${i}`);
  }
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n, TARGET_STAGING_MAX_TOMBSTONES);
  insertTask.run("over");
  assert.throws(() => db.prepare("INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('over','team-area',1,?,1)")
    .run(maxSeq(db) + 1), /tombstone capacity reached/);
  assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='over'").run(), /task deletion requires tombstone protocol/);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }), { ok: true, mode: "r2-model", issues: [] });
});

/** Run raw SQL with the named triggers dropped, then restore them EXACTLY so only the data checks can object. */
function tamper(db, triggers, sql) {
  const ddl = triggers.map(name => db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name).sql);
  for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
  try { db.exec(sql); } finally { for (const statement of ddl) db.exec(statement); }
}
const issues = stage => inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).issues;

test("preflight rejects a tombstone without its log entry, a stray log tombstone, a mismatch and a live task with a tombstoned ID", () => {
  // Baseline after a legitimate delete: clean.
  const base = fixture();
  base.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('ok','team-area','x')").run();
  tombstoneAndDelete(base.db, "ok");
  assert.deepEqual(issues(base.stage), []);

  // 1. Tombstone whose change_seq has no log entry.
  const orphan = fixture();
  orphan.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('o','team-area','x')").run();
  tamper(orphan.db, ["task_tombstones_consistency"],
    "INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('ghost','team-area',1,99999,1)");
  assert.deepEqual(issues(orphan.stage), ["tombstone_invalid"]);

  // 2. Tombstone pointing at a log entry of another kind/entity/revision.
  const mismatch = fixture();
  mismatch.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('mm','team-area','x')").run();
  tombstoneAndDelete(mismatch.db, "mm");
  tamper(mismatch.db, ["task_tombstones_no_update"],
    "UPDATE task_tombstones SET revision=revision+1 WHERE id='mm'");
  assert.deepEqual(issues(mismatch.stage), ["tombstone_invalid"]);
  const wrongArea = fixture();
  wrongArea.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('wa','team-area','x')").run();
  tombstoneAndDelete(wrongArea.db, "wa");
  tamper(wrongArea.db, ["task_tombstones_no_update"], "UPDATE task_tombstones SET area_id='other-area' WHERE id='wa'");
  assert.deepEqual(issues(wrongArea.stage), ["tombstone_invalid"]);

  // 3. A log 'tombstone' entry nothing explains (forged deletion in the feed).
  const stray = fixture();
  stray.db.prepare(`INSERT INTO change_log(entity_kind,entity_id,area_id,op,revision)
    VALUES ('task','forged','team-area','tombstone',3)`).run();
  assert.deepEqual(issues(stray.stage), ["tombstone_invalid"]);

  // 4. A live task whose ID is tombstoned (resurrection through raw SQL with the guard disabled).
  const live = fixture();
  live.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('rz','team-area','x')").run();
  tombstoneAndDelete(live.db, "rz");
  tamper(live.db, ["task_conflict_guard"], "INSERT INTO tasks(id,area_id,title) VALUES ('rz','team-area','back')");
  assert.deepEqual(issues(live.stage), ["tombstone_invalid"]);
  // ...and the same for a project.
  const liveProject = fixture();
  liveProject.db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('rp','team-area','P')").run();
  tamper(liveProject.db, ["project_tombstones_consistency"],
    `INSERT INTO change_log(seq,entity_kind,entity_id,area_id,op,revision) VALUES (500,'project','rp','team-area','tombstone',1);
     INSERT INTO project_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('rp','team-area',1,500,1)`);
  assert.deepEqual(issues(liveProject.stage), ["tombstone_invalid"]);

  // Simply dropping a guard is caught by the schema comparison.
  const dropped = fixture();
  dropped.db.exec("DROP TRIGGER task_tombstones_no_delete");
  assert.ok(issues(dropped.stage).includes("schema_invalid"));
});

test("replace guards hold on their own: tombstones and the log refuse REPLACE even if the consistency trigger were absent", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('r','team-area','x')").run();
  const removed = tombstoneAndDelete(db, "r");
  const before = plain(db.prepare("SELECT * FROM task_tombstones").all());
  const logBefore = logRows(db);
  // Consistency off: only the replace guards remain between a forged tombstone and the original.
  db.exec("DROP TRIGGER task_tombstones_consistency");
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('r','other-area',50,77,1)").run(), /tombstone replacement is forbidden/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES ('another','other-area',50,?,1)").run(removed.seq), /tombstone replacement is forbidden/);
  assert.deepEqual(plain(db.prepare("SELECT * FROM task_tombstones").all()), before);
  // Log: REPLACE of the newest row, and of an older one, are refused by the BEFORE INSERT guard.
  for (const seq of [maxSeq(db), 1]) {
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO change_log(seq,entity_kind,entity_id,area_id,op,revision)
      VALUES (?,'task','forged','team-area','tombstone',9)`).run(seq), /change log replacement is forbidden/);
  }
  assert.deepEqual(logRows(db), logBefore);
});
