import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d-task-temporal-v20-"));
const previousDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "do-not-modify");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (previousDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previousDataDir;
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "do-not-modify");
  rmSync(root, { recursive: true, force: true });
});

const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION } =
  await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } =
  await import("../lib/target-store-preflight.ts");
const { TargetStagingSessionAuthority } =
  await import("../lib/target-staging-session-authority.ts");
let serial = 0;
function fixture() {
  const result = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "target-" + ++serial), ownerUserId: "owner",
  });
  const db = new DatabaseSync(result.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  return { db, result };
}
const check = result => inspectIsolatedTargetStore({
  stagingDirectory: result.directory, mode: "r2-model",
  expectedOwnerUserId: "owner",
  expectedRestoreGeneration: result.restoreGeneration,
});
const task = db => db.prepare(
  "SELECT status,completed_at_ms AS completedAt,due_on AS dueOn,revision FROM tasks WHERE id='t'",
).get();
const areaEpoch = (db, areaId) => db.prepare(
  "SELECT content_revision AS n FROM areas WHERE id=?",
).get(areaId).n;
const taskEvents = db => db.prepare(
  "SELECT op,revision FROM change_log WHERE entity_kind='task' AND entity_id='t' ORDER BY seq",
).all().map(x=>[x.op,x.revision]);

test("v22 fresh staging retains v20 open task, due date and exact preflight", () => {
  assert.equal(TARGET_STORE_SCHEMA_VERSION,25);
  const { db, result } = fixture();
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map(r=>r.name));
    for (const name of ["status","completed_at_ms","due_on"]) assert.ok(columns.has(name));
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t',?,'Default')")
      .run(result.unassignedAreaId);
    assert.deepEqual({...task(db)},{
      status:"open",completedAt:null,dueOn:null,revision:0,
    });
    assert.equal(areaEpoch(db, result.unassignedAreaId), 1);
    assert.deepEqual(taskEvents(db),[["upsert",0]]);
  } finally { db.close(); }
  assert.deepEqual(check(result),{ok:true,mode:"r2-model",issues:[]});
});

test("status and completion timestamp are consistent and bounded", () => {
  const {db,result}=fixture();
  try {
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t',?,'State')")
      .run(result.unassignedAreaId);
    for (const sql of [
      "UPDATE tasks SET status='completed' WHERE id='t'",
      "UPDATE tasks SET status='invalid' WHERE id='t'",
      "UPDATE tasks SET completed_at_ms=1000 WHERE id='t'",
      "UPDATE tasks SET status='completed', completed_at_ms=-1 WHERE id='t'",
      "UPDATE tasks SET status='completed', completed_at_ms=9007199254740992 WHERE id='t'",
      "UPDATE tasks SET status='completed', completed_at_ms=1.5 WHERE id='t'",
      "UPDATE tasks SET status='completed', completed_at_ms='not-a-time' WHERE id='t'",
    ]) assert.throws(()=>db.exec(sql),/CHECK constraint failed/i,sql);
    assert.equal(task(db).revision,0);
    db.prepare("UPDATE tasks SET status='completed', completed_at_ms=1793700000000 WHERE id='t'").run();
    assert.deepEqual({...task(db)},{
      status:"completed",completedAt:1793700000000,dueOn:null,revision:1,
    });
    assert.throws(()=>db.exec("UPDATE tasks SET status='open' WHERE id='t'"),
      /CHECK constraint failed/i);
    db.prepare("UPDATE tasks SET status='open',completed_at_ms=NULL WHERE id='t'").run();
    assert.equal(task(db).status,"open");
    assert.equal(task(db).completedAt,null);
    assert.equal(task(db).revision,2);
  } finally {db.close();}
  assert.deepEqual(check(result),{ok:true,mode:"r2-model",issues:[]});
});

test("due_on accepts only a real ISO calendar day, including leap day", () => {
  const {db,result}=fixture();
  try {
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t',?,'Date')")
      .run(result.unassignedAreaId);
    for (const invalid of ["2026-02-29","2026-02-30","2026-13-01",
      "2026-00-01","2026-01-00","2026-2-01","2026-01-1",
      "2026-01-01T00:00:00Z","2026-01-01 ","abcd-ef-gh"]) {
      assert.throws(() => db.prepare("UPDATE tasks SET due_on=? WHERE id='t'").run(invalid),
        /CHECK constraint failed/i,invalid);
    }
    assert.equal(task(db).dueOn,null);
    db.prepare("UPDATE tasks SET due_on='2028-02-29' WHERE id='t'").run();
    assert.equal(task(db).dueOn,"2028-02-29");
    db.prepare("UPDATE tasks SET due_on=NULL WHERE id='t'").run();
    assert.equal(task(db).dueOn,null);
    assert.equal(task(db).revision,2);
  } finally {db.close();}
  assert.deepEqual(check(result),{ok:true,mode:"r2-model",issues:[]});
});

test("temporal changes bump task and Area epochs exactly once, including ABA", () => {
  const {db,result}=fixture();
  try {
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p',?,'Parent')")
      .run(result.unassignedAreaId);
    db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('t','p','Child')").run();
    const getProjectEpoch=()=>db.prepare(
      "SELECT project_content_revision AS n FROM areas WHERE id=?",
    ).get(result.unassignedAreaId).n;
    assert.equal(areaEpoch(db,result.unassignedAreaId),1);
    assert.equal(getProjectEpoch(),1);
    db.prepare("UPDATE tasks SET due_on='2026-11-30' WHERE id='t'").run();
    db.prepare("UPDATE tasks SET due_on='2026-11-30' WHERE id='t'").run(); // no-op
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793700000000 WHERE id='t'").run();
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793700000000 WHERE id='t'").run();
    db.prepare("UPDATE tasks SET status='open',completed_at_ms=NULL,due_on=NULL WHERE id='t'").run();
    assert.equal(task(db).revision,3);
    assert.equal(areaEpoch(db,result.unassignedAreaId),4);
    assert.equal(getProjectEpoch(),1,"task metadata must not change project-only pagination");
    assert.deepEqual(taskEvents(db),[
      ["upsert",0],["upsert",1],["upsert",2],["upsert",3],
    ]);
    assert.throws(()=>db.exec("UPDATE tasks SET revision=0 WHERE id='t'"),
      /task revision must increment by one/);
  } finally {db.close();}
  assert.deepEqual(check(result),{ok:true,mode:"r2-model",issues:[]});
});

test("temporal pages preserve the existing v20 task-ID contract without blocking other readers", () => {
  // Existing change-feed and signed-cursor clients support padded, empty,
  // Unicode and multi-kilobyte TEXT IDs. A new temporal DTO must not turn a
  // valid canonical staging store into an unavailable store.
  for (const specialId of ["bad ", " ".repeat(2), "x".repeat(3000),
    "\u00a0bad", "\u{1F600}x", "", "bad\u0001id"]) {
    const {db,result}=fixture();
    try {
      db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)")
        .run("a-normal",result.unassignedAreaId,"Visible normal task");
      db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)")
        .run(specialId,result.unassignedAreaId,"Visible unusual task");
    } finally {db.close();}
    assert.deepEqual(check(result),{ok:true,mode:"r2-model",issues:[]});
    const authority=new TargetStagingSessionAuthority({
      stagingDirectory:result.directory,expectedRestoreGeneration:result.restoreGeneration,
    });
    try {
      const page=authority.readTemporalTaskPage("owner","personal","all",100,0);
      assert.ok(page, "authorized temporal page should remain available");
      assert.deepEqual(page.tasks.map(t=>t.id).sort(),["a-normal",specialId].sort());
      assert.equal(authority.readTemporalTaskDetail("owner","a-normal")?.task.id,"a-normal");
      assert.equal(authority.readTemporalTaskDetail("owner",specialId)?.task.id,specialId);
      assert.equal(authority.readTemporalTaskDetail("unknown",specialId),null,
        "allowing an existing ID format must not bypass actor authorization");
    } finally {authority.close();}
  }
});

test("v19 metadata cannot silently become v20 without a new isolated store", () => {
  const {db,result}=fixture();
  try {
    db.prepare("UPDATE metadata SET value='19' WHERE key='schema_version'").run();
  } finally {db.close();}
  const inspected=check(result);
  assert.equal(inspected.ok,false);
  assert.ok(inspected.issues.includes("metadata_invalid"),JSON.stringify(inspected));
});
