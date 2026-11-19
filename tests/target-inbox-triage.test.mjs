import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {readTargetInboxPage} from "../lib/target-inbox-read-model.ts";
import {transitionTargetInboxTriageInTransaction} from "../lib/target-inbox-triage-writer.ts";
import {
  TARGET_SCHEMA_V26_SQL,TARGET_SCHEMA_SQL,TARGET_STORE_SCHEMA_VERSION,
} from "../lib/target-store-bootstrap.ts";
import {
  TARGET_INBOX_TRIAGE_SCHEMA_VERSION,inboxMembership,
  migrateTargetInboxTriageInTransaction,
} from "../lib/target-inbox-triage.ts";

function fixture(schema, version){
  const db=new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(schema);
  db.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?)").run(String(version));
  db.prepare("INSERT INTO metadata(key,value) VALUES('restore_generation',?)")
    .run("11111111-1111-4111-8111-111111111111");
  db.prepare("INSERT INTO identities(id) VALUES('owner')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('personal','personal','owner')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('a','Private','private','personal','owner')").run();
  const insert=(id)=>db.prepare("INSERT INTO tasks(id,area_id,title) VALUES(?,'a','Test task')").run(id);
  return {db,insert};
}
const triage=(db,id)=>({...db.prepare(
  "SELECT triage_state,triaged_at_ms,triage_revision FROM task_triage WHERE task_id=?"
).get(id)});

test("C-3a: v27 fresh tasks are unprocessed regardless of their completion",()=>{
  assert.equal(TARGET_STORE_SCHEMA_VERSION,TARGET_INBOX_TRIAGE_SCHEMA_VERSION);
  const {db,insert}=fixture(TARGET_SCHEMA_SQL,27);
  try{
    insert("new");
    assert.deepEqual(triage(db,"new"),
      {triage_state:"unprocessed",triaged_at_ms:null,triage_revision:0});
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=123 WHERE id='new'").run();
    assert.deepEqual(triage(db,"new"),
      {triage_state:"unprocessed",triaged_at_ms:null,triage_revision:0});
    db.prepare("UPDATE task_triage SET triage_state='processed',triaged_at_ms=456 WHERE task_id='new'").run();
    assert.deepEqual(triage(db,"new"),
      {triage_state:"processed",triaged_at_ms:456,triage_revision:1});
    db.prepare("UPDATE task_triage SET triage_state='unprocessed',triaged_at_ms=NULL WHERE task_id='new'").run();
    assert.deepEqual(triage(db,"new"),
      {triage_state:"unprocessed",triaged_at_ms:null,triage_revision:2});
    assert.throws(()=>db.prepare("DELETE FROM task_triage WHERE task_id='new'").run());
  } finally{db.close();}
});

test("C-3a: explicit v26 migration marks existing tasks processed without fabricated timestamps",()=>{
  const {db,insert}=fixture(TARGET_SCHEMA_V26_SQL,26);
  try {
    insert("existing");
    assert.throws(()=>migrateTargetInboxTriageInTransaction(db),/BEGIN IMMEDIATE/);
    db.exec("BEGIN IMMEDIATE");
    try {
      assert.equal(migrateTargetInboxTriageInTransaction(db),"applied");
      db.exec("COMMIT");
    }catch(err){db.exec("ROLLBACK");throw err;}
    assert.deepEqual(triage(db,"existing"),
      {triage_state:"processed",triaged_at_ms:null,triage_revision:0});
    insert("fresh");
    assert.deepEqual(triage(db,"fresh"),
      {triage_state:"unprocessed",triaged_at_ms:null,triage_revision:0});
    db.exec("BEGIN IMMEDIATE");
    assert.equal(migrateTargetInboxTriageInTransaction(db),"already_applied");
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,"27");
  } finally{db.close();}
});

test("C-3a: membership is independent of completion but requires ACL and a live row",()=>{
  const base={authorized:true,exists:true,tombstoned:false,triageState:"unprocessed",completion:"open"};
  assert.equal(inboxMembership(base),true);
  assert.equal(inboxMembership({...base,completion:"completed"}),true);
  assert.equal(inboxMembership({...base,triageState:"processed"}),false);
  assert.equal(inboxMembership({...base,authorized:false}),false);
  assert.equal(inboxMembership({...base,tombstoned:true}),false);
  assert.equal(inboxMembership({...base,exists:false}),false);
});

test("C-3a: private Inbox read model counts completed tasks but never other owners",()=>{
  const {db,insert}=fixture(TARGET_SCHEMA_SQL,27);
  try{
    insert("unprocessed");
    insert("completed");
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=123 WHERE id='completed'").run();
    const page=readTargetInboxPage(db,"owner",1);
    assert.equal(page.count,2);
    assert.equal(page.tasks.length,1);
    assert.equal(page.hasMore,true);
    const second=readTargetInboxPage(db,"owner",1,page.afterTaskId);
    assert.equal(second.count,2);
    assert.equal(second.tasks.length,1);
    assert.equal(second.hasMore,false);
    assert.deepEqual([...page.tasks,...second.tasks].map(t=>t.completion),["completed","open"]);
    assert.deepEqual(readTargetInboxPage(db,"outsider"),{
      tasks:[],count:0,hasMore:false,afterTaskId:null,
    });
  }finally{db.close();}
});

test("C-3a: Process/Undo is actor-scoped, CAS and idempotent with no completion side effect",()=>{
  const {db,insert}=fixture(TARGET_SCHEMA_SQL,27);
  const generation="11111111-1111-4111-8111-111111111111";
  const c1="22222222-2222-4222-8222-222222222222";
  const c2="33333333-3333-4333-8333-333333333333";
  try{
    insert("item");
    const process={action:"process",taskId:"item",commandId:c1,expectedRevision:0,restoreGeneration:generation};
    db.exec("BEGIN IMMEDIATE");
    const first=transitionTargetInboxTriageInTransaction(db,"owner",process,12345);
    assert.deepEqual(first,{ok:true,replayed:false,revision:1,state:"processed"});
    db.exec("COMMIT");
    assert.equal(readTargetInboxPage(db,"owner").count,0);
    db.exec("BEGIN IMMEDIATE");
    const replay=transitionTargetInboxTriageInTransaction(db,"owner",process,12346);
    assert.deepEqual(replay,{ok:true,replayed:true,revision:1,state:"processed"});
    assert.equal(transitionTargetInboxTriageInTransaction(db,"owner",{...process,expectedRevision:1},12346).ok,false);
    db.exec("COMMIT");
    const undo={action:"undo",taskId:"item",commandId:c2,expectedRevision:1,
      restoreGeneration:generation,undoOfCommandId:c1};
    db.exec("BEGIN IMMEDIATE");
    const result=transitionTargetInboxTriageInTransaction(db,"owner",undo,12347);
    assert.deepEqual(result,{ok:true,replayed:false,revision:2,state:"unprocessed"});
    db.exec("COMMIT");
    assert.deepEqual(triage(db,"item"),
      {triage_state:"unprocessed",triaged_at_ms:null,triage_revision:2});
    assert.equal(readTargetInboxPage(db,"owner").count,1);
    db.exec("BEGIN IMMEDIATE");
    assert.deepEqual(transitionTargetInboxTriageInTransaction(db,"owner",undo,12347),
      {ok:true,replayed:true,revision:2,state:"unprocessed"});
    assert.equal(transitionTargetInboxTriageInTransaction(db,"outsider",process,12347).ok,false);
    assert.equal(transitionTargetInboxTriageInTransaction(db,"owner",process,12347).ok,true,
      "same receipt is idempotent, not a second mutation");
    db.exec("COMMIT");
  }finally{db.close();}
});
