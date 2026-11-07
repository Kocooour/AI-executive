import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3k1-personal-when-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const original=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STORE_SCHEMA_VERSION,
  TARGET_STAGING_MAX_PERSONAL_PLANS}=await import("../lib/target-store-bootstrap.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
let serial=0;
const fixtures=[];
function setup(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Project')").run();
  const add=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id) VALUES (?,?,?,?,?)");
  for(const row of [
    ["alice-private",stage.unassignedAreaId,null,"Alice private",null],
    ["bob-private","bob-private",null,"Bob private",null],
    ["erin-private","erin-private",null,"Erin private",null],
    ["shared-bob","family-area",null,"Shared assigned Bob","bob"],
    ["shared-alice","family-area",null,"Shared assigned Alice","alice"],
    ["shared-free","family-area",null,"Shared unassigned",null],
    ["shared-child",null,"project","Project child","bob"],
  ]) add.run(...row);
  fixtures.push(db);
  return {db,stage};
}
after(()=>{
  for(const db of fixtures)db.close();
  if(original===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=original;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const inspect=stage=>inspectIsolatedTargetStore({
  stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  mode:"r2-model",
});
const write=(db,who,task,when="2026-11-05")=>
  db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)")
    .run(who,task,when);
const get=(db,who,task)=>db.prepare(
  "SELECT when_on AS whenOn,revision FROM personal_task_plans WHERE user_id=? AND task_id=?")
  .get(who,task);
const epoch=(db,who)=>db.prepare(
  "SELECT revision AS n FROM personal_plan_epochs WHERE user_id=?").get(who)?.n;
const taskRevision=(db,task)=>db.prepare("SELECT revision FROM tasks WHERE id=?").get(task).revision;
const areaRevision=(db,area)=>db.prepare(
  "SELECT content_revision FROM areas WHERE id=?").get(area).content_revision;

test("v21+ is fresh-only and private plan epochs exist for each identity",()=>{
  assert.equal(TARGET_STORE_SCHEMA_VERSION,22);
  assert.equal(TARGET_STAGING_MAX_PERSONAL_PLANS,4096);
  const {db,stage}=setup();
  assert.deepEqual(db.prepare("SELECT user_id,revision FROM personal_plan_epochs ORDER BY user_id").all()
    .map(x=>({...x})),["alice","bob","carol","erin"].map(user_id=>({user_id,revision:0})));
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
  assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name='when_on'").all(),[]);
  assert.deepEqual(db.prepare("SELECT * FROM personal_task_plans").all(),[]);
  db.prepare("UPDATE metadata SET value='20' WHERE key='schema_version'").run();
  const invalid=inspect(stage);
  assert.equal(invalid.ok,false);
  assert.ok(invalid.issues.includes("metadata_invalid"),JSON.stringify(invalid));
});

test("private plan ownership and shared assignment/editor rules are enforced in SQLite",()=>{
  const {db,stage}=setup();
  for(const [who,task] of [
    ["alice","bob-private"],["bob","alice-private"],["carol","bob-private"],
    ["bob","shared-alice"],["carol","shared-bob"],
    ["carol","shared-free"],["bob","shared-free"],["alice","shared-free"],
    ["erin","shared-bob"],["erin","erin-missing"],
  ]) assert.throws(()=>write(db,who,task),
    /plan requires owned or assigned editable task/,who+"/"+task);
  write(db,"alice","alice-private");
  write(db,"bob","bob-private");
  write(db,"erin","erin-private");
  write(db,"bob","shared-bob");
  write(db,"bob","shared-child");
  write(db,"alice","shared-alice");
  assert.deepEqual({...get(db,"bob","shared-child")},{whenOn:"2026-11-05",revision:0});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_task_plans").get().n,6);
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
});

test("strict Gregorian dates, no REPLACE, monotonic private revision and epoch ABA",()=>{
  const {db,stage}=setup();
  for(const day of ["0000-01-01","2026-02-29","2026-02-30",
    "1900-02-29","2026-04-31","2026-13-01","2026-11-5",
    "2026-11-05T00:00:00Z","99999-12-01","not-a-date"]) {
    assert.throws(()=>write(db,"bob","bob-private",day),/CHECK constraint failed/,day);
  }
  const privateArea="bob-private";
  const areaBefore=areaRevision(db,privateArea);
  const taskBefore=taskRevision(db,"bob-private");
  write(db,"bob","bob-private","2024-02-29");
  assert.equal(epoch(db,"bob"),1);
  assert.equal(epoch(db,"alice"),0);
  assert.deepEqual({...get(db,"bob","bob-private")},{whenOn:"2024-02-29",revision:0});
  assert.throws(()=>db.prepare(
    "INSERT OR REPLACE INTO personal_task_plans(user_id,task_id,when_on) VALUES ('bob','bob-private','2026-11-06')").run(),
    /plan replacement forbidden/);
  assert.throws(()=>db.prepare(
    "UPDATE personal_task_plans SET user_id='alice' WHERE user_id='bob'").run(),
    /plan owner or task ACL invalid/);
  assert.throws(()=>db.prepare(
    "UPDATE personal_task_plans SET revision=0 WHERE user_id='bob'").run(),
    /plan revision must increment by one/);
  db.prepare("UPDATE personal_task_plans SET when_on='2024-02-29' WHERE user_id='bob'").run();
  assert.equal(epoch(db,"bob"),1,"same date is a no-op");
  db.prepare("UPDATE personal_task_plans SET when_on='2026-11-05' WHERE user_id='bob'").run();
  assert.deepEqual({...get(db,"bob","bob-private")},{whenOn:"2026-11-05",revision:1});
  db.prepare("UPDATE personal_task_plans SET when_on='2024-02-29' WHERE user_id='bob'").run();
  assert.deepEqual({...get(db,"bob","bob-private")},{whenOn:"2024-02-29",revision:2});
  assert.equal(epoch(db,"bob"),3);
  db.prepare("DELETE FROM personal_task_plans WHERE user_id='bob' AND task_id='bob-private'").run();
  assert.equal(epoch(db,"bob"),4);
  write(db,"bob","bob-private","2024-02-29");
  assert.equal(epoch(db,"bob"),5,"delete/reinsert cannot restore original private cursor epoch");
  assert.equal(areaRevision(db,privateArea),areaBefore,"private when never bumps shared Area epoch");
  assert.equal(taskRevision(db,"bob-private"),taskBefore,"private when never edits canonical task");
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
});

test("lost shared assignment clears plan atomically, never resurrects on re-assignment",()=>{
  const {db,stage}=setup();
  write(db,"bob","shared-bob");
  write(db,"bob","shared-child");
  write(db,"alice","shared-alice");
  const initialEpoch=epoch(db,"bob");
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id IN ('shared-bob','shared-child')").run();
  assert.equal(get(db,"bob","shared-bob"),undefined);
  assert.equal(get(db,"bob","shared-child"),undefined);
  assert.equal(epoch(db,"bob"),initialEpoch+2);
  assert.deepEqual({...get(db,"alice","shared-alice")},{whenOn:"2026-11-05",revision:0});
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id='shared-bob'").run();
  assert.equal(get(db,"bob","shared-bob"),undefined);
  write(db,"bob","shared-bob");
  assert.equal(epoch(db,"bob"),initialEpoch+3);
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
});

test("completed tasks and membership loss purge only affected actors' plans",()=>{
  const {db,stage}=setup();
  write(db,"bob","shared-bob");
  write(db,"bob","shared-child");
  write(db,"alice","shared-alice");
  write(db,"bob","bob-private");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='shared-bob'").run();
  assert.equal(get(db,"bob","shared-bob"),undefined);
  assert.ok(get(db,"bob","shared-child"));
  // Even completed tasks retain assignees; the canonical membership policy
  // requires every shared assignment to be cleared before demotion.
  assert.throws(()=>db.prepare(
    "UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run(),
    /unassign tasks before downgrading membership/);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(get(db,"bob","shared-child"),undefined);
  assert.ok(get(db,"bob","bob-private"));
  assert.ok(get(db,"alice","shared-alice"));
  assert.throws(()=>write(db,"bob","shared-child"),/plan requires owned or assigned editable task/);
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(get(db,"bob","bob-private").whenOn,"2026-11-05");
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
});

test("owner-private plans never pollute shared task DTO, per-Area log, or another user's epoch",()=>{
  const {db,stage}=setup();
  const beforeTask=taskRevision(db,"shared-bob");
  const beforeArea=areaRevision(db,"family-area");
  const beforeCount=db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  write(db,"bob","shared-bob","2026-11-08");
  write(db,"alice","alice-private","2026-11-11");
  assert.equal(epoch(db,"bob"),1);
  assert.equal(epoch(db,"alice"),1);
  assert.equal(epoch(db,"carol"),0);
  assert.equal(taskRevision(db,"shared-bob"),beforeTask);
  assert.equal(areaRevision(db,"family-area"),beforeArea);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n,beforeCount);
  assert.deepEqual(db.prepare("SELECT * FROM tasks WHERE id='shared-bob'").get().when_on,undefined);
  assert.deepEqual(inspect(stage),{ok:true,mode:"r2-model",issues:[]});
});
