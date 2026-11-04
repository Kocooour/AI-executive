import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3j1-due-window-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {readAuthorizedTemporalDueWindowPage,temporalCalendarOrdinal}=
  await import("../lib/target-task-temporal-read-model.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
let n=0;
const fixtures=[];
function setup(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++n)),ownerUserId:"alice",
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
  for(const [ws,who] of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)").run(ws,who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,who);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ]) db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Family')").run();
  const ins=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  const records=[
    ["a-past","bob-private",null,"Past personal",null,"2026-11-03"],
    ["a-today","bob-private",null,"Today personal",null,"2026-11-04"],
    ["a-next","bob-private",null,"Tomorrow personal",null,"2026-11-05"],
    ["a-no-date","bob-private",null,"No deadline",null,null],
    ["s-past","family-area",null,"Past shared","bob","2026-11-03"],
    ["s-today","family-area",null,"Today shared","bob","2026-11-04"],
    ["s-next","family-area",null,"Upcoming shared","bob","2026-11-10"],
    ["s-unassigned","family-area",null,"No assignee",null,"2026-11-04"],
    ["s-other","family-area",null,"Assigned to Alice","alice","2026-11-04"],
    ["s-child",null,"project","Inherited Area","bob","2026-11-11"],
    ["s-later","family-area",null,"Later","bob","2027-04-01"],
    ["x-hidden","hidden-area",null,"Secret","erin","2026-11-04"],
    ["erin-private","erin-private",null,"Private secret",null,"2026-11-04"],
  ];
  for(const [id,area,project,title,assignee,due] of records)
    ins.run(id,area,project,title,assignee,due);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-past'").run();
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const fx={db,reader,authority,stage,store};
  fixtures.push(fx);
  return fx;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(old===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=old;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const ids=p=>p.tasks.map(t=>t.id);
function page(fx,actor="bob",scope="my-plan",window="due-today",extra={}){
  return readAuthorizedTemporalDueWindowPage(fx.reader,{
    actorUserId:actor,scope,window,evaluationDate:"2026-11-04",
    throughDate:window==="upcoming"?"2026-11-11":null,
    restoreGeneration:fx.stage.restoreGeneration,limit:100,offset:0,...extra,
  });
}

test("Gregorian ordinal accepts leap centuries, rejects timestamps/rollovers",()=>{
  for(const date of ["0001-01-01","2024-02-29","2000-02-29",
    "2026-11-04","9999-12-31"])
    assert.ok(Number.isSafeInteger(temporalCalendarOrdinal(date)),date);
  for(const date of [null,1,undefined,"","0000-01-01","2024-02-30",
    "2026-02-29","1900-02-29","2100-02-29","2026-13-01",
    "2026-11-04T00:00:00Z","2026-11-4","2026/11/04",
    "2026-04-31","2026-11-04+01:00"])
    assert.equal(temporalCalendarOrdinal(date),null,String(date));
  assert.equal(temporalCalendarOrdinal("2024-03-01")-
    temporalCalendarOrdinal("2024-02-28"),2);
  assert.equal(temporalCalendarOrdinal("1900-03-01")-
    temporalCalendarOrdinal("1900-02-28"),1);
  assert.equal(temporalCalendarOrdinal("2000-03-01")-
    temporalCalendarOrdinal("2000-02-28"),2);
});

test("open deadline windows partition dates and apply My Plan assignee ACL",()=>{
  const fx=setup();
  assert.deepEqual(ids(page(fx,"bob","my-plan","overdue")),["a-past"]);
  assert.deepEqual(ids(page(fx)),["a-today","s-today"]);
  assert.deepEqual(ids(page(fx,"bob","my-plan","upcoming")),
    ["a-next","s-next","s-child"]);
  assert.deepEqual(ids(page(fx,"bob","shared","due-today")),
    ["s-other","s-today","s-unassigned"]);
  assert.deepEqual(ids(page(fx,"carol","shared","due-today")),
    ["s-other","s-today","s-unassigned"]);
  assert.deepEqual(ids(page(fx,"carol","my-plan","due-today")),[]);
  assert.deepEqual(ids(page(fx,"erin","my-plan","due-today")),["erin-private","x-hidden"]);
  assert.deepEqual(ids(page(fx,"bob","personal","due-today")),["a-today"]);
  assert.deepEqual(ids(page(fx,"alice","personal","due-today")),[]);
  assert.deepEqual(ids(page(fx,"missing","shared","due-today")),[]);
  for(const item of page(fx).tasks){
    assert.equal(item.status,"open");
    assert.equal(item.dueOn,"2026-11-04");
    assert.equal("when" in item,false);
    assert.equal("actorUserId" in item,false);
    assert.equal("assigneeUserId" in item,false);
  }
  assert.deepEqual(page(fx).linearization.areas.map(a=>a.areaId).sort(),
    ["bob-private","family-area"]);
});

test("bounded upcoming horizon and strict request contract fail closed",()=>{
  const fx=setup();
  for(const invalid of [
    {window:"completed"},{window:"today"},{evaluationDate:"2026-02-29"},
    {evaluationDate:"2026-11-04T00:00:00Z"},
    {throughDate:"2026-11-05"},{window:"upcoming",throughDate:null},
    {window:"upcoming",throughDate:"2026-11-04"},
    {window:"upcoming",throughDate:"2026-11-03"},
    {window:"upcoming",throughDate:"2027-11-04"},
    {window:"upcoming",throughDate:"2026-11-05T00:00:00Z"},
    {limit:0},{limit:101},{offset:-1},{offset:1_000_001},
    {scope:"all"},{actorUserId:"bogus user"},{restoreGeneration:"bad"},
  ]) assert.equal(page(fx,"bob","my-plan","due-today",invalid),null,JSON.stringify(invalid));
  assert.deepEqual(ids(page(fx,"bob","my-plan","upcoming",{throughDate:"2026-11-05"})),
    ["a-next"]);
  assert.deepEqual(ids(page(fx,"bob","my-plan","upcoming",{throughDate:"2027-01-01"})),
    ["a-next","s-next","s-child"]);
  assert.deepEqual(ids(page(fx,"bob","shared","upcoming",{throughDate:"2026-11-09"})),[]);
});

test("sort by canonical date then ID before offset; stable page revision binds filters",()=>{
  const fx=setup();
  const first=page(fx,"bob","my-plan","due-today",{limit:1});
  const second=page(fx,"bob","my-plan","due-today",{limit:1,offset:1});
  assert.deepEqual(ids(first),["a-today"]);
  assert.deepEqual(ids(second),["s-today"]);
  assert.equal(first.hasMore,true);
  assert.equal(second.hasMore,false);
  assert.equal(first.revision,second.revision);
  assert.equal(first.evaluationDate,"2026-11-04");
  assert.equal(first.throughDate,null);
  assert.equal(first.window,"due-today");
  const rev=first.revision;
  assert.notEqual(page(fx,"bob","my-plan","overdue").revision,rev);
  assert.notEqual(page(fx,"bob","shared","due-today").revision,rev);
  assert.notEqual(page(fx,"bob","my-plan","due-today",
    {evaluationDate:"2026-11-05"}).revision,rev);
  assert.notEqual(page(fx,"bob","my-plan","upcoming").revision,rev);
  assert.notEqual(page(fx,"bob","my-plan","upcoming",
    {throughDate:"2026-11-12"}).revision,
    page(fx,"bob","my-plan","upcoming").revision);
  // The page contains only date-matching rows before pagination, not a
  // filtered 100-item generic task page that misses later due dates.
  assert.ok(!page(fx).tasks.some(t=>t.id==="a-no-date"));
  const insert=fx.db.prepare(
    "INSERT INTO tasks(id,area_id,title,due_on) VALUES (?,?,?,?)");
  for(let i=0;i<120;i++)insert.run("z"+String(i).padStart(3,"0"),
    "bob-private","No date row "+i,null);
  assert.deepEqual(ids(page(fx)),["a-today","s-today"]);
});

test("due date ABA, membership and assignment changes invalidate revisions",()=>{
  const fx=setup(),before=page(fx);
  const rev=before.revision;
  fx.db.prepare("UPDATE tasks SET due_on='2026-11-06' WHERE id='a-today'").run();
  assert.deepEqual(ids(page(fx)),["s-today"]);
  fx.db.prepare("UPDATE tasks SET due_on='2026-11-04' WHERE id='a-today'").run();
  assert.deepEqual(ids(page(fx)),["a-today","s-today"]);
  assert.notEqual(page(fx).revision,rev);
  const beforeRole=page(fx).revision;
  fx.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(page(fx)),["a-today"]);
  assert.deepEqual(ids(page(fx,"bob","shared","due-today")),
    ["s-other","s-today","s-unassigned"]);
  assert.notEqual(page(fx).revision,beforeRole);
  fx.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(ids(page(fx,"bob","shared","due-today")),[]);
  assert.deepEqual(ids(page(fx)),["a-today"]);
  assert.equal(page(fx).linearization.areas.some(a=>a.areaId==="family-area"),false);
});

test("canonical preflight and actor-bound authority cannot widen Area scope",()=>{
  const fx=setup();
  const result=fx.authority.readTemporalDueWindowPage(
    "bob","my-plan","due-today","2026-11-04",null,100,0);
  assert.deepEqual(ids(result),["a-today","s-today"]);
  assert.deepEqual(ids(fx.authority.readTemporalDueWindowPage(
    "bob","shared","due-today","2026-11-04",null,100,0)),
    ["s-other","s-today","s-unassigned"]);
  assert.equal(fx.authority.readTemporalDueWindowPage(
    "bob","my-plan","upcoming","2026-11-04",null,100,0),null);
  assert.equal(fx.authority.readTemporalDueWindowPage(
    "invalid user","shared","due-today","2026-11-04",null,100,0),null);
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:fx.stage.directory,
    expectedRestoreGeneration:fx.stage.restoreGeneration,mode:"r2-model",
  }),{ok:true,mode:"r2-model",issues:[]});
});
