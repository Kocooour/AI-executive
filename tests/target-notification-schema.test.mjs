import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5d1-notification-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const original=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STORE_SCHEMA_VERSION,TARGET_SCHEMA_SQL}=
  await import("../lib/target-store-bootstrap.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {targetAttentionDeliveryKey}=await import("../lib/target-attention-push-planner.ts");
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
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(who+"-ws",who);
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
  stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,mode:"r2-model",
});
const OK={ok:true,mode:"r2-model",issues:[]};
const OVER="deadline_overdue",SOON="deadline_soon";
const hex=(c,n)=>c.repeat(n);
const tid=c=>"pt_"+hex(c,32);
const ehash=s=>createHash("sha256").update(s).digest("hex");
const target=(db,who,id,endpoint,at=1000)=>db.prepare(
  "INSERT INTO personal_push_targets(user_id,target_id,endpoint_hash,created_at_ms) VALUES (?,?,?,?)")
  .run(who,id,endpoint,at);
const deliver=(db,who,task,rule=OVER,on="2026-11-01",status="baseline",attempts=0,at=5000,sent=null)=>{
  const key=targetAttentionDeliveryKey(rule,task,on);
  db.prepare(`INSERT INTO personal_attention_deliveries(user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms,sent_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(who,key,task,rule,on,status,attempts,at,sent);
  return key;
};
const settings=(db,who)=>({...db.prepare("SELECT * FROM personal_notification_settings WHERE user_id=?").get(who)});
const nepoch=(db,who)=>db.prepare("SELECT revision AS n FROM personal_notification_epochs WHERE user_id=?").get(who)?.n;
const dcount=(db,who)=>db.prepare("SELECT COUNT(*) AS n FROM personal_attention_deliveries"+(who?" WHERE user_id=?":"")).get(...(who?[who]:[])).n;

test("v23 is fresh-only; every identity gets default-OFF UTC settings and an independent epoch",()=>{
  assert.equal(TARGET_STORE_SCHEMA_VERSION,24);
  assert.ok(TARGET_SCHEMA_SQL.includes("personal_push_target_capacity"));
  const {db,stage}=setup();
  for(const who of ["alice","bob","carol","erin"]){
    assert.deepEqual(settings(db,who),{user_id:who,time_zone:"UTC",attention_push:0,
      quiet_start:"22:00",quiet_end:"08:00",daily_limit:3,paused:0,revision:0});
    assert.equal(nepoch(db,who),0);
  }
  assert.deepEqual(inspect(stage),OK);
  db.prepare("UPDATE metadata SET value='22' WHERE key='schema_version'").run();
  const invalid=inspect(stage);
  assert.equal(invalid.ok,false);
  assert.ok(invalid.issues.includes("metadata_invalid"));
});

test("settings guards: no delete/replace, immutable user, monotonic revision, per-user epoch bumps",()=>{
  const {db,stage}=setup();
  assert.throws(()=>db.prepare("DELETE FROM personal_notification_settings WHERE user_id='bob'").run(),/deletion forbidden/);
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO personal_notification_settings(user_id,time_zone) VALUES ('bob','UTC')").run(),/replacement forbidden/);
  assert.throws(()=>db.prepare("UPDATE personal_notification_settings SET user_id='x' WHERE user_id='bob'").run(),/immutable/);
  assert.throws(()=>db.prepare("UPDATE personal_notification_settings SET revision=9 WHERE user_id='bob'").run(),/increment by one/);
  assert.throws(()=>db.prepare("DELETE FROM personal_notification_epochs WHERE user_id='bob'").run(),/deletion forbidden/);
  assert.throws(()=>db.prepare("UPDATE personal_notification_epochs SET revision=4 WHERE user_id='bob'").run(),/increment by one/);
  db.prepare("UPDATE personal_notification_settings SET attention_push=1,time_zone='Europe/Prague' WHERE user_id='bob'").run();
  assert.equal(settings(db,"bob").revision,1);
  assert.equal(nepoch(db,"bob"),1);
  for(const who of ["alice","carol","erin"]){assert.equal(settings(db,who).revision,0);assert.equal(nepoch(db,who),0);}
  db.prepare("UPDATE personal_notification_settings SET paused=1 WHERE user_id='bob'").run();
  assert.equal(settings(db,"bob").revision,2);
  assert.equal(nepoch(db,"bob"),2);
  // A no-op write changes nothing.
  db.prepare("UPDATE personal_notification_settings SET paused=1 WHERE user_id='bob'").run();
  assert.equal(settings(db,"bob").revision,2);
  assert.deepEqual(inspect(stage),OK);
});

test("settings column invariants: quiet window format, limits, flags, zone length",()=>{
  const {db}=setup();
  const up=(col,v)=>()=>db.prepare(`UPDATE personal_notification_settings SET ${col}=? WHERE user_id='bob'`).run(v);
  const chk=/CHECK constraint failed/;
  for(const bad of ["24:00","7:00","07:60","ab:cd","22:00:00","","2200"]){
    assert.throws(up("quiet_start",bad),chk,bad);assert.throws(up("quiet_end",bad),chk,bad);
  }
  db.prepare("UPDATE personal_notification_settings SET quiet_start='23:59',quiet_end='00:00' WHERE user_id='bob'").run();
  assert.throws(up("daily_limit",-1),chk);assert.throws(up("daily_limit",11),chk);assert.throws(up("daily_limit",1.5),chk);
  up("daily_limit",0)();up("daily_limit",10)();
  assert.throws(up("attention_push",2),chk);assert.throws(up("paused",2),chk);
  assert.throws(up("time_zone",""),chk);assert.throws(up("time_zone","x".repeat(65)),chk);
});

test("push targets: one endpoint, one identity; format, revoke-once, no delete, capacities, epoch",()=>{
  const {db,stage}=setup();
  const e1=ehash("https://push.example/1");
  target(db,"bob",tid("a"),e1);
  assert.equal(nepoch(db,"bob"),1);assert.equal(nepoch(db,"carol"),0);
  assert.throws(()=>target(db,"carol",tid("b"),e1),/must be new and unrevoked/);
  assert.throws(()=>target(db,"bob",tid("b"),e1),/must be new and unrevoked/);
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO personal_push_targets(user_id,target_id,endpoint_hash,created_at_ms) VALUES ('carol',?,?,5)").run(tid("c"),e1),/must be new and unrevoked/);
  assert.throws(()=>target(db,"bob",tid("a"),ehash("other")),/must be new and unrevoked/);
  const chk=/CHECK constraint failed/;
  assert.throws(()=>target(db,"bob","pt_short",ehash("z")),chk);
  assert.throws(()=>target(db,"bob","xx_"+hex("a",32),ehash("z")),chk);
  assert.throws(()=>target(db,"bob","pt_"+hex("A",32),ehash("z")),chk);
  assert.throws(()=>target(db,"bob",tid("d"),"abc"),chk);
  assert.throws(()=>target(db,"bob",tid("d"),hex("G",64)),chk);
  assert.throws(()=>target(db,"ghost",tid("d"),ehash("g")),/FOREIGN KEY/);
  assert.throws(()=>db.prepare("INSERT INTO personal_push_targets(user_id,target_id,endpoint_hash,created_at_ms,revoked_at_ms) VALUES ('bob',?,?,5,9)").run(tid("d"),ehash("rv")),/must be new and unrevoked/);
  // Revoke once, nothing else mutable, no delete.
  assert.throws(()=>db.prepare("UPDATE personal_push_targets SET endpoint_hash=? WHERE target_id=?").run(ehash("q"),tid("a")),/revoked once/);
  assert.throws(()=>db.prepare("UPDATE personal_push_targets SET user_id='carol' WHERE target_id=?").run(tid("a")),/revoked once/);
  assert.throws(()=>db.prepare("UPDATE personal_push_targets SET revoked_at_ms=NULL WHERE target_id=?").run(tid("a")),/revoked once/);
  db.prepare("UPDATE personal_push_targets SET revoked_at_ms=2000 WHERE target_id=?").run(tid("a"));
  assert.equal(nepoch(db,"bob"),2);
  assert.throws(()=>db.prepare("UPDATE personal_push_targets SET revoked_at_ms=3000 WHERE target_id=?").run(tid("a")),/revoked once/);
  assert.throws(()=>db.prepare("DELETE FROM personal_push_targets WHERE target_id=?").run(tid("a")),/deletion forbidden/);
  // A revoked endpoint hash can not be re-registered under another identity either.
  assert.throws(()=>target(db,"carol",tid("e"),e1),/must be new and unrevoked/);
  assert.deepEqual(inspect(stage),OK);
});

test("push target capacities: 64 per user (revoked count), 4096 total",()=>{
  const {db,stage}=setup();
  const hexid=n=>"pt_"+n.toString(16).padStart(32,"0");
  for(let i=0;i<64;i++)target(db,"bob",hexid(i),ehash("b"+i));
  assert.throws(()=>target(db,"bob",hexid(1000),ehash("b-extra")),/capacity reached/);
  db.prepare("UPDATE personal_push_targets SET revoked_at_ms=5000 WHERE target_id=?").run(hexid(0));
  assert.throws(()=>target(db,"bob",hexid(1001),ehash("b-extra2")),/capacity reached/,"revoked rows keep counting");
  target(db,"carol",hexid(2000),ehash("c0"));
  // Fill to the global cap using raw rows bypassing the per-user guard order.
  db.exec("BEGIN");
  db.exec("DROP TRIGGER personal_push_target_capacity");
  for(let i=0;i<4096-65;i++)target(db,"erin",hexid(10_000+i),ehash("e"+i));
  db.exec(`CREATE TRIGGER personal_push_target_capacity BEFORE INSERT ON personal_push_targets
    WHEN (SELECT COUNT(*) FROM personal_push_targets WHERE user_id=NEW.user_id) >= 64
      OR (SELECT COUNT(*) FROM personal_push_targets) >= 4096
    BEGIN SELECT RAISE(ABORT,'push target capacity reached'); END`);
  db.exec("COMMIT");
  assert.throws(()=>target(db,"alice",hexid(99999),ehash("a-last")),/capacity reached/);
  assert.equal(inspect(stage).ok,false,"erin exceeds 64 per user in preflight");
});

test("deliveries guard: only a task the user can currently act on, exact occurrence",()=>{
  const {db,stage}=setup();
  const guard=/attention delivery requires eligible task occurrence/;
  for(const [who,task] of [
    ["alice","bob-private"],["bob","alice-private"],["carol","bob-private"],
    ["bob","shared-alice"],["carol","shared-bob"],["carol","shared-free"],
    ["bob","shared-free"],["alice","shared-free"],["erin","shared-bob"],["erin","missing-task"],
  ]) assert.throws(()=>deliver(db,who,task),guard,who+"/"+task);
  assert.throws(()=>deliver(db,"bob","bob-private",OVER,"2026-11-02"),guard,"wrong occurrence");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='erin-private'").run();
  assert.throws(()=>deliver(db,"erin","erin-private"),guard,"completed");
  const chk=/CHECK constraint failed/;
  assert.throws(()=>db.prepare("INSERT INTO personal_attention_deliveries(user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms) VALUES ('bob',?,'bob-private','planned_date_passed','2026-11-01','baseline',0,5)").run("tad1:"+hex("1",64)),chk);
  assert.throws(()=>deliver(db,"bob","bob-private",OVER,"2026-11-01","bogus"),chk);
  assert.throws(()=>deliver(db,"bob","bob-private",OVER,"2026-11-01","baseline",4),chk);
  assert.throws(()=>deliver(db,"bob","bob-private",OVER,"2026-11-01","sent",1,5000,null),chk,"sent needs sent_at");
  assert.throws(()=>deliver(db,"bob","bob-private",OVER,"2026-11-01","pending",1,5000,5000),chk,"pending has no sent_at");
  assert.throws(()=>db.prepare("INSERT INTO personal_attention_deliveries(user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms) VALUES ('bob','tad1:short','bob-private','deadline_overdue','2026-11-01','baseline',0,5)").run(),chk);
  assert.equal(dcount(db),0);
  deliver(db,"bob","bob-private");
  deliver(db,"bob","bob-private",SOON);
  deliver(db,"bob","shared-bob");
  deliver(db,"bob","shared-child");
  deliver(db,"alice","shared-alice");
  deliver(db,"alice","alice-private");
  assert.throws(()=>deliver(db,"bob","bob-private"),guard,"no replace");
  assert.equal(dcount(db),6);
  assert.deepEqual(inspect(stage),OK);
});

test("delivery and device-row transitions are guarded; device rows only for own targets",()=>{
  const {db,stage}=setup();
  target(db,"bob",tid("a"),ehash("b1"));target(db,"carol",tid("b"),ehash("c1"));
  const key=deliver(db,"bob","bob-private",OVER,"2026-11-01","pending",1,5000);
  const dev=(who,k,t,status="failed",attempts=1,at=6000)=>db.prepare(
    "INSERT INTO personal_attention_device_deliveries(user_id,delivery_key,target_id,status,attempts,last_attempt_at_ms) VALUES (?,?,?,?,?,?)")
    .run(who,k,t,status,attempts,at);
  const guard=/requires own delivery and live target/;
  assert.throws(()=>dev("bob",key,tid("b")),guard,"another user's target");
  assert.throws(()=>dev("carol",key,tid("b")),guard,"another user's delivery");
  assert.throws(()=>dev("bob",key,tid("z")),guard,"unknown target");
  assert.throws(()=>dev("bob",key,tid("a"),"sent",0),/CHECK constraint failed/);
  dev("bob",key,tid("a"));
  assert.throws(()=>dev("bob",key,tid("a")),guard,"no replace");
  db.prepare("UPDATE personal_attention_device_deliveries SET status='sent',attempts=2,last_attempt_at_ms=7000").run();
  assert.throws(()=>db.prepare("UPDATE personal_attention_device_deliveries SET status='failed'").run(),/transition invalid/,"sent is terminal");
  assert.throws(()=>db.prepare("UPDATE personal_attention_device_deliveries SET target_id=?").run(tid("b")),/transition invalid/);
  db.prepare("UPDATE personal_attention_deliveries SET status='partial',attempts=2,last_attempt_at_ms=7000,sent_at_ms=7000 WHERE delivery_key=?").run(key);
  db.prepare("UPDATE personal_attention_deliveries SET status='sent' WHERE delivery_key=?").run(key);
  assert.throws(()=>db.prepare("UPDATE personal_attention_deliveries SET status='failed',sent_at_ms=NULL WHERE delivery_key=?").run(key),/transition invalid/,"sent is terminal");
  assert.throws(()=>db.prepare("UPDATE personal_attention_deliveries SET user_id='carol' WHERE delivery_key=?").run(key),/transition invalid/);
  assert.throws(()=>db.prepare("UPDATE personal_attention_deliveries SET task_id='shared-bob' WHERE delivery_key=?").run(key),/transition invalid/);
  assert.deepEqual(inspect(stage),OK);
  // Deleting the delivery drops its device rows.
  db.prepare("DELETE FROM personal_attention_deliveries WHERE delivery_key=?").run(key);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_attention_device_deliveries").get().n,0);
});

test("reconcile deletes deliveries on access loss/completion, only for the affected user",()=>{
  // unassign
  {
    const {db}=setup();
    deliver(db,"bob","shared-bob");deliver(db,"alice","shared-alice");
    db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
    assert.equal(dcount(db,"bob"),0);assert.equal(dcount(db,"alice"),1);
  }
  // reassign bob -> alice: bob loses, alice's unrelated rows stay
  {
    const {db}=setup();
    deliver(db,"bob","shared-bob");deliver(db,"alice","alice-private");
    db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='shared-bob'").run();
    assert.equal(dcount(db,"bob"),0);assert.equal(dcount(db,"alice"),1);
  }
  // membership downgrade and removal
  {
    const {db}=setup();
    deliver(db,"bob","shared-bob");deliver(db,"bob","shared-child");deliver(db,"bob","bob-private");
    db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
    db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
    assert.deepEqual(db.prepare("SELECT task_id FROM personal_attention_deliveries").all().map(r=>r.task_id),["bob-private"]);
  }
  {
    const {db}=setup();
    deliver(db,"bob","shared-bob");deliver(db,"bob","shared-child");deliver(db,"bob","bob-private");
    db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
    db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
    assert.deepEqual(db.prepare("SELECT task_id FROM personal_attention_deliveries").all().map(r=>r.task_id),["bob-private"]);
  }
  // completion, due change, task delete, project move
  {
    const {db,stage}=setup();
    deliver(db,"bob","bob-private");deliver(db,"bob","bob-private",SOON);deliver(db,"alice","alice-private");
    db.prepare("UPDATE tasks SET due_on='2026-11-09' WHERE id='bob-private'").run();
    assert.equal(dcount(db,"bob"),0,"new due date = new occurrence");
    deliver(db,"bob","bob-private",OVER,"2026-11-09");
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793900000000 WHERE id='bob-private'").run();
    assert.equal(dcount(db,"bob"),0);assert.equal(dcount(db,"alice"),1);
    assert.deepEqual(inspect(stage),OK);
  }
});

test("preflight: valid ok; tampering is personal_notification_invalid",()=>{
  const cases={
    "missing settings"(db){db.exec("DROP TRIGGER personal_notification_settings_no_delete");db.prepare("DELETE FROM personal_notification_settings WHERE user_id='carol'").run();},
    "missing epoch"(db){db.exec("DROP TRIGGER personal_notification_epoch_no_delete");db.prepare("DELETE FROM personal_notification_epochs WHERE user_id='carol'").run();},
    "bad zone"(db){db.prepare("UPDATE personal_notification_settings SET time_zone='Not/AZone' WHERE user_id='bob'").run();},
    "bad quiet"(db){db.exec("PRAGMA ignore_check_constraints=ON");db.prepare("UPDATE personal_notification_settings SET quiet_start='99:99' WHERE user_id='bob'").run();},
    "bad limit"(db){db.exec("PRAGMA ignore_check_constraints=ON");db.prepare("UPDATE personal_notification_settings SET daily_limit=99 WHERE user_id='bob'").run();},
    "bad target id"(db){db.exec("PRAGMA ignore_check_constraints=ON");target(db,"bob","pt_BAD",ehash("y"));},
    "delivery for lost access"(db){deliver(db,"bob","shared-bob");db.exec("DROP TRIGGER personal_attention_delivery_task_reconcile");db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();},
    "foreign task delivery"(db){db.exec("DROP TRIGGER personal_attention_delivery_insert_guard");deliver(db,"bob","erin-private");},
    "forged key"(db){db.exec("DROP TRIGGER personal_attention_delivery_insert_guard");db.prepare("INSERT INTO personal_attention_deliveries(user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms) VALUES ('bob',?,'bob-private','deadline_overdue','2026-11-01','baseline',0,5)").run("tad1:"+hex("0",64));},
    "device row foreign target"(db){target(db,"carol",tid("c"),ehash("cc"));const k=deliver(db,"bob","bob-private");db.exec("PRAGMA foreign_keys=OFF");db.exec("DROP TRIGGER personal_attention_device_insert_guard");db.prepare("INSERT INTO personal_attention_device_deliveries(user_id,delivery_key,target_id,status,attempts,last_attempt_at_ms) VALUES ('bob',?,?,'failed',1,5)").run(k,tid("c"));},
  };
  for(const [name,tamper] of Object.entries(cases)){
    const {db,stage}=setup();
    assert.deepEqual(inspect(stage),OK,name+" baseline");
    tamper(db);
    const result=inspect(stage);
    assert.equal(result.ok,false,name);
    assert.ok(result.issues.includes("personal_notification_invalid"),name+" "+JSON.stringify(result));
  }
});

test("review fixes: delivery history cannot be rewritten; device rows need a live own target; target ids are global",()=>{
  const {db,stage}=setup();
  const upd=(key,sql,...args)=>db.prepare(`UPDATE personal_attention_deliveries SET ${sql} WHERE user_id='bob' AND delivery_key=?`).run(...args,key);
  // partial cannot fall back to pending, and sent_at is write-once.
  const k=deliver(db,"bob","bob-private",OVER,"2026-11-01","pending",1,5000);
  upd(k,"status='partial',sent_at_ms=7000,attempts=1,last_attempt_at_ms=7000");
  assert.throws(()=>upd(k,"status='pending',sent_at_ms=NULL"),/transition invalid/);
  assert.throws(()=>upd(k,"status='failed'"),/transition invalid/);
  assert.throws(()=>upd(k,"sent_at_ms=99999"),/transition invalid/);
  upd(k,"status='sent',attempts=2,last_attempt_at_ms=8000");
  // pending cannot become baseline (would silently suppress a due push).
  const k2=deliver(db,"bob","shared-bob",OVER,"2026-11-01","pending",1,5000);
  assert.throws(()=>upd(k2,"status='baseline'"),/transition invalid/);
  // Device rows only for the user's own, unrevoked target.
  target(db,"bob",tid("a"),ehash("bob-phone"));
  target(db,"bob",tid("b"),ehash("bob-old"));
  db.prepare("UPDATE personal_push_targets SET revoked_at_ms=2000 WHERE user_id='bob' AND target_id=?").run(tid("b"));
  const dev=(t)=>db.prepare("INSERT INTO personal_attention_device_deliveries(user_id,delivery_key,target_id,status,attempts,last_attempt_at_ms) VALUES ('bob',?,?,'failed',1,6000)").run(k2,t);
  assert.throws(()=>dev(tid("b")),/live target/);
  dev(tid("a"));
  // The same opaque target id can never exist for two users.
  assert.throws(()=>target(db,"carol",tid("a"),ehash("carol-phone")),/new and unrevoked|UNIQUE/);
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO personal_push_targets(user_id,target_id,endpoint_hash,created_at_ms) VALUES ('carol',?,?,1000)")
    .run(tid("a"),ehash("carol-phone")),/new and unrevoked|UNIQUE/);
  assert.equal(db.prepare("SELECT user_id FROM personal_push_targets WHERE target_id=?").get(tid("a")).user_id,"bob");
  assert.deepEqual(inspect(stage),OK);
});
