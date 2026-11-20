import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test,after } from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-v27-upgrade-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const prev=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {upgradeTargetStagingInboxV26}=await import("../lib/target-inbox-schema-upgrade.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const sha=filename=>createHash("sha256").update(readFileSync(filename)).digest("hex");

function v26Fixture(name){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,name),ownerUserId:"alice",
  });
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const db=new DatabaseSync(stage.databasePath);
  // Derive exact canonical v26 from the freshly bootstrapped v27 fixture.
  // All new triage SQL is removed BEFORE setting the previous schema version.
  db.exec("PRAGMA foreign_keys=ON; DROP TABLE task_triage_receipts; DROP TRIGGER task_triage_create_guard; DROP TRIGGER task_triage_revision_guard; DROP TRIGGER task_triage_task_revision; DROP INDEX tasks_unprocessed_by_id; ALTER TABLE tasks DROP COLUMN triage_revision; ALTER TABLE tasks DROP COLUMN triaged_at; ALTER TABLE tasks DROP COLUMN triage_state;");
  db.prepare("UPDATE metadata SET value='26' WHERE key='schema_version'").run();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('existing',?,'Historical target task')")
    .run(stage.unassignedAreaId);
  assert.equal(inspectIsolatedTargetStore({...store,mode:"r2-model"}).ok,true,
    "v26 fixture must pass canonical preflight before upgrading");
  assert.deepEqual(inspectIsolatedTargetStore({...store,mode:"r2-model",requiredSchemaVersion:27}).issues,
    ["schema_invalid"],"v26 is upgradable, but must never pass C-3a current-schema --check");
  return {stage,store,db};
}
after(()=>{
  if(prev===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=prev;
  rmSync(root,{recursive:true,force:true});
});

test("explicit v26→v27 migrates exactly once, preserves existing target task and defaults new tasks to Inbox",()=>{
  const {stage,store,db}=v26Fixture("upgrade");
  const generation=stage.restoreGeneration;
  const old=db.prepare("SELECT id,title,status,revision FROM tasks WHERE id='existing'").get();
  const auditBefore=db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n;
  assert.deepEqual(upgradeTargetStagingInboxV26(store),{ok:true,status:"upgraded"});
  const migrated=db.prepare("SELECT id,title,status,triage_state,triaged_at,triage_revision,revision FROM tasks WHERE id='existing'").get();
  assert.deepEqual({id:migrated.id,title:migrated.title,status:migrated.status},{
    id:old.id,title:old.title,status:old.status,
  });
  assert.equal(migrated.triage_state,"processed");
  assert.equal(migrated.triaged_at,null);
  assert.equal(migrated.triage_revision,1);
  assert.ok(migrated.revision>old.revision);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n,auditBefore,
    "migration is not a user Process action");
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value,generation);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"27");
  assert.equal(inspectIsolatedTargetStore({...store,mode:"r2-model"}).ok,true);
  assert.equal(inspectIsolatedTargetStore({...store,mode:"r2-model",requiredSchemaVersion:27}).ok,true);
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('new',?,'Captured')")
    .run(stage.unassignedAreaId);
  assert.deepEqual({...db.prepare(
    "SELECT triage_state,triaged_at,triage_revision FROM tasks WHERE id='new'").get()},
    {triage_state:"unprocessed",triaged_at:null,triage_revision:0});
  const journal=readFileSync(path.join(stage.directory,"lumi-target.journal"),"utf8");
  assert.match(journal,/"k":"schema_upgrade"/);
  assert.match(journal,/"from":26/);
  assert.match(journal,/"to":27/);
  assert.deepEqual(upgradeTargetStagingInboxV26(store),{ok:true,status:"already_current"});
  assert.equal(db.prepare("SELECT triage_state FROM tasks WHERE id='new'").get().triage_state,
    "unprocessed","idempotence must never mark newly captured tasks processed");
  db.close();
});

test("tampered v26 schema and wrong generation fail closed without writing database or journal",()=>{
  const {stage,store,db}=v26Fixture("denied");
  db.exec("DROP TRIGGER task_tombstones_no_update");
  const files=[stage.databasePath,path.join(stage.directory,"lumi-target.journal")];
  const before=files.map(sha);
  assert.equal(upgradeTargetStagingInboxV26(store).ok,false);
  assert.deepEqual(files.map(sha),before);
  assert.equal(upgradeTargetStagingInboxV26({
    ...store,expectedRestoreGeneration:randomUUID(),
  }).ok,false);
  assert.deepEqual(files.map(sha),before);
  db.close();
});

test("failed SQLite commit rolls back schema/version/backfill; explicit retry can succeed",()=>{
  const {stage,store,db}=v26Fixture("failed");
  const exec=DatabaseSync.prototype.exec;let intercepted=false;
  try{
    DatabaseSync.prototype.exec=function(sql,...args){
      if(!intercepted&&sql==="COMMIT"){intercepted=true;throw Error("synthetic COMMIT failure");}
      return exec.call(this,sql,...args);
    };
    assert.deepEqual(upgradeTargetStagingInboxV26(store),{
      ok:false,reason:"write_failed",
    });
  } finally {DatabaseSync.prototype.exec=exec;}
  assert.equal(intercepted,true);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"26");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='task_triage_create_guard'").get().n,0);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='existing'").get().title,"Historical target task");
  assert.deepEqual(upgradeTargetStagingInboxV26(store),{ok:true,status:"upgraded"});
  assert.equal(inspectIsolatedTargetStore({...store,mode:"r2-model"}).ok,true);
  db.close();
});

test("v27 --check detects task triage corruption even if canonical trigger DDL was restored",()=>{
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"corrupt-task-state"),ownerUserId:"alice",
  });
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const db=new DatabaseSync(stage.databasePath);
  try{
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('candidate',?,'Candidate')")
      .run(stage.unassignedAreaId);
    assert.equal(inspectIsolatedTargetStore({...store,mode:"r2-model",requiredSchemaVersion:27}).ok,true);
    const original=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='task_triage_revision_guard'").get().sql;
    assert.ok(original.includes("invalid triage transition"));
    db.exec("DROP TRIGGER task_triage_revision_guard");
    // Simulates an operator who bypassed a transition guard and then put
    // canonical SQL back. DDL-only preflight would miss this invalid row.
    db.prepare("UPDATE tasks SET triage_revision=1 WHERE id='candidate'").run();
    db.exec(original);
    assert.deepEqual(inspectIsolatedTargetStore({
      ...store,mode:"r2-model",requiredSchemaVersion:27,
    }).issues,["schema_invalid"]);
  }finally{db.close();}
});

test("v27 preflight rejects forged processed+NULL with a non-migration triage revision",()=>{
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"corrupt-migration-state"),ownerUserId:"alice",
  });
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const db=new DatabaseSync(stage.databasePath);
  try{
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('candidate',?,'Candidate')")
      .run(stage.unassignedAreaId);
    db.prepare("UPDATE tasks SET triage_state='processed',triaged_at=100,triage_revision=1 WHERE id='candidate'").run();
    db.prepare("UPDATE tasks SET triage_state='unprocessed',triaged_at=NULL,triage_revision=2 WHERE id='candidate'").run();
    db.prepare("UPDATE tasks SET triage_state='processed',triaged_at=200,triage_revision=3 WHERE id='candidate'").run();
    const original=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='task_triage_revision_guard'").get().sql;
    db.exec("DROP TRIGGER task_triage_revision_guard");
    db.prepare("UPDATE tasks SET triaged_at=NULL WHERE id='candidate'").run();
    db.exec(original);
    const check=inspectIsolatedTargetStore({
      ...store,mode:"r2-model",requiredSchemaVersion:27,
    });
    assert.equal(check.ok,false);
    assert.ok(check.issues.includes("schema_invalid"),JSON.stringify(check));
  }finally{db.close();}
});
