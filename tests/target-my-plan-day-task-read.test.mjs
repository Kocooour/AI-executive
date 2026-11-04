import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3l1-day-task-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedMyPlanDayTaskPage}=await import("../lib/target-my-plan-day-task-read-model.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {verifyTargetStagingReadLive,issueDurableTargetStagingSession,
  hashTargetStagingSessionToken,revokeAllDurableTargetStagingSessionsForUser}=
  await import("../lib/target-staging-durable-session.ts");
let count=0;const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
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
  for(const [ws,owner] of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(ws,owner);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,owner);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Family')").run();
  const put=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["p-backlog","bob-private",null,"Yesterday backlog",null,"2026-11-03"],
    ["p-plan","bob-private",null,"Planned today",null,null],
    ["p-both","bob-private",null,"Planned today, due later",null,"2026-11-07"],
    ["p-due","bob-private",null,"Due today, planned later",null,"2026-11-04"],
    ["p-next","bob-private",null,"Due next week",null,"2026-11-06"],
    ["p-empty","bob-private",null,"Unscheduled",null,null],
    ["alice-private",stage.unassignedAreaId,null,"Alice only",null,"2026-11-04"],
    ["erin-private","erin-private",null,"Erin only",null,"2026-11-04"],
    ["s-plan","family-area",null,"Bob shared plan","bob",null],
    ["s-both","family-area",null,"Bob shared due and plan","bob","2026-11-07"],
    ["s-unassigned","family-area",null,"Unassigned shared",null,"2026-11-04"],
    ["s-other","family-area",null,"Assigned to Alice","alice","2026-11-04"],
    ["s-done","family-area",null,"Done task","bob","2026-11-04"],
    ["s-child",null,"project","Inherited Area","bob","2026-11-10"],
    ["hidden","hidden-area",null,"Hidden to Bob","erin","2026-11-04"],
    ["  č spaced  ","family-area",null,"Padded","bob","2026-11-05"],
  ])put.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-done'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["bob","p-plan","2026-11-04"],["bob","p-both","2026-11-04"],
    ["bob","p-due","2026-11-09"],["bob","s-plan","2026-11-05"],
    ["bob","s-both","2026-11-06"],["alice","s-other","2026-11-04"],
    ["alice","alice-private","2026-11-07"],["erin","erin-private","2026-11-04"],
  ])plan.run(...row);
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const authority=new TargetStagingSessionAuthority(store);
  const fx={db,reader,authority,stage,store};fixtures.push(fx);
  return fx;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(old===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=old;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const ids=p=>p.tasks.map(t=>t.taskId);
function page(f,actor="bob",window="today",filter="all",extra={}){
  return readAuthorizedMyPlanDayTaskPage(f.reader,{
    actorUserId:actor,window,areaFilter:filter,evaluationDate:"2026-11-04",
    throughDate:window==="upcoming"?"2026-11-11":null,
    limit:100,offset:0,restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}

test("task-only My Plan day union deduplicates both dates and partitions by earliest attention",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f)),["p-backlog","p-both","p-due","p-plan"]);
  assert.deepEqual(ids(page(f,"bob","upcoming")),[
    "  č spaced  ","s-plan","p-next","s-both","s-child",
  ]);
  const both=page(f).tasks.find(t=>t.taskId==="p-both");
  assert.deepEqual({dueOn:both.dueOn,whenOn:both.whenOn,attentionOn:both.attentionOn},
    {dueOn:"2026-11-07",whenOn:"2026-11-04",attentionOn:"2026-11-04"});
  const deadline=page(f).tasks.find(t=>t.taskId==="p-due");
  assert.equal(deadline.attentionOn,"2026-11-04");
  assert.equal(deadline.whenOn,"2026-11-09");
  assert.ok(!ids(page(f,"bob","upcoming")).includes("p-due"),
    "task with earlier shared deadline is not repeated in upcoming");
  assert.ok(!ids(page(f)).includes("p-empty"));
  assert.ok(!ids(page(f)).includes("s-done"));
  assert.ok(page(f).tasks.every(t=>t.areaKind==="private"));
});

test("my-plan is never global Vše: Area filter narrows assigned private/shared work",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f,"bob","today","personal")),ids(page(f)));
  assert.deepEqual(ids(page(f,"bob","today","shared")),[]);
  assert.deepEqual(ids(page(f,"bob","upcoming","personal")),["p-next"]);
  assert.deepEqual(ids(page(f,"bob","upcoming","shared")),[
    "  č spaced  ","s-plan","s-both","s-child",
  ]);
  assert.deepEqual(ids(page(f,"alice","today")),["alice-private","s-other"]);
  assert.deepEqual(ids(page(f,"carol","today")),[]);
  assert.deepEqual(ids(page(f,"erin","today")),["erin-private","hidden"]);
  assert.ok(!JSON.stringify(page(f)).includes("Alice only"));
  assert.ok(!JSON.stringify(page(f)).includes("Hidden to Bob"));
  assert.ok(!JSON.stringify(page(f)).includes("s-unassigned"));
  assert.ok(!JSON.stringify(page(f)).includes("s-other"));
  for(const t of page(f,"bob","upcoming").tasks){
    assert.equal("assigneeUserId" in t,false);
    assert.equal("userId" in t,false);
    assert.equal("privateEpoch" in t,false);
    if(t.areaKind==="shared")assert.equal(t.assignedToMe,true);
  }
});

test("SQL filters before limit/offset and rejects invalid dates, windows or actor",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f,"bob","today","all",{limit:2,offset:0})),
    ["p-backlog","p-both"]);
  assert.deepEqual(ids(page(f,"bob","today","all",{limit:2,offset:2})),
    ["p-due","p-plan"]);
  assert.equal(page(f,"bob","today","all",{limit:2,offset:0}).hasMore,true);
  assert.equal(page(f,"bob","today","all",{limit:2,offset:2}).hasMore,false);
  for(const broken of [
    {actorUserId:"bob or erin"},{window:"all"},{areaFilter:"everybody"},
    {evaluationDate:"2026-02-29"},{evaluationDate:"2026-11-04T00:00:00Z"},
    {throughDate:"2026-11-05"},{limit:0},{limit:101},{offset:-1},
    {offset:1_000_001},{restoreGeneration:"bad"},
  ])assert.equal(page(f,"bob","today","all",broken),null,JSON.stringify(broken));
  for(const broken of [
    {throughDate:null},{throughDate:"2026-11-04"},
    {throughDate:"2026-11-03"},{throughDate:"2027-11-04"},
  ])assert.equal(page(f,"bob","upcoming","all",broken),null,JSON.stringify(broken));
  assert.deepEqual(ids(page(f,"bob","upcoming","all",{throughDate:"2026-11-05"})),
    ["  č spaced  ","s-plan"]);
});

test("actor-private epoch revision changes only on that actor's plans",()=>{
  const f=fixture();
  const bob=page(f),alice=page(f,"alice");
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-08' WHERE user_id='alice' AND task_id='alice-private'").run();
  assert.equal(page(f).revision,bob.revision);
  assert.notEqual(page(f,"alice").revision,alice.revision);
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='s-plan'").run();
  assert.notEqual(page(f).revision,bob.revision);
});

test("a revoked shared assignment never leaks the old private plan or deadline",()=>{
  const f=fixture();
  assert.ok(ids(page(f,"bob","upcoming")).includes("s-plan"));
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-plan'").run();
  assert.ok(!ids(page(f,"bob","upcoming")).includes("s-plan"));
  assert.ok(!JSON.stringify(page(f,"bob","upcoming")).includes("Bob shared plan"));
  assert.equal(f.db.prepare(
    "SELECT COUNT(*) AS n FROM personal_task_plans WHERE user_id='bob' AND task_id='s-plan'"
  ).get().n,0);
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-both'").run();
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-done'").run();
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-child'").run();
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='  č spaced  '").run();
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(page(f,"bob","upcoming")),["p-next"]);
});

test("staging authority uses canonical preflight; live guard binds session and private epoch",()=>{
  const f=fixture();
  const read=f.authority.readMyPlanDayTaskPage("bob","all","today","2026-11-04",null,100,0);
  assert.deepEqual(ids(read),ids(page(f)));
  assert.equal(f.authority.readMyPlanDayTaskPage(
    "bob","all","upcoming","2026-11-04",null,100,0),null);
  assert.equal(f.authority.readMyPlanDayTaskPage(
    "a client supplied actor ID","all","today","2026-11-04",null,100,0),null);
  const issued=issueDurableTargetStagingSession(f.store,"bob",600);
  assert.equal(issued.ok,true);
  const tokenHash=hashTargetStagingSessionToken(issued.sessionToken);
  const check=pg=>verifyTargetStagingReadLive(f.store,{tokenHash},pg.linearization,Date.now(),
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {privateEpoch:pg.privateEpoch});
  assert.deepEqual(check(read),{ok:true});
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='p-plan'").run();
  assert.equal(check(read).reason,"stale");
  const refreshed=page(f);
  assert.deepEqual(check(refreshed),{ok:true});
  assert.equal(revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.notEqual(check(refreshed).ok,true);
});
