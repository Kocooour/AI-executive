import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m1-global-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const previous=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedGlobalTaskPage,eligibleGlobalTaskAreas}=
  await import("../lib/target-global-task-read-model.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {verifyTargetStagingReadLive,issueDurableTargetStagingSession,
  hashTargetStagingSessionToken,revokeAllDurableTargetStagingSessionsForUser}=
  await import("../lib/target-staging-durable-session.ts");

let serial=0;const fixtures=[];
function fixture(){
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
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('family-project','family-area','Family')").run();
  const insert=db.prepare(
    "INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)"
  );
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice secret",null,"2026-11-04"],
    ["b-bob","bob-private",null,"Bob personal",null,"2026-11-04"],
    ["c-carol","carol-private",null,"Carol personal",null,null],
    ["d-erin","erin-private",null,"Erin secret",null,"2026-11-05"],
    ["s-bob","family-area",null,"Assigned to Bob","bob",null],
    ["s-alice","family-area",null,"Assigned to Alice","alice","2026-11-06"],
    ["s-unassigned","family-area",null,"Nobody assigned",null,null],
    ["s-carol","family-area",null,"Assigned to viewer","carol",null],
    ["s-completed","family-area",null,"Done","bob","2026-11-03"],
    ["s-child",null,"family-project","Inherited Area","alice",null],
    ["hidden","hidden-area",null,"Hidden to Bob","erin",null],
    ["  spaced č  ","family-area",null,"Raw SQLite ID","bob",null],
  ])insert.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-completed'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["bob","b-bob","2026-11-05"],
    ["bob","s-bob","2026-11-06"],
    ["alice","a-alice","2026-11-07"],
    ["erin","d-erin","2026-11-08"],
  ])plan.run(...row);
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const authority=new TargetStagingSessionAuthority(store);
  const item={db,reader,stage,store,authority};fixtures.push(item);return item;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(previous===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=previous;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const ids=p=>p.tasks.map(x=>x.id);
function page(f,actor="bob",scope="all",extra={}){
  return readAuthorizedGlobalTaskPage(f.reader,{
    actorUserId:actor,scope,limit:100,offset:0,
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}

test("global Vše is broader than My Plan; personal/shared are disjoint filters",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f)),[
    "  spaced č  ","b-bob","s-alice","s-bob","s-carol","s-child",
    "s-completed","s-unassigned",
  ]);
  assert.deepEqual(ids(page(f,"bob","personal")),["b-bob"]);
  assert.deepEqual(ids(page(f,"bob","shared")),[
    "  spaced č  ","s-alice","s-bob","s-carol","s-child",
    "s-completed","s-unassigned",
  ]);
  assert.deepEqual(ids(page(f,"carol","all")), [
    "  spaced č  ","c-carol","s-alice","s-bob","s-carol","s-child",
    "s-completed","s-unassigned",
  ]);
  assert.deepEqual(ids(page(f,"alice","all")), [
    "  spaced č  ","a-alice","s-alice","s-bob","s-carol","s-child",
    "s-completed","s-unassigned",
  ]);
  assert.deepEqual(ids(page(f,"erin","all")),["d-erin","hidden"]);
  assert.ok(!JSON.stringify(page(f)).includes("Alice secret"));
  assert.ok(!JSON.stringify(page(f)).includes("Erin secret"));
  const p=page(f);
  const mine=p.tasks.find(x=>x.id==="s-bob");
  const other=p.tasks.find(x=>x.id==="s-alice");
  const nobody=p.tasks.find(x=>x.id==="s-unassigned");
  assert.equal(mine.assignedToMe,true);
  assert.equal(other.assignedToMe,false);
  assert.equal(nobody.assignedToMe,false);
  assert.equal(p.tasks.find(x=>x.id==="s-completed").status,"completed");
  assert.equal(p.tasks.find(x=>x.id==="s-child").projectId,"family-project");
  for(const row of p.tasks){
    assert.equal("assigneeUserId" in row,false);
    assert.equal("whenOn" in row,false);
    assert.equal("privateEpoch" in row,false);
    if(row.areaKind==="private")assert.equal("assignedToMe" in row,false);
  }
});

test("SQL global ordering and pagination are deterministic across both Area kinds",()=>{
  const f=fixture(),all=page(f);
  const chunks=[];
  for(let offset=0;offset<all.tasks.length;offset+=2){
    const part=page(f,"bob","all",{limit:2,offset});
    assert.ok(part);
    assert.deepEqual(ids(part),ids(all).slice(offset,offset+2));
    assert.equal(part.hasMore,offset+2<all.tasks.length);
    chunks.push(...ids(part));
  }
  assert.deepEqual(chunks,ids(all));
  assert.deepEqual(ids(page(f,"carol","shared",{limit:3,offset:2})),
    ids(page(f,"carol","shared")).slice(2,5));
});

test("unknown/invalid scope, actor, generation, offsets and limits fail closed",()=>{
  const f=fixture();
  for(const invalid of [
    {scope:"my-plan"},{scope:"everywhere"},
    {actorUserId:"bob or 1=1"},{actorUserId:""},
    {limit:0},{limit:101},{limit:1.1},{offset:-1},
    {offset:1_000_001},{offset:1.5},{restoreGeneration:"bad"},
  ])assert.equal(page(f,"bob","all",invalid),null,JSON.stringify(invalid));
  assert.deepEqual(ids(page(f,"not-an-identity")),[]);
  assert.equal(page(f,"not-an-identity").linearization.areas.length,0);
});

test("revision uses full Area content epochs, not another actor's private plan",()=>{
  const f=fixture(),p=page(f);
  assert.ok(p.areaEpochs.some(a=>a.areaId==="family-area"&&a.access==="editor"));
  assert.ok(p.areaEpochs.some(a=>a.areaId==="bob-private"&&a.access==="private-owner"));
  const token=p.revision;
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-09' WHERE user_id='alice' AND task_id='a-alice'").run();
  assert.equal(page(f).revision,token);
  f.db.prepare("UPDATE tasks SET title='Shared changed' WHERE id='s-alice'").run();
  assert.notEqual(page(f).revision,token);
  assert.equal(page(f,"bob","personal").revision,
    page(f,"bob","personal").revision);
});

test("authenticated preflight authority and full LIVE guard catch role, content and new Area",()=>{
  const f=fixture();
  const authorityPage=f.authority.readGlobalTaskPage("carol","all",100,0);
  assert.deepEqual(ids(authorityPage),ids(page(f,"carol")));
  assert.equal(f.authority.readGlobalTaskPage("bob","my-plan",100,0),null);
  assert.equal(f.authority.readGlobalTaskPage("bob or bad","all",100,0),null);
  const issued=issueDurableTargetStagingSession(f.store,"carol",600);
  assert.equal(issued.ok,true);
  const tokenHash=hashTargetStagingSessionToken(issued.sessionToken);
  const check=pg=>verifyTargetStagingReadLive(f.store,{tokenHash},pg.linearization,
    Date.now(),undefined,undefined,undefined,undefined,undefined,
    {areas:pg.areaEpochs,scope:"global-all"});
  assert.deepEqual(check(authorityPage),{ok:true});
  f.db.prepare("UPDATE tasks SET title='Changed in shared Area' WHERE id='s-alice'").run();
  assert.equal(check(authorityPage).reason,"stale");
  const fresh=f.authority.readGlobalTaskPage("carol","all",100,0);
  assert.deepEqual(check(fresh),{ok:true});
  // Empty grant must also invalidate old page even if no new task appears.
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-family','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-family-area','New','shared','new-family','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-family-area','carol','viewer')").run();
  assert.equal(check(fresh).reason,"stale");
  const granted=f.authority.readGlobalTaskPage("carol","all",100,0);
  assert.deepEqual(check(granted),{ok:true});
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(check(granted).reason,"stale");
  assert.deepEqual(ids(page(f,"carol")),["c-carol"]);
  const now=f.authority.readGlobalTaskPage("carol","all",100,0);
  assert.deepEqual(check(now),{ok:true});
  assert.equal(revokeAllDurableTargetStagingSessionsForUser(f.store,"carol").ok,true);
  assert.notEqual(check(now).ok,true);
});
