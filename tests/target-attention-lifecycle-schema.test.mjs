import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5b1-attention-lifecycle-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const original=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STORE_SCHEMA_VERSION,TARGET_SCHEMA_SQL,
  TARGET_STAGING_MAX_ATTENTION_STATES}=await import("../lib/target-store-bootstrap.ts");
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
  const add=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["alice-private",stage.unassignedAreaId,null,"Alice private",null,"2026-11-01"],
    ["bob-private","bob-private",null,"Bob private",null,"2026-11-01"],
    ["bob-private2","bob-private",null,"Bob private 2",null,"2026-11-02"],
    ["erin-private","erin-private",null,"Erin private",null,"2026-11-01"],
    ["shared-bob","family-area",null,"Shared assigned Bob","bob","2026-11-01"],
    ["shared-alice","family-area",null,"Shared assigned Alice","alice","2026-11-01"],
    ["shared-free","family-area",null,"Shared unassigned",null,"2026-11-01"],
    ["shared-child",null,"project","Project child","bob","2026-11-01"],
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
const OK={ok:true,mode:"r2-model",issues:[]};
const put=(db,who,task,rule,on,st="dismissed",until=null)=>db.prepare(
  "INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES (?,?,?,?,?,?)")
  .run(who,task,rule,on,st,until);
const plan=(db,who,task,when)=>db.prepare(
  "INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(who,task,when);
const rows=(db,who)=>db.prepare(
  "SELECT task_id AS t,rule_id AS r,occurrence_on AS o,state AS s,snoozed_until_ms AS u,revision AS v FROM personal_attention_states"+
  (who?" WHERE user_id=?":"")+" ORDER BY user_id,task_id,rule_id,occurrence_on").all(...(who?[who]:[])).map(x=>({...x}));
const count=db=>db.prepare("SELECT COUNT(*) AS n FROM personal_attention_states").get().n;
const epoch=(db,who)=>db.prepare(
  "SELECT revision AS n FROM personal_attention_epochs WHERE user_id=?").get(who)?.n;
const planEpoch=(db,who)=>db.prepare(
  "SELECT revision AS n FROM personal_plan_epochs WHERE user_id=?").get(who)?.n;
const OVER="deadline_overdue",SOON="deadline_soon",PLAN="planned_date_passed";

test("v23 is fresh-only (v22 attention schema retained); every identity gets an independent attention epoch",()=>{
  assert.equal(TARGET_STORE_SCHEMA_VERSION,26);
  assert.equal(TARGET_STAGING_MAX_ATTENTION_STATES,4096);
  assert.ok(TARGET_SCHEMA_SQL.includes("personal_attention_state_capacity"));
  assert.ok(TARGET_SCHEMA_SQL.includes("(SELECT COUNT(*) FROM personal_attention_states) >= 4096"));
  const {db,stage}=setup();
  assert.deepEqual(db.prepare("SELECT user_id,revision FROM personal_attention_epochs ORDER BY user_id").all()
    .map(x=>({...x})),["alice","bob","carol","erin"].map(user_id=>({user_id,revision:0})));
  assert.deepEqual(rows(db),[]);
  assert.deepEqual(inspect(stage),OK);
  db.prepare("UPDATE metadata SET value='21' WHERE key='schema_version'").run();
  const invalid=inspect(stage);
  assert.equal(invalid.ok,false);
  assert.ok(invalid.issues.includes("metadata_invalid"),JSON.stringify(invalid));
  assert.throws(()=>db.prepare("DELETE FROM personal_attention_epochs WHERE user_id='bob'").run(),/deletion forbidden/);
  assert.throws(()=>db.prepare("UPDATE personal_attention_epochs SET user_id='x' WHERE user_id='bob'").run(),/immutable/);
  assert.throws(()=>db.prepare("UPDATE personal_attention_epochs SET revision=5 WHERE user_id='bob'").run(),/increment by one/);
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO personal_attention_epochs(user_id) VALUES ('bob')").run(),/replacement forbidden/);
});

test("insert guards: ACL, completed task, wrong occurrence, column invariants",()=>{
  const {db,stage}=setup();
  const guard=/attention state requires eligible task occurrence/;
  for(const [who,task] of [
    ["alice","bob-private"],["bob","alice-private"],["carol","bob-private"],
    ["bob","shared-alice"],["carol","shared-bob"],["carol","shared-free"],
    ["bob","shared-free"],["alice","shared-free"],["erin","shared-bob"],
    ["erin","missing-task"],
  ]) assert.throws(()=>put(db,who,task,OVER,"2026-11-01"),guard,who+"/"+task);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='bob-private2'").run();
  assert.throws(()=>put(db,"bob","bob-private2",OVER,"2026-11-02"),guard,"completed");
  // Wrong occurrence for deadline rules.
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-02"),guard);
  assert.throws(()=>put(db,"bob","bob-private",SOON,"2026-10-31"),guard);
  // Planned requires the actor's own matching plan.
  assert.throws(()=>put(db,"bob","bob-private",PLAN,"2026-11-01"),guard,"planned without plan");
  plan(db,"bob","bob-private","2026-11-03");
  assert.throws(()=>put(db,"bob","bob-private",PLAN,"2026-11-01"),guard,"planned wrong day");
  assert.throws(()=>put(db,"erin","erin-private",PLAN,"2026-11-03"),guard,"another user's plan");
  // Column invariants.
  const chk=/CHECK constraint failed|eligible task occurrence/;
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","dismissed",100),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",null),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",0),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",-5),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",1.5),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",Number.MAX_SAFE_INTEGER+2),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","hidden"),chk);
  assert.throws(()=>put(db,"bob","bob-private","other_rule","2026-11-01"),chk);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-02-30"),chk);
  assert.equal(count(db),0);
  assert.equal(epoch(db,"bob"),0);
  // Valid ones.
  put(db,"bob","bob-private",OVER,"2026-11-01");
  put(db,"bob","bob-private",PLAN,"2026-11-03","snoozed",Number.MAX_SAFE_INTEGER);
  put(db,"bob","shared-bob",SOON,"2026-11-01","snoozed",1);
  put(db,"bob","shared-child",OVER,"2026-11-01");
  put(db,"alice","shared-alice",OVER,"2026-11-01");
  put(db,"alice","alice-private",SOON,"2026-11-01");
  assert.equal(count(db),6);
  assert.deepEqual(inspect(stage),OK);
});

test("no replace, immutable identity, monotonic revision, epoch bumps (ABA) for that user only",()=>{
  const {db,stage}=setup();
  put(db,"bob","bob-private",OVER,"2026-11-01");
  assert.equal(epoch(db,"bob"),1);
  assert.equal(epoch(db,"alice"),0);
  assert.throws(()=>put(db,"bob","bob-private",OVER,"2026-11-01","snoozed",5),/replacement forbidden/);
  assert.throws(()=>db.prepare(
    "INSERT OR REPLACE INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','bob-private','deadline_overdue','2026-11-01','dismissed')").run(),
    /replacement forbidden/);
  for(const set of ["user_id='alice'","task_id='bob-private2'","rule_id='deadline_soon'","occurrence_on='2026-11-02'"])
    assert.throws(()=>db.prepare("UPDATE personal_attention_states SET "+set).run(),
      /identity or task ACL invalid/,set);
  assert.throws(()=>db.prepare("UPDATE personal_attention_states SET revision=0").run(),/increment by one/);
  assert.throws(()=>db.prepare("UPDATE personal_attention_states SET revision=7").run(),/increment by one/);
  db.prepare("UPDATE personal_attention_states SET state='dismissed'").run();
  assert.equal(epoch(db,"bob"),1,"no-op update");
  db.prepare("UPDATE personal_attention_states SET state='snoozed',snoozed_until_ms=100").run();
  assert.deepEqual(rows(db),[{t:"bob-private",r:OVER,o:"2026-11-01",s:"snoozed",u:100,v:1}]);
  db.prepare("UPDATE personal_attention_states SET snoozed_until_ms=200").run();
  assert.equal(rows(db)[0].v,2);
  db.prepare("UPDATE personal_attention_states SET state='dismissed',snoozed_until_ms=NULL").run();
  assert.equal(rows(db)[0].v,3);
  assert.equal(epoch(db,"bob"),4);
  db.prepare("DELETE FROM personal_attention_states").run();
  assert.equal(epoch(db,"bob"),5);
  put(db,"bob","bob-private",OVER,"2026-11-01");
  assert.equal(epoch(db,"bob"),6,"delete/reinsert never restores an old epoch");
  for(const who of ["alice","carol","erin"])assert.equal(epoch(db,who),0,who);
  assert.equal(planEpoch(db,"bob"),0,"attention never touches the plan epoch");
  assert.deepEqual(inspect(stage),OK);
});

test("capacity trigger aborts at the limit",()=>{
  const {db,stage}=setup();
  // Fast: raise the fixture cheaply by inserting 4096 rows with triggers bypassed.
  db.exec("DROP TRIGGER personal_attention_state_insert_guard");
  db.exec("DROP TRIGGER personal_attention_state_insert_epoch");
  const ins=db.prepare(
    "INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','bob-private','deadline_overdue',?,'dismissed')");
  db.exec("BEGIN");
  for(let i=0;i<4096;i++){
    const d=new Date(Date.UTC(2000,0,1)+i*86400000).toISOString().slice(0,10);
    ins.run(d);
  }
  db.exec("COMMIT");
  assert.equal(count(db),4096);
  assert.throws(()=>ins.run("1999-01-01"),/attention state capacity reached/);
  assert.equal(count(db),4096);
  void stage;
});

test("reconcile: completion, unassignment, re-assignment never restores",()=>{
  const {db,stage}=setup();
  put(db,"bob","shared-bob",OVER,"2026-11-01");
  put(db,"bob","shared-child",SOON,"2026-11-01");
  put(db,"bob","bob-private",OVER,"2026-11-01");
  put(db,"alice","shared-alice",OVER,"2026-11-01");
  const e=epoch(db,"bob");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='shared-bob'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private","shared-child"]);
  assert.equal(epoch(db,"bob"),e+1);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-child'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id='shared-child'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"],"re-assignment does not restore");
  assert.throws(()=>put(db,"bob","shared-bob",OVER,"2026-11-01"),/eligible task occurrence/);
  // Reopen is not possible/irrelevant; completed task never regains the row.
  assert.equal(rows(db,"alice").length,1);
  assert.equal(epoch(db,"alice"),1);
  assert.deepEqual(inspect(stage),OK);
});

test("reconcile: membership delete, viewer downgrade, task delete cascade",()=>{
  const {db,stage}=setup();
  put(db,"bob","shared-child",OVER,"2026-11-01");
  put(db,"bob","bob-private",OVER,"2026-11-01");
  put(db,"alice","shared-alice",OVER,"2026-11-01");
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id='shared-child'").run();
  put(db,"bob","shared-child",SOON,"2026-11-01");
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-child'").run();
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  assert.deepEqual(rows(db,"alice").map(x=>x.t),["shared-alice"]);
  const e=epoch(db,"bob");
  db.exec(`BEGIN;
    INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms)
      SELECT t.id,t.area_id,t.revision+1,(SELECT COALESCE(MAX(seq),0)+1 FROM change_log),${Date.now()}
        FROM tasks t WHERE t.id='bob-private';
    DELETE FROM tasks WHERE id='bob-private'; COMMIT;`);
  assert.equal(rows(db,"bob").length,0);
  assert.equal(epoch(db,"bob"),e+1);
  assert.deepEqual(inspect(stage),OK);
});

test("membership trigger SQL directly purges the user's states (mirror of plan triggers)",()=>{
  const {db}=setup();
  // Simulate the post-condition without the unassign precondition by checking
  // the trigger definitions exist for each reconcile path.
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'personal_attention_%'")
    .all().map(x=>x.name);
  for(const n of ["personal_attention_state_task_reconcile","personal_attention_state_due_reconcile",
    "personal_attention_state_plan_reconcile","personal_attention_state_plan_delete",
    "personal_attention_state_membership_delete","personal_attention_state_membership_downgrade",
    "personal_attention_state_project_move","personal_attention_state_capacity",
    "personal_attention_state_no_replace","personal_attention_epoch_on_identity"])
    assert.ok(names.includes(n),n);
});

test("reconcile: due_on change supersedes only that task's deadline states",()=>{
  const {db,stage}=setup();
  plan(db,"bob","bob-private","2026-11-03");
  put(db,"bob","bob-private",OVER,"2026-11-01");
  put(db,"bob","bob-private",SOON,"2026-11-01","snoozed",50);
  put(db,"bob","bob-private",PLAN,"2026-11-03");
  put(db,"bob","bob-private2",OVER,"2026-11-02");
  put(db,"erin","erin-private",OVER,"2026-11-01");
  const eb=epoch(db,"bob"),ee=epoch(db,"erin");
  db.prepare("UPDATE tasks SET due_on='2026-11-01' WHERE id='bob-private'").run();
  assert.equal(count(db),5,"same due_on is a no-op");
  db.prepare("UPDATE tasks SET due_on='2026-11-09' WHERE id='bob-private'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t+"/"+x.r),["bob-private/planned_date_passed","bob-private2/deadline_overdue"]);
  assert.equal(epoch(db,"bob"),eb+2);
  assert.equal(epoch(db,"erin"),ee);
  assert.equal(rows(db,"erin").length,1);
  db.prepare("UPDATE tasks SET due_on=NULL WHERE id='bob-private2'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  assert.deepEqual(inspect(stage),OK);
});

test("reconcile: when_on change and plan delete remove planned states",()=>{
  const {db,stage}=setup();
  plan(db,"bob","bob-private","2026-11-03");
  plan(db,"bob","bob-private2","2026-11-03");
  plan(db,"erin","erin-private","2026-11-03");
  put(db,"bob","bob-private",PLAN,"2026-11-03");
  put(db,"bob","bob-private",OVER,"2026-11-01");
  put(db,"bob","bob-private2",PLAN,"2026-11-03");
  put(db,"erin","erin-private",PLAN,"2026-11-03");
  db.prepare("UPDATE personal_task_plans SET when_on='2026-11-03' WHERE user_id='bob' AND task_id='bob-private'").run();
  assert.equal(count(db),4,"same day keeps the occurrence");
  db.prepare("UPDATE personal_task_plans SET when_on='2026-11-04' WHERE user_id='bob' AND task_id='bob-private'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t+"/"+x.r),
    ["bob-private/deadline_overdue","bob-private2/planned_date_passed"]);
  db.prepare("DELETE FROM personal_task_plans WHERE user_id='bob' AND task_id='bob-private2'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  assert.equal(rows(db,"erin").length,1,"other user untouched");
  // Plan deletion caused by another reconcile trigger cascades into planned states.
  put(db,"erin","erin-private",SOON,"2026-11-01");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='erin-private'").run();
  assert.equal(rows(db,"erin").length,0);
  // Shared assignee: unassign removes plan then states.
  plan(db,"bob","shared-bob","2026-11-03");
  put(db,"bob","shared-bob",PLAN,"2026-11-03");
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  assert.deepEqual(rows(db,"bob").map(x=>x.t),["bob-private"]);
  assert.deepEqual(inspect(stage),OK);
});

test("preflight: valid store ok; tampered rows and missing epoch are personal_attention_invalid",()=>{
  const cases={
    "orphan task"(db){db.exec("PRAGMA foreign_keys=OFF");db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','ghost','deadline_overdue','2026-11-01','dismissed')").run();},
    "foreign task"(db){db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','erin-private','deadline_overdue','2026-11-01','dismissed')").run();},
    "wrong occurrence"(db){db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','bob-private','deadline_overdue','2026-11-07','dismissed')").run();},
    "planned without plan"(db){db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','bob-private','planned_date_passed','2026-11-01','dismissed')").run();},
    "bad columns"(db){db.exec("PRAGMA ignore_check_constraints=ON");db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES ('bob','bob-private','deadline_overdue','2026-11-01','dismissed',5)").run();},
    "completed task"(db){db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','bob-private','deadline_overdue','2026-11-01','dismissed')").run();db.exec("DROP TRIGGER personal_attention_state_task_reconcile");db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='bob-private'").run();},
    "missing epoch"(db){db.exec("DROP TRIGGER personal_attention_epoch_no_delete");db.prepare("DELETE FROM personal_attention_epochs WHERE user_id='carol'").run();},
    "orphan epoch"(db){db.exec("PRAGMA foreign_keys=OFF");db.prepare("INSERT INTO personal_attention_epochs(user_id) VALUES ('ghost')").run();},
  };
  for(const [name,tamper] of Object.entries(cases)){
    const {db,stage}=setup();
    assert.deepEqual(inspect(stage),OK,name+" baseline");
    // Tamper by dropping the insert guards so the invalid row can exist.
    if(!name.includes("epoch")&&name!=="completed task"){
      db.exec("DROP TRIGGER personal_attention_state_insert_guard");
    }
    tamper(db);
    const result=inspect(stage);
    assert.equal(result.ok,false,name);
    assert.ok(result.issues.includes("personal_attention_invalid"),name+" "+JSON.stringify(result));
  }
});

test("review fixes: new rows start at revision 0; selector and preflight fail closed on malformed or stale rows",async()=>{
  const {readAuthorizedAttentionCandidatePage}=await import("../lib/target-attention-read-model.ts");
  const read=(db,stage)=>readAuthorizedAttentionCandidatePage(db,{
    actorUserId:"bob",areaFilter:"all",view:"active",
    evaluatedAtMs:Date.parse("2026-11-04T11:00:00Z"),timeZone:"Europe/Prague",
    limit:100,offset:0,restoreGeneration:stage.restoreGeneration,
  });
  {
    const {db}=setup();
    assert.throws(()=>db.prepare(
      "INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,revision) VALUES ('bob','bob-private',?,'2026-11-01','dismissed',7)")
      .run(OVER),/attention state requires eligible task occurrence/);
    assert.equal(count(db),0);
  }
  {
    // A malformed own row (CHECK bypassed) matches neither view: null, not omission.
    const {db,stage}=setup();
    assert.ok(read(db,stage));
    db.exec("PRAGMA ignore_check_constraints=ON");
    put(db,"bob","bob-private2",OVER,"2026-11-02","snoozed",null);
    db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.equal(read(db,stage),null);
    assert.ok(inspect(stage).issues.includes("personal_attention_invalid"));
  }
  {
    // Another user's malformed row never affects the actor.
    const {db,stage}=setup();
    db.exec("PRAGMA ignore_check_constraints=ON");
    put(db,"erin","erin-private",OVER,"2026-11-01","bogus",null);
    db.exec("PRAGMA ignore_check_constraints=OFF");
    assert.ok(read(db,stage));
  }
  {
    // Stale shared state whose membership vanished (reconcile + guards bypassed):
    // NULL role must not hide it from preflight (plans checked the same way).
    const {db,stage}=setup();
    put(db,"bob","shared-bob",OVER,"2026-11-01");
    plan(db,"bob","shared-bob","2026-11-01");
    for(const t of ["personal_attention_state_membership_delete","personal_task_plan_membership_delete",
      "member_revocation_guard"])db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
    const issues=inspect(stage).issues;
    assert.ok(issues.includes("personal_attention_invalid"),issues.join());
    assert.ok(issues.includes("personal_plan_invalid"),issues.join());
  }
  {
    // Revision invariants of state rows and epochs are checked by preflight.
    const {db,stage}=setup();
    put(db,"bob","bob-private",OVER,"2026-11-01");
    db.exec("DROP TRIGGER personal_attention_state_revision_guard");
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE personal_attention_states SET revision=-1 WHERE user_id='bob'").run();
    assert.ok(inspect(stage).issues.includes("personal_attention_invalid"));
  }
  {
    const {db,stage}=setup();
    db.exec("DROP TRIGGER personal_attention_epoch_monotonic");
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE personal_attention_epochs SET revision=-3 WHERE user_id='erin'").run();
    assert.ok(inspect(stage).issues.includes("personal_attention_invalid"));
  }
});

test("preflight sees stale plan/state rows of a now-unassigned shared task (NULL-safe assignee)",()=>{
  const {db,stage}=setup();
  put(db,"bob","shared-bob",OVER,"2026-11-01");
  plan(db,"bob","shared-bob","2026-11-01");
  for(const t of ["personal_attention_state_task_reconcile","personal_task_plan_task_reconcile"])
    db.exec(`DROP TRIGGER ${t}`);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  const issues=inspect(stage).issues;
  assert.ok(issues.includes("personal_attention_invalid"),issues.join());
  assert.ok(issues.includes("personal_plan_invalid"),issues.join());
});
