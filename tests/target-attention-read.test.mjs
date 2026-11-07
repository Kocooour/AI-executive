import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5a-attention-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedAttentionCandidatePage}=await import("../lib/target-attention-read-model.ts");
const {endOfLocalDate}=await import("../lib/attention.ts");
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
  // Second shared Area bob can edit (task-move target) and an EMPTY one.
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','team','shared','team','alice')").run();
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
    ["team-area","alice","admin"],["team-area","bob","editor"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Family')").run();
  const put=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["b-over","bob-private",null,"Bob overdue",null,"2026-11-03"],
    ["b-today","bob-private",null,"Bob due today",null,"2026-11-04"],
    ["b-tom","bob-private",null,"Bob due tomorrow",null,"2026-11-05"],
    ["b-3days","bob-private",null,"Bob due in 3 days",null,"2026-11-07"],
    ["b-passed","bob-private",null,"Bob plan passed",null,null],
    ["b-supp","bob-private",null,"Bob plan passed with deadline",null,"2026-11-05"],
    ["b-far","bob-private",null,"Bob plan passed, far deadline",null,"2026-11-09"],
    ["b-planned-today","bob-private",null,"Bob planned today",null,null],
    ["b-done","bob-private",null,"Bob done",null,"2026-11-01"],
    ["alice-private",stage.unassignedAreaId,null,"Alice only secret",null,"2026-11-01"],
    ["erin-private","erin-private",null,"Erin only secret",null,"2026-11-01"],
    ["s-mine","family-area",null,"Shared mine","bob","2026-11-02"],
    ["s-unassigned","family-area",null,"Unassigned secret",null,"2026-11-01"],
    ["s-alice","family-area",null,"Alice shared secret","alice","2026-11-01"],
    ["s-child",null,"project","Inherited Area","bob","2026-11-03"],
    ["hidden","hidden-area",null,"Hidden secret","erin","2026-11-01"],
  ])put.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='b-done'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["bob","b-passed","2026-11-03"],["bob","b-supp","2026-11-02"],
    ["bob","b-far","2026-11-02"],["bob","b-planned-today","2026-11-04"],
    ["alice","s-alice","2026-11-01"],["alice","alice-private","2026-10-01"],
    ["erin","erin-private","2026-10-01"],
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
// 2026-11-04 12:00 Europe/Prague (CET, UTC+1).
const NOON=Date.parse("2026-11-04T11:00:00Z");
const TZ="Europe/Prague";
const ids=p=>p.items.map(i=>i.taskId);
function page(f,actor="bob",filter="all",extra={}){
  return readAuthorizedAttentionCandidatePage(f.reader,{
    actorUserId:actor,areaFilter:filter,evaluatedAtMs:NOON,timeZone:TZ,
    limit:100,offset:0,restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}
const rule=(p,id)=>p.items.find(i=>i.taskId===id)?.ruleId;

test("rule classification at a fixed Prague instant",()=>{
  const f=fixture();const p=page(f);
  assert.equal(p.evaluationDate,"2026-11-04");
  assert.equal(p.soonThroughDate,"2026-11-05");
  assert.equal(rule(p,"b-over"),"deadline_overdue");
  assert.equal(rule(p,"s-mine"),"deadline_overdue");
  assert.equal(rule(p,"s-child"),"deadline_overdue");
  assert.equal(rule(p,"b-today"),"deadline_soon");
  assert.equal(rule(p,"b-tom"),"deadline_soon");
  assert.equal(rule(p,"b-3days"),undefined);
  assert.equal(rule(p,"b-passed"),"planned_date_passed");
  assert.equal(rule(p,"b-supp"),"deadline_soon","planned suppressed by deadline item");
  assert.equal(rule(p,"b-far"),"planned_date_passed");
  assert.equal(rule(p,"b-planned-today"),undefined);
  assert.equal(rule(p,"b-done"),undefined);
  const sev={deadline_overdue:1,deadline_soon:2,planned_date_passed:5};
  const thr={deadline_overdue:0,deadline_soon:48,planned_date_passed:0};
  for(const i of p.items){
    assert.equal(i.severity,sev[i.ruleId]);
    assert.equal(i.thresholdHours,thr[i.ruleId]);
    assert.equal(i.reasonCode,i.ruleId);assert.equal(i.ruleVersion,1);
    assert.equal(i.relevantAt,endOfLocalDate(i.relevantOn,TZ));
    assert.equal(i.relevantOn,i.ruleId==="planned_date_passed"?i.whenOn:i.dueOn);
  }
  assert.equal(new Set(ids(p)).size,ids(p).length);
});

test("ordering is severity, relevantOn, taskId and deterministic",()=>{
  const f=fixture();const a=page(f),b=page(f);
  assert.deepEqual(ids(a),[
    "s-mine","b-over","s-child","b-today","b-supp","b-tom","b-far","b-passed",
  ]);
  assert.deepEqual(a,b);
  assert.deepEqual(a.items.map(i=>i.attentionKey),b.items.map(i=>i.attentionKey));
});

test("attention key is stable across title/revision/Area move, new for new date",()=>{
  const f=fixture();
  const key=id=>page(f).items.find(i=>i.taskId===id)?.attentionKey;
  const before=key("s-mine");
  const expected="tatt1:"+createHash("sha256").update("lumi:r2d5:attention:v1\0")
    .update(JSON.stringify(["deadline_overdue",1,"s-mine","date-2026-11-02"])).digest("hex");
  assert.equal(before,expected);
  f.db.prepare("UPDATE tasks SET title='Renamed' WHERE id='s-mine'").run();
  assert.equal(key("s-mine"),before);
  f.db.prepare("UPDATE tasks SET area_id='team-area' WHERE id='s-mine'").run();
  const moved=page(f).items.find(i=>i.taskId==="s-mine");
  assert.equal(moved.areaId,"team-area");assert.equal(moved.attentionKey,before);
  f.db.prepare("UPDATE tasks SET due_on='2026-11-01' WHERE id='s-mine'").run();
  assert.notEqual(key("s-mine"),before);
});

test("ACL: only own private and shared assigned to the actor",()=>{
  const f=fixture();
  const bob=page(f);
  assert.ok(ids(bob).every(i=>!["alice-private","erin-private","hidden","s-unassigned","s-alice"].includes(i)));
  assert.equal(rule(bob,"s-mine")!==undefined,true);
  assert.deepEqual(ids(page(f,"carol")),[]);
  assert.deepEqual(ids(page(f,"alice")).sort(),["alice-private","s-alice"]);
  assert.deepEqual(ids(page(f,"erin")).sort(),["erin-private","hidden"]);
  // Alice's plan on s-alice must not create a planned item for bob.
  assert.equal(bob.items.find(i=>i.taskId==="s-alice"),undefined);
  assert.equal(page(f,"alice").items.find(i=>i.taskId==="s-alice").whenOn,"2026-11-01");
  const json=JSON.stringify(bob);
  for(const secret of ["Alice only secret","Erin only secret","Unassigned secret",
    "Alice shared secret","Hidden secret"])assert.ok(!json.includes(secret));
  for(const i of bob.items)if(i.areaKind==="shared")assert.equal(i.assignedToMe,true);
});

test("revocation, demotion and reassignment remove shared items and change revision",()=>{
  const f=fixture();
  const r0=page(f);
  f.db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-mine'").run();
  const reassigned=page(f);
  assert.ok(!ids(reassigned).includes("s-mine")&&ids(reassigned).includes("s-child"));
  assert.notEqual(reassigned.revision,r0.revision);
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-child'").run();
  f.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  const demoted=page(f);
  assert.ok(ids(demoted).every(i=>i.startsWith("b-")));
  assert.notEqual(demoted.revision,reassigned.revision);
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  const gone=page(f);
  assert.ok(ids(gone).every(i=>i.startsWith("b-")));
  assert.notEqual(gone.revision,r0.revision);
});

test("areaFilter is an intersection",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f,"bob","shared")),["s-mine","s-child"]);
  assert.ok(page(f,"bob","personal").items.every(i=>i.areaKind==="private"));
  assert.equal(ids(page(f,"bob","personal")).length+2,ids(page(f)).length);
});

test("time zone: local midnight, DST end and zone differences",()=>{
  const f=fixture();
  const at=(ms,tz=TZ)=>page(f,"bob","all",{evaluatedAtMs:ms,timeZone:tz});
  // 23:30 Prague 11-04 vs 00:30 Prague 11-05.
  const before=at(Date.parse("2026-11-04T22:30:00Z"));
  const after=at(Date.parse("2026-11-04T23:30:00Z"));
  assert.equal(before.evaluationDate,"2026-11-04");
  assert.equal(after.evaluationDate,"2026-11-05");
  assert.equal(rule(before,"b-today"),"deadline_soon");
  assert.equal(rule(after,"b-today"),"deadline_overdue");
  assert.notEqual(before.revision,after.revision);
  // DST end 2026-10-25 is a 25h day: its end is 2026-10-25T23:00Z.
  // 10-24 00:30 local (10-23T22:30Z) -> 48.5h away, so D+1 is NOT soon;
  // exactly 48h away (10-23T23:00Z) it is; 10-24 03:00 local (01:00Z) -> 46h.
  for(const iso of ["2026-10-23T22:30:00Z","2026-10-24T01:00:00Z"]){
    const ms=Date.parse(iso),p=at(ms);
    const expectS=[0,1,2].map(n=>{
      const d=new Date(Date.parse(p.evaluationDate+"T00:00:00Z")+n*86400000).toISOString().slice(0,10);
      return [d,endOfLocalDate(d,TZ)-ms];
    }).filter(([,x])=>x>=0&&x<=48*3600000).map(([d])=>d).pop();
    assert.equal(p.soonThroughDate,expectS,iso);
  }
  assert.equal(at(Date.parse("2026-10-23T22:30:00Z")).soonThroughDate,"2026-10-24");
  assert.equal(at(Date.parse("2026-10-23T23:00:00Z")).soonThroughDate,"2026-10-25");
  assert.equal(at(Date.parse("2026-10-24T01:00:00Z")).soonThroughDate,"2026-10-25");
  // Different zones, same instant, different local date.
  const utc=Date.parse("2026-11-04T23:30:00Z");
  assert.equal(at(utc,"UTC").evaluationDate,"2026-11-04");
  assert.equal(at(utc,"Pacific/Kiritimati").evaluationDate,"2026-11-05");
  assert.equal(at(utc,"America/Los_Angeles").evaluationDate,"2026-11-04");
  assert.equal(at(Date.parse("2026-11-04T03:00:00Z"),"America/Los_Angeles").evaluationDate,"2026-11-03");
});

test("invalid input returns null",()=>{
  const f=fixture();
  for(const broken of [
    {actorUserId:"bob or erin"},{actorUserId:""},{areaFilter:"everybody"},
    {timeZone:"Mars/Olympus"},{timeZone:"../etc"},{timeZone:""},{timeZone:"A".repeat(65)},
    {timeZone:5},{evaluatedAtMs:-1},{evaluatedAtMs:Number.MAX_SAFE_INTEGER+1},
    {evaluatedAtMs:1.5},{evaluatedAtMs:"1"},{limit:0},{limit:101},
    {offset:-1},{offset:10_001},{restoreGeneration:"bad"},
  ])assert.equal(page(f,"bob","all",broken),null,JSON.stringify(broken));
  assert.equal(page(f,"nobody"),null);
});

test("pagination walks all items without duplicates",()=>{
  const f=fixture();
  const all=ids(page(f));const walked=[];
  for(let offset=0;;offset++){
    const p=page(f,"bob","all",{limit:1,offset});
    walked.push(...ids(p));
    if(!p.hasMore)break;
    assert.ok(offset<50);
  }
  assert.deepEqual(walked,all);
  assert.equal(new Set(walked).size,walked.length);
});

test("staging authority path: valid actor, revocation, close",()=>{
  const f=fixture();
  const read=f.authority.readAttentionCandidatePage("bob","all",NOON,TZ,100,0);
  assert.deepEqual(ids(read),ids(page(f)));
  assert.equal(f.authority.readAttentionCandidatePage("a client actor","all",NOON,TZ,100,0),null);
  assert.equal(f.authority.readAttentionCandidatePage("bob","all",NOON,"Mars/Olympus",100,0),null);
  const issued=issueDurableTargetStagingSession(f.store,"bob",600);
  assert.equal(issued.ok,true);
  const tokenHash=hashTargetStagingSessionToken(issued.sessionToken);
  const check=pg=>verifyTargetStagingReadLive(f.store,{tokenHash},pg.linearization,Date.now(),
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {privateEpoch:pg.privateEpoch});
  assert.deepEqual(check(read),{ok:true});
  assert.equal(revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.notEqual(check(read).ok,true);
  assert.ok(f.authority.readAttentionCandidatePage("carol","all",NOON,TZ,100,0));
  f.authority.close();
  assert.equal(f.authority.readAttentionCandidatePage("carol","all",NOON,TZ,100,0),null);
});

test("output is a strict allowlist and leaks nothing foreign",()=>{
  const f=fixture();const p=page(f);
  const base=["attentionKey","subjectType","taskId","title","projectId","areaId","areaKind",
    "ruleId","ruleVersion","severity","reasonCode","relevantOn","relevantAt","dueOn","whenOn",
    "thresholdHours","sourceRevision"];
  for(const i of p.items){
    const keys=Object.keys(i).sort();
    assert.deepEqual(keys,[...base,...(i.areaKind==="shared"?["assignedToMe"]:[])].sort());
  }
  const json=JSON.stringify(p.items);
  for(const who of ["alice","carol","erin"])assert.ok(!json.includes(who),who);
});
