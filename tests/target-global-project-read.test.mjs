import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m3-global-projects-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const previous=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;

const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedGlobalProjectPage}=await import("../lib/target-global-project-read-model.ts");
const {readAuthorizedProjectIndexPage}=await import("../lib/target-authorized-project-index.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {
  issueDurableTargetStagingSession,hashTargetStagingSessionToken,
  verifyTargetStagingReadLive,revokeAllDurableTargetStagingSessionsForUser,
}=await import("../lib/target-staging-durable-session.ts");

const fixtures=[];let counter=0;
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++counter)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [ws,who] of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(ws,who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,who);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  const put=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"Alice private secret"],
    ["b-bob","bob-private","Bob private"],
    ["c-carol","carol-private","Carol private"],
    ["e-erin","erin-private","Erin private secret"],
    ["s-family","family-area","Family project, no assignments"],
    ["s-empty","family-area","Empty shared project"],
    ["s-hidden","hidden-area","Hidden shared project"],
  ])put.run(...row);
  // No tasks are assigned to Bob in either shared project. They must still
  // appear in global Vše, but NOT in the personal My Plan project index.
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const f={stage,store,reader,db,authority};fixtures.push(f);return f;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(previous===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=previous;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function page(f,who="bob",scope="all",extra={}){
  return readAuthorizedGlobalProjectPage(f.reader,{
    actorUserId:who,scope,limit:100,offset:0,
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}
const ids=p=>p.projects.map(x=>x.id);

test("global Vše includes private and all readable shared projects, even empty viewer projects",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f)),["b-bob","s-empty","s-family"]);
  assert.deepEqual(ids(page(f,"bob","personal")),["b-bob"]);
  assert.deepEqual(ids(page(f,"bob","shared")),["s-empty","s-family"]);
  assert.deepEqual(ids(page(f,"carol")),["c-carol","s-empty","s-family"]);
  assert.deepEqual(ids(page(f,"alice")),["a-alice","s-empty","s-family"]);
  assert.deepEqual(ids(page(f,"erin")),["e-erin","s-hidden"]);
  assert.deepEqual(ids(readAuthorizedProjectIndexPage(f.reader,{
    actorUserId:"bob",scope:"my-plan",restoreGeneration:f.stage.restoreGeneration,
    limit:100,offset:0,
  })),["b-bob"]);
});

test("global project DTO contains only project and effective Area fields",()=>{
  const f=fixture(),bob=page(f);
  assert.ok(!JSON.stringify(bob.projects).includes("Alice private secret"));
  assert.ok(!JSON.stringify(bob.projects).includes("Erin private secret"));
  assert.deepEqual(bob.projects.find(p=>p.id==="s-family"),{
    id:"s-family",title:"Family project, no assignments",
    areaId:"family-area",areaKind:"shared",
  });
  assert.ok(bob.projects.every(x=>Object.keys(x).sort().join(",")===
    "areaId,areaKind,id,title"));
  assert.ok(bob.areaEpochs.some(a=>a.areaId==="family-area"&&a.access==="editor"));
  assert.ok(page(f,"carol").areaEpochs.some(a=>
    a.areaId==="family-area"&&a.access==="viewer"));
});

test("BINARY pagination crosses Area boundaries without duplicate or omitted rows",()=>{
  const f=fixture(),all=ids(page(f));
  const combined=[];
  for(let offset=0;offset<all.length;offset++){
    const current=page(f,"bob","all",{limit:1,offset});
    assert.deepEqual(ids(current),[all[offset]]);
    assert.equal(current.hasMore,offset+1<all.length);
    combined.push(...ids(current));
  }
  assert.deepEqual(combined,all);
  assert.deepEqual(ids(page(f,"carol","shared",{offset:1,limit:1})),["s-family"]);
});

test("malformed actor, scope, generation, limit and offset fail closed",()=>{
  const f=fixture();
  for(const invalid of [
    {actorUserId:""},{actorUserId:"bob OR 1=1"},
    {scope:"my-plan"},{scope:"everything"},
    {limit:0},{limit:101},{limit:1.5},
    {offset:-1},{offset:1.5},{offset:1_000_001},
    {restoreGeneration:"not-a-uuid"},
  ])assert.equal(page(f,"bob","all",invalid),null,JSON.stringify(invalid));
  assert.deepEqual(ids(page(f,"not-a-user")),[]);
});

test("revision captures project edits, not unrelated actor-private projects",()=>{
  const f=fixture();
  const beforeAll=page(f).revision;
  const beforeShared=page(f,"bob","shared").revision;
  const beforePrivate=page(f,"bob","personal").revision;
  f.db.prepare("UPDATE projects SET title='Alice changed' WHERE id='a-alice'").run();
  assert.equal(page(f).revision,beforeAll);
  assert.equal(page(f,"bob","shared").revision,beforeShared);
  f.db.prepare("UPDATE projects SET title='Shared changed' WHERE id='s-family'").run();
  assert.notEqual(page(f).revision,beforeAll);
  assert.notEqual(page(f,"bob","shared").revision,beforeShared);
  assert.equal(page(f,"bob","personal").revision,beforePrivate);
});

test("actor-bound canonical staging authority and live guard reject stale ACL and membership",()=>{
  const f=fixture();
  const first=f.authority.readGlobalProjectPage("carol","all",100,0);
  assert.deepEqual(ids(first),ids(page(f,"carol")));
  assert.equal(f.authority.readGlobalProjectPage("carol","my-plan",100,0),null);
  assert.equal(f.authority.readGlobalProjectPage("fake actor","all",100,0),null);
  const issued=issueDurableTargetStagingSession(f.store,"carol",600);
  assert.equal(issued.ok,true);
  const tokenHash=hashTargetStagingSessionToken(issued.sessionToken);
  const guard=p=>verifyTargetStagingReadLive(f.store,{tokenHash},
    p.linearization,Date.now(),undefined,undefined,undefined,undefined,
    undefined,{areas:p.areaEpochs,scope:"global-all"});
  assert.deepEqual(guard(first),{ok:true});
  f.db.prepare("UPDATE projects SET title='After snapshot' WHERE id='s-family'").run();
  assert.equal(guard(first).reason,"stale");
  const current=f.authority.readGlobalProjectPage("carol","all",100,0);
  assert.deepEqual(guard(current),{ok:true});
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-shared','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-area','New','shared','new-shared','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-area','carol','viewer')").run();
  assert.equal(guard(current).reason,"stale");
  const withEmpty=f.authority.readGlobalProjectPage("carol","all",100,0);
  assert.deepEqual(guard(withEmpty),{ok:true});
  assert.deepEqual(ids(current),ids(withEmpty));
  assert.ok(withEmpty.areaEpochs.some(a=>a.areaId==="new-area"));
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(guard(withEmpty).reason,"stale");
  assert.deepEqual(ids(page(f,"carol")),["c-carol"]);
  const afterRevocation=f.authority.readGlobalProjectPage("carol","all",100,0);
  assert.deepEqual(guard(afterRevocation),{ok:true});
  assert.equal(revokeAllDurableTargetStagingSessionsForUser(f.store,"carol").ok,true);
  assert.notEqual(guard(afterRevocation).ok,true);
});
