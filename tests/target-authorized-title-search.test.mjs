import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d4a-title-search-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"untouched");
const saved=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedTitleSearchPage,validAuthorizedTitleQuery}=
  await import("../lib/target-authorized-title-search.ts");
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
    ["a-alice",stage.unassignedAreaId,"Alice private project"],
    ["b-bob","bob-private","Bob private project"],
    ["c-carol","carol-private","Carol private project"],
    ["e-erin","erin-private","Erin secret project"],
    ["s-empty","family-area","Shared empty project"],
    ["s-shared","family-area","Shared project"],
    ["z-hidden","hidden-area","Erin hidden project"],
  ])project.run(...row);
  const task=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private task"],
    ["b-bob","bob-private",null,"Bob private task"],
    ["c-carol","carol-private",null,"Carol private task"],
    ["e-erin","erin-private",null,"Erin secret task"],
    ["s-shared",null,"s-shared","Shared unassigned task"],
    ["z-hidden",null,"z-hidden","Erin hidden task"],
    ["wild",null,"s-shared","100% Shared _plan!"],
  ])task.run(...row);
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private note","Alice BODY secret"],
    ["b-bob","bob-private",null,"Bob private note","Bob BODY secret"],
    ["c-carol","carol-private",null,"Carol private note","Carol BODY secret"],
    ["e-erin","erin-private",null,"Erin secret note","Erin BODY secret"],
    ["s-shared",null,"s-shared","Shared inherited note","Shared BODY secret"],
    ["z-hidden",null,"z-hidden","Erin hidden note","Erin BODY secret"],
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
const page=(f,who="bob",scope="all",query="Shared",extra={})=>
  readAuthorizedTitleSearchPage(f.reader,{
    actorUserId:who,scope,query,limit:50,offset:0,
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
const labels=p=>p.items.map(i=>i.kind+":"+i.id);
const guard=(f,hash,p)=>durable.verifyTargetStagingReadLive(
  f.store,{tokenHash:hash},p.linearization,Date.now(),
  undefined,undefined,undefined,undefined,undefined,
  {areas:p.areaEpochs,scope:p.scope==="all"?"global-all":p.scope,
    noteAreaEpochs:p.noteAreaEpochs},
);

test("actor/Area SQL ACL before LIMIT, mixed types and inherited Area",()=>{
  const f=fixture();
  assert.deepEqual(labels(page(f)),[
    "project:s-empty","project:s-shared","task:s-shared",
    "note:s-shared","task:wild",
  ]);
  assert.deepEqual(labels(page(f,"carol","shared")),labels(page(f)));
  assert.deepEqual(labels(page(f,"bob","personal","Bob")),[
    "project:b-bob","task:b-bob","note:b-bob",
  ]);
  assert.deepEqual(labels(page(f,"bob","shared","Bob")),[]);
  assert.deepEqual(labels(page(f,"bob","all","Erin")),[]);
  assert.deepEqual(labels(page(f,"erin","all","Erin")),[
    "project:e-erin","task:e-erin","note:e-erin",
    "project:z-hidden","task:z-hidden","note:z-hidden",
  ]);
  assert.deepEqual(labels(page(f,"bob","all","BODY")),[],
    "note bodies must never be searched or released");
  const body=JSON.stringify(page(f));
  for(const secret of ["Erin","Alice","BODY secret","owner_user_id"])
    assert.equal(body.includes(secret),false,secret);
  const note=page(f).items.find(i=>i.kind==="note");
  assert.equal(note.projectId,"s-shared");
  assert.equal(note.areaId,"family-area");
  const prj=page(f).items.find(i=>i.kind==="project");
  assert.equal("projectId" in prj,false);
});

test("literal wildcard escaping, deterministic BINARY pagination and case",()=>{
  const f=fixture();
  assert.deepEqual(labels(page(f,"bob","all","100%")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","_plan")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","an!")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","%_")),[]);
  assert.deepEqual(labels(page(f,"bob","all","sHaReD")),labels(page(f)));
  const expected=labels(page(f));
  for(const limit of [1,2,3,4]){
    let offset=0,found=[],revision=null;
    for(let i=0;i<10;i++){
      const p=page(f,"bob","all","Shared",{limit,offset});
      assert.ok(p);
      found.push(...labels(p));
      if(revision)assert.equal(p.revision,revision);
      revision=p.revision;
      if(!p.hasMore){
        assert.equal(p.nextOffset,null);
        break;
      }
      assert.equal(p.nextOffset,offset+p.items.length);
      offset=p.nextOffset;
    }
    assert.deepEqual(found,expected);
  }
});

test("strict input validation and no direct actor-based HTTP exposure",()=>{
  const f=fixture();
  for(const q of ["","x"," Shared","Shared ","a".repeat(81),
    "some\nquery","hi\u0000there","\ud800invalid"])
    assert.equal(validAuthorizedTitleQuery(q),false,q);
  assert.equal(validAuthorizedTitleQuery("100%"),true);
  assert.equal(validAuthorizedTitleQuery("%_"),true);
  for(const override of [
    {actorUserId:"bob' OR 1=1"},{actorUserId:""},
    {scope:"my-plan"},{query:"x"},{query:" Shared"},
    {limit:0},{limit:51},{limit:1.1},{offset:-1},
    {offset:1_000_001},{offset:0.25},{restoreGeneration:"wrong"},
  ])assert.equal(page(f,"bob","all","Shared",override),null,JSON.stringify(override));
});

test("signed staging authority, complete live ACL and note-sync epoch fences",()=>{
  const f=fixture();
  const issued=durable.issueDurableTargetStagingSession(f.store,"carol",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const before=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.ok(before);
  assert.deepEqual(labels(before),labels(page(f,"carol")));
  assert.equal(guard(f,hash,before).ok,true);
  // A body-only edit must invalidate even a title-only search.
  f.db.prepare("UPDATE notes SET body='changed only in body' WHERE id='s-shared'").run();
  assert.equal(guard(f,hash,before).reason,"stale");
  const after=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.notEqual(after.revision,before.revision);
  assert.equal(guard(f,hash,after).ok,true);
  // Gaining an EMPTY Area must also stale the previous witness.
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('fresh-ws','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('fresh-area','Fresh','shared','fresh-ws','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','carol','viewer')").run();
  assert.equal(guard(f,hash,after).reason,"stale");
  const gained=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.deepEqual(labels(gained),labels(after));
  assert.equal(guard(f,hash,gained).ok,true);
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(guard(f,hash,gained).reason,"stale");
  const revoked=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.deepEqual(labels(revoked),[]);
  assert.equal(guard(f,hash,revoked).ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"carol").ok,true);
  assert.notEqual(guard(f,hash,revoked).ok,true);
  f.authority.close();
  assert.equal(f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0),null);
});
