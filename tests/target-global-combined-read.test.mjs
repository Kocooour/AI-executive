import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m7-global-combined-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"untouched");
const saved=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedGlobalCombinedPage,INITIAL_GLOBAL_COMBINED_POSITIONS}=
  await import("../lib/target-global-combined-read-model.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
let serial=0;const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [ws,who]of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(ws,who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,who);
  }
  for(const [area,who,role]of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  const project=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"ALICE PRIVATE PROJECT"],
    ["b-bob","bob-private","Bob private project"],
    ["c-carol","carol-private","Carol private project"],
    ["e-erin","erin-private","ERIN PRIVATE PROJECT"],
    ["s-empty","family-area","Empty shared project"],
    ["s-shared","family-area","Shared project"],
    ["z-hidden","hidden-area","ERIN SHARED PROJECT"],
  ])project.run(...row);
  const task=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"ALICE PRIVATE TASK"],
    ["b-bob","bob-private",null,"Bob private task"],
    ["c-carol","carol-private",null,"Carol private task"],
    ["e-erin","erin-private",null,"ERIN PRIVATE TASK"],
    ["s-shared",null,"s-shared","Shared unassigned task"],
    ["z-hidden",null,"z-hidden","ERIN SHARED TASK"],
  ])task.run(...row);
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"ALICE PRIVATE NOTE","ALICE PRIVATE BODY"],
    ["b-bob","bob-private",null,"Bob private note","BOB PRIVATE BODY"],
    ["c-carol","carol-private",null,"Carol private note","CAROL PRIVATE BODY"],
    ["e-erin","erin-private",null,"ERIN PRIVATE NOTE","ERIN PRIVATE BODY"],
    ["s-shared",null,"s-shared","Shared inherited note","SHARED BODY NEVER EXPOSE"],
    ["z-hidden",null,"z-hidden","ERIN SHARED NOTE","ERIN SHARED BODY"],
  ])note.run(...row);
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const f={stage,store,db,reader,authority};fixtures.push(f);return f;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(saved===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=saved;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"untouched");
  rmSync(root,{recursive:true,force:true});
});
const positions=()=>({...INITIAL_GLOBAL_COMBINED_POSITIONS});
const page=(f,who="bob",scope="all",extra={})=>
  readAuthorizedGlobalCombinedPage(f.reader,{
    actorUserId:who,scope,limit:100,positions:positions(),
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
const labels=p=>p.items.map(i=>i.kind+":"+i.item.id);
const guard=(f,tokenHash,p)=>durable.verifyTargetStagingReadLive(
  f.store,{tokenHash},p.linearization,Date.now(),
  undefined,undefined,undefined,undefined,undefined,
  {areas:p.areaEpochs,scope:p.scope==="all"?"global-all":p.scope,
    noteAreaEpochs:p.noteAreaEpochs},
);

test("one Vše page includes authorized tasks, empty projects and inherited notes",()=>{
  const f=fixture();
  assert.deepEqual(labels(page(f)),[
    "project:b-bob","task:b-bob","note:b-bob",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared",
  ]);
  assert.deepEqual(labels(page(f,"bob","personal")),[
    "project:b-bob","task:b-bob","note:b-bob",
  ]);
  assert.deepEqual(labels(page(f,"bob","shared")),[
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared",
  ]);
  assert.deepEqual(labels(page(f,"carol")),[
    "project:c-carol","task:c-carol","note:c-carol",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared",
  ]);
  assert.deepEqual(labels(page(f,"erin")),[
    "project:e-erin","task:e-erin","note:e-erin",
    "project:z-hidden","task:z-hidden","note:z-hidden",
  ]);
  assert.deepEqual(labels(page(f,"nonexistent")),[]);
  const payload=JSON.stringify(page(f).items);
  for(const forbidden of ["ALICE","ERIN","SHARED BODY","BOB PRIVATE BODY",
    "CAROL PRIVATE BODY","members","owner_user_id"])
    assert.equal(payload.includes(forbidden),false,forbidden);
  const note=page(f).items.find(i=>i.kind==="note"&&i.item.id==="s-shared");
  assert.equal(note.item.projectId,"s-shared");
  assert.equal(note.item.areaId,"family-area");
  const task=page(f).items.find(i=>i.kind==="task"&&i.item.id==="s-shared");
  assert.equal(task.item.assignedToMe,false);
});

test("BINARY merged key with kind tie-break and exact per-kind resume",()=>{
  const f=fixture(),expected=labels(page(f));
  for(const limit of [1,2,3,5,7]){
    let pos=positions(),out=[],iterations=0,revision=null;
    while(true){
      const p=page(f,"bob","all",{positions:pos,limit});
      assert.ok(p);
      out.push(...labels(p));
      if(revision!==null)assert.equal(p.revision,revision);
      revision=p.revision;
      if(!p.hasMore){
        assert.equal(p.nextPositions,null);
        break;
      }
      assert.ok(p.nextPositions);
      assert.ok(++iterations<=expected.length,"pagination must terminate");
      for(const key of ["tasks","projects","notes"])
        assert.ok(p.nextPositions[key]>=pos[key]);
      pos=p.nextPositions;
    }
    assert.deepEqual(out,expected,"limit="+limit);
  }
  assert.deepEqual(labels(page(f,"carol","shared",{limit:1,
    positions:{projects:2,tasks:0,notes:0}})),["task:s-shared"]);
});

test("revision includes complete Area + note epochs, scoped and actor-bound",()=>{
  const f=fixture();
  const all=page(f),shared=page(f,"bob","shared"),
    personal=page(f,"bob","personal");
  assert.equal(all.areaEpochs.length,all.noteAreaEpochs.length);
  assert.deepEqual(all.areaEpochs.map(x=>x.areaId),
    all.noteAreaEpochs.map(x=>x.areaId));
  assert.ok(all.areaEpochs.some(x=>x.areaId==="family-area"&&x.access==="editor"));
  assert.notEqual(all.revision,page(f,"carol").revision);
  f.db.prepare("UPDATE notes SET body='body-only edit' WHERE id='s-shared'").run();
  assert.notEqual(page(f).revision,all.revision);
  assert.notEqual(page(f,"bob","shared").revision,shared.revision);
  assert.equal(page(f,"bob","personal").revision,personal.revision);
  const changed=page(f).revision;
  f.db.prepare("UPDATE notes SET body='SHARED BODY NEVER EXPOSE' WHERE id='s-shared'").run();
  assert.notEqual(page(f).revision,changed,"ABA note edit must advance revision");
});

test("malformed scope, positions and generation fail closed",()=>{
  const f=fixture();
  for(const override of [
    {actorUserId:""},{actorUserId:"bob OR 1=1"},
    {scope:"my-plan"},{limit:0},{limit:101},{limit:1.5},
    {positions:null},{positions:{tasks:0,projects:0}},
    {positions:{tasks:0,projects:0,notes:0,actor:"erin"}},
    {positions:{tasks:-1,projects:0,notes:0}},
    {positions:{tasks:0,projects:1.5,notes:0}},
    {positions:{tasks:0,projects:0,notes:1_000_001}},
    {restoreGeneration:"untrusted"},
  ])assert.equal(page(f,"bob","all",override),null,JSON.stringify(override));
});

test("signed authority pins all three types in one snapshot and full LIVE fence",()=>{
  const f=fixture();
  const issued=durable.issueDurableTargetStagingSession(f.store,"carol",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const before=f.authority.readGlobalCombinedPage("carol","all",100,positions());
  assert.ok(before);
  assert.deepEqual(labels(before),labels(page(f,"carol")));
  assert.equal(guard(f,hash,before).ok,true);
  f.db.prepare("UPDATE notes SET title='changed after snapshot' WHERE id='s-shared'").run();
  assert.equal(guard(f,hash,before).reason,"stale");
  const after=f.authority.readGlobalCombinedPage("carol","all",100,positions());
  assert.ok(after);assert.equal(guard(f,hash,after).ok,true);
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('fresh-ws','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('fresh-area','New empty shared Area','shared','fresh-ws','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','carol','viewer')").run();
  assert.equal(guard(f,hash,after).reason,"stale");
  const gained=f.authority.readGlobalCombinedPage("carol","all",100,positions());
  assert.ok(gained);
  assert.deepEqual(labels(gained),labels(after));
  assert.ok(gained.noteAreaEpochs.some(x=>x.areaId==="fresh-area"));
  assert.equal(guard(f,hash,gained).ok,true);
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(guard(f,hash,gained).reason,"stale");
  const revoked=f.authority.readGlobalCombinedPage("carol","all",100,positions());
  assert.ok(revoked);
  assert.deepEqual(labels(revoked),[
    "project:c-carol","task:c-carol","note:c-carol",
  ]);
  assert.equal(guard(f,hash,revoked).ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"carol").ok,true);
  assert.notEqual(guard(f,hash,revoked).ok,true);
});
