import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3k2-private-read-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedPersonalWhenPage}=await import("../lib/target-personal-when-read-model.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {verifyTargetStagingReadLive,issueDurableTargetStagingSession,
  hashTargetStagingSessionToken}=await import("../lib/target-staging-durable-session.ts");
let serial=0;const fixtures=[];
function setup(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice"});
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
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
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Family')").run();
  const add=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["alice-private",stage.unassignedAreaId,null,"Private Alice",null,"2026-10-01"],
    ["bob-private","bob-private",null,"Private Bob",null,"2026-11-04"],
    ["erin-private","erin-private",null,"Private Erin",null,"2026-11-04"],
    ["shared-bob","family-area",null,"Shared Bob","bob","2026-10-01"],
    ["shared-alice","family-area",null,"Shared Alice","alice",null],
    ["shared-free","family-area",null,"Shared unassigned",null,null],
    ["project-child",null,"project","Inherited Bob","bob","2026-12-01"],
  ])add.run(...row);
  const put=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["alice","alice-private","2026-11-04"],
    ["alice","shared-alice","2026-11-07"],
    ["bob","bob-private","2026-11-04"],
    ["bob","shared-bob","2026-11-05"],
    ["bob","project-child","2026-11-07"],
    ["erin","erin-private","2026-11-04"],
  ])put.run(...row);
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const fx={db,reader,authority,stage,store};fixtures.push(fx);return fx;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(old===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=old;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const ids=page=>page.plans.map(p=>p.taskId);
function page(f,who="bob",window="all",extra={}){
  return readAuthorizedPersonalWhenPage(f.reader,{
    actorUserId:who,window,evaluationDate:window==="all"?null:"2026-11-04",
    throughDate:window==="upcoming"?"2026-11-10":null,
    limit:100,offset:0,restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}

test("private when filters SQL first, chronological order and actor isolation",()=>{
  const f=setup();
  assert.deepEqual(ids(page(f)),["bob-private","shared-bob","project-child"]);
  assert.deepEqual(ids(page(f,"bob","on-day")),["bob-private"]);
  assert.deepEqual(ids(page(f,"bob","upcoming")),["shared-bob","project-child"]);
  assert.deepEqual(ids(page(f,"alice","all")),["alice-private","shared-alice"]);
  assert.deepEqual(ids(page(f,"carol","all")),[]);
  assert.deepEqual(ids(page(f,"erin","all")),["erin-private"]);
  assert.equal(page(f,"unknown","all"),null);
  for(const row of page(f).plans){
    assert.deepEqual(Object.keys(row).sort(),["revision","taskId","whenOn"]);
    assert.equal("dueOn" in row,false);
    assert.equal("title" in row,false);
    assert.equal("userId" in row,false);
  }
  assert.ok(!JSON.stringify(page(f)).includes("erin-private"));
  assert.ok(!JSON.stringify(page(f)).includes("shared-alice"));
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
    mode:"r2-model"}),{ok:true,mode:"r2-model",issues:[]});
});

test("bounded filter contract and pagination revision binds private window",()=>{
  const f=setup();
  const first=page(f,"bob","all",{limit:1});
  const next=page(f,"bob","all",{limit:1,offset:1});
  assert.deepEqual(ids(first),["bob-private"]);
  assert.deepEqual(ids(next),["shared-bob"]);
  assert.equal(first.hasMore,true);
  assert.equal(next.hasMore,true);
  assert.equal(first.revision,next.revision);
  assert.notEqual(first.revision,page(f,"alice").revision);
  assert.notEqual(first.revision,page(f,"bob","on-day").revision);
  assert.notEqual(page(f,"bob","upcoming").revision,
    page(f,"bob","upcoming",{throughDate:"2026-11-11"}).revision);
  for(const bad of [
    {window:"today"},{window:"on-day",evaluationDate:null},
    {window:"all",evaluationDate:"2026-11-04"},
    {window:"upcoming",throughDate:null},{window:"upcoming",throughDate:"2026-11-04"},
    {window:"upcoming",throughDate:"2027-11-04"},
    {window:"on-day",evaluationDate:"2026-02-29"},
    {window:"on-day",evaluationDate:"2026-11-04T00:00:00Z"},
    {limit:0},{limit:101},{offset:-1},{offset:1_000_001},
    {restoreGeneration:"bad"},{actorUserId:"bob and alice"},
  ]) assert.equal(page(f,"bob","all",bad),null,JSON.stringify(bad));
});

test("only an authenticated pinned read facade may select private planning",()=>{
  const f=setup();
  const result=f.authority.readPersonalWhenPage("bob","on-day","2026-11-04",null,100,0);
  assert.deepEqual(ids(result),["bob-private"]);
  assert.deepEqual(ids(f.authority.readPersonalWhenPage("alice","all",null,null,100,0)),
    ["alice-private","shared-alice"]);
  assert.deepEqual(ids(f.authority.readPersonalWhenPage("carol","all",null,null,100,0)),[]);
  assert.equal(f.authority.readPersonalWhenPage("not an actor","all",null,null,100,0),null);
  assert.equal(f.authority.readPersonalWhenPage("bob","upcoming","2026-11-04",null,100,0),null);
});

test("private epoch changes invalidate only actor cursor and live release",()=>{
  const f=setup();
  const owner=page(f,"alice");
  const bob=page(f);
  const check=(who,pg,tokenHash)=>verifyTargetStagingReadLive(f.store,
    tokenHash?{tokenHash}:{ownerUserId:who},pg.linearization,Date.now(),
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {privateEpoch:pg.privateEpoch});
  assert.deepEqual(check("alice",owner),{ok:true});
  const session=issueDurableTargetStagingSession(f.store,"bob",600);
  assert.equal(session.ok,true,JSON.stringify(session));
  const hash=hashTargetStagingSessionToken(session.sessionToken);
  assert.deepEqual(check("bob",bob,hash),{ok:true});
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='shared-bob'").run();
  assert.equal(check("bob",bob,hash).reason,"stale");
  assert.deepEqual(check("alice",owner),{ok:true});
  assert.notEqual(page(f).revision,bob.revision);
  assert.equal(page(f,"alice").revision,owner.revision);
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  assert.equal(page(f).plans.some(p=>p.taskId==="shared-bob"),false);
  assert.equal(check("bob",bob,hash).reason,"stale");
  // Canonical schema requires every assigned task (including project children)
  // to be unassigned before removing a member.
  assert.throws(()=>f.db.prepare(
    "DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run(),
    /unassign tasks before removing membership/);
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='project-child'").run();
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(page(f)),["bob-private"]);
});
