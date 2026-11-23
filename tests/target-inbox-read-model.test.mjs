import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-inbox-read-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const previous=process.env.AI_EXECUTIVE_DATA_DIR;
const previousSecret=process.env.AI_EXECUTIVE_SESSION_SECRET;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SESSION_SECRET="test-c3a-read-model-signing-secret-32-bytes-minimum";
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TARGET_INBOX_BACKFILL_SQL}=await import("../lib/target-inbox-schema.ts");
const {readAuthorizedTargetInboxPage}=
  await import("../lib/target-inbox-read-model.ts");
const stage=bootstrapIsolatedTargetStore({
  stagingDirectory:path.join(root,"stage"),ownerUserId:"alice",
});
const db=new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON");
const insert=db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
insert.run("old",stage.unassignedAreaId,"Preexisting target task");
// This fixture is fresh v27. Only a genuine v26→v27 migration may produce
// processed + NULL timestamp (covered separately by schema-upgrade tests).
db.prepare("UPDATE tasks SET triage_state='processed',triaged_at=200,triage_revision=triage_revision+1 WHERE id='old'").run();
for(const actor of ["bob","cara"]){
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(actor,actor);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
    .run("private:"+actor,actor,actor,actor);
}
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
for(const [actor,role] of [["alice","admin"],["bob","editor"],["cara","viewer"]])
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)")
    .run(actor,role);
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('team-project','team-area','Shared')").run();
for(const [id,areaId] of [
  ["a-private",stage.unassignedAreaId],
  ["b-private","private:bob"],
  ["shared-visible","team-area"],
]) insert.run(id,areaId,id);
db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('shared-child','team-project','Project task')").run();
db.prepare("UPDATE tasks SET status='completed',completed_at_ms=100 WHERE id='a-private'").run();
const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
const page=(actor,extra={})=>readAuthorizedTargetInboxPage(reader,{actorUserId:actor,...extra});
const ids=result=>result?.items.map(x=>x.id);
after(()=>{
  reader.close();db.close();
  if(previous===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=previous;
  if(previousSecret===undefined)delete process.env.AI_EXECUTIVE_SESSION_SECRET;
  else process.env.AI_EXECUTIVE_SESSION_SECRET=previousSecret;
  rmSync(root,{recursive:true,force:true});
});

test("previously processed target tasks stay excluded while later tasks enter Inbox",()=>{
  const historical=db.prepare("SELECT triage_state,triaged_at,triage_revision FROM tasks WHERE id='old'").get();
  assert.deepEqual({...historical},{triage_state:"processed",triaged_at:200,triage_revision:1});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE triage_state='unprocessed'").get().n,4);
  db.exec(TARGET_INBOX_BACKFILL_SQL);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE triage_state='unprocessed'").get().n,4,
    "repeated backfill after version advance must not absorb later tasks");
  assert.deepEqual(ids(page("alice")),["a-private","shared-child","shared-visible"],
    "completed but unprocessed remains until explicit Process");
  assert.equal(page("alice").count,3);
  assert.equal(page("alice").items.find(x=>x.id==="a-private").status,"completed",
    "completion must remain visible and distinguishable for the Inbox UI");
  assert.equal(page("alice").items.find(x=>x.id==="shared-child").status,"open");
  db.prepare("UPDATE tasks SET status='open',completed_at_ms=NULL WHERE id='a-private'").run();
  assert.equal(page("alice").items.find(x=>x.id==="a-private").status,"open");
  assert.equal(page("alice").count,3,"reopening does not process the task");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=200 WHERE id='a-private'").run();
  assert.equal(page("alice").count,3,"completing does not process the task");
});

test("actor scoped count, shared inherited Area and read-only viewer semantics",()=>{
  assert.deepEqual(ids(page("bob")),["b-private","shared-child","shared-visible"]);
  assert.equal(page("bob").count,3);
  assert.deepEqual(ids(page("cara")),["shared-child","shared-visible"]);
  assert.equal(page("cara").count,2);
  assert.ok(page("cara").items.every(row=>row.canProcess===false));
  assert.equal(page("alice").items.find(row=>row.id==="shared-child").effectiveAreaId,"team-area");
  assert.ok(page("bob").items.every(row=>row.canProcess));
  assert.deepEqual(ids(page("not-a-user")),[]);
  assert.equal(page("not-a-user").count,0);
});

test("stable keyset pages and whole-actor count",()=>{
  const first=page("alice",{limit:1});
  assert.deepEqual(ids(first),["a-private"]);
  assert.equal(first.count,3);
  const second=page("alice",{limit:1,afterTaskId:first.nextCursor});
  assert.deepEqual(ids(second),["shared-child"]);
  assert.equal(second.count,3);
  const last=page("alice",{limit:1,afterTaskId:second.nextCursor});
  assert.deepEqual(ids(last),["shared-visible"]);
  assert.equal(last.nextCursor,null);
  assert.equal(last.count,3);
});

test("invalid request and missing schema fail closed without content",()=>{
  for(const request of [
    {actorUserId:" "},{actorUserId:"alice",limit:0},
    {actorUserId:"alice",limit:101},{actorUserId:"alice",afterTaskId:"bad\nid"},
  ])assert.equal(readAuthorizedTargetInboxPage(reader,request),null);
  const empty=new DatabaseSync(":memory:");
  try{assert.equal(readAuthorizedTargetInboxPage(empty,{actorUserId:"alice"}),null);}
  finally{empty.close();}
});

test("revocation removes all shared titles and counts without hiding authorized private rows",()=>{
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='cara'").run();
  assert.deepEqual(ids(page("cara")),[]);
  assert.equal(page("cara").count,0);
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(ids(page("bob")),["b-private"]);
  assert.equal(page("bob").count,1);
  assert.equal(page("alice").count,3);
});

test("triage trigger prevents bypassing independent state and revision",()=>{
  assert.throws(()=>db.prepare("INSERT INTO tasks(id,area_id,title,triage_state) VALUES ('bad',?,'bad','processed')")
    .run(stage.unassignedAreaId));
  assert.throws(()=>db.prepare("UPDATE tasks SET triage_state='processed' WHERE id='a-private'").run());
  assert.throws(()=>db.prepare("UPDATE tasks SET triage_state='processed',triaged_at=NULL,triage_revision=triage_revision+1 WHERE id='a-private'").run(),
    "post-upgrade writes cannot forge a processed-without-timestamp migration");
  db.prepare("UPDATE tasks SET triage_state='processed',triage_revision=triage_revision+1,triaged_at=200 WHERE id='a-private'").run();
  assert.equal(page("alice").count,2);
  assert.throws(()=>db.prepare("UPDATE tasks SET triage_state='unprocessed',triage_revision=triage_revision+1 WHERE id='a-private'").run(),
    "undo must clear the processed timestamp");
  db.prepare("UPDATE tasks SET triage_state='unprocessed',triage_revision=triage_revision+1,triaged_at=NULL WHERE id='a-private'").run();
  assert.equal(page("alice").count,3);
});


test("C-3b P2: only editable open PRIVATE Inbox rows can load suggestions",()=>{
  const alice=page("alice");
  const bob=page("bob");
  assert.equal(alice.items.find(r=>r.id==="a-private").canSuggest,false,
    "completed private task must not invoke C-3b");
  assert.equal(bob.items.find(r=>r.id==="b-private").canSuggest,true);
  for(const actor of ["alice","bob","cara"]){
    const result=page(actor);
    for(const row of result.items.filter(r=>r.effectiveAreaId==="team-area")){
      assert.equal(row.canSuggest,false,
        "shared editor/viewer must never cause a private-only AI preview");
    }
  }
  db.prepare("UPDATE tasks SET status='open',completed_at_ms=NULL WHERE id='a-private'").run();
  assert.equal(page("alice").items.find(r=>r.id==="a-private").canSuggest,true);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=200 WHERE id='a-private'").run();
});
