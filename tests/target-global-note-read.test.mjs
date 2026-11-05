import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m5-global-notes-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const saved=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedGlobalNotePage}=await import("../lib/target-global-note-read-model.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
let count=0;const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
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
  const projects=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  projects.run("family-project","family-area","Shared parent");
  projects.run("hidden-project","hidden-area","Secret parent");
  const notes=db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",null,stage.unassignedAreaId,"Alice private title","Alice private BODY"],
    ["b-bob",null,"bob-private","Bob private title","Bob private BODY"],
    ["c-carol",null,"carol-private","Carol private title","Carol private BODY"],
    ["e-erin",null,"erin-private","Erin secret","Erin secret BODY"],
    ["s-child","family-project",null,"Inherited shared note","Inherited BODY"],
    ["s-direct",null,"family-area","Shared standalone note","Shared BODY"],
    ["s-hidden","hidden-project",null,"Hidden note","Hidden BODY"],
  ])notes.run(...row);
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const f={stage,store,reader,db,authority};fixtures.push(f);return f;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(saved===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=saved;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function page(f,who="bob",scope="all",extra={}){
  return readAuthorizedGlobalNotePage(f.reader,{
    actorUserId:who,scope,limit:100,offset:0,
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
}
const ids=p=>p.notes.map(x=>x.id);
const guard=(f,tokenHash,observed)=>durable.verifyTargetStagingReadLive(
  f.store,{tokenHash},observed.linearization,Date.now(),
  undefined,undefined,undefined,undefined,undefined,
  {areas:observed.areaEpochs,scope:observed.scope==="all"?"global-all":observed.scope,
    noteAreaEpochs:observed.noteAreaEpochs});

test("Vše includes actor-private and every readable shared note, including viewer and project inheritance",()=>{
  const f=fixture();
  assert.deepEqual(ids(page(f)),["b-bob","s-child","s-direct"]);
  assert.deepEqual(ids(page(f,"bob","personal")),["b-bob"]);
  assert.deepEqual(ids(page(f,"bob","shared")),["s-child","s-direct"]);
  assert.deepEqual(ids(page(f,"carol")),["c-carol","s-child","s-direct"]);
  assert.deepEqual(ids(page(f,"alice")),["a-alice","s-child","s-direct"]);
  assert.deepEqual(ids(page(f,"erin")),["e-erin","s-hidden"]);
  assert.deepEqual(ids(page(f,"absent")),[]);
  const body=JSON.stringify(page(f).notes);
  for(const text of ["Alice private","Erin secret","Inherited BODY","Shared BODY","Bob private BODY"])
    assert.equal(body.includes(text),false,text);
  assert.deepEqual(page(f).notes.find(x=>x.id==="s-child"),{
    id:"s-child",title:"Inherited shared note",projectId:"family-project",
    areaId:"family-area",areaKind:"shared",revision:0,
  });
  assert.ok(page(f,"carol").areaEpochs.some(x=>
    x.areaId==="family-area"&&x.access==="viewer"));
});

test("stable cross-Area BINARY pagination and complete Area witness",()=>{
  const f=fixture(),all=ids(page(f));
  const sequence=[];
  for(let offset=0;offset<=all.length;offset++){
    const p=page(f,"bob","all",{limit:1,offset});
    assert.deepEqual(ids(p),all.slice(offset,offset+1));
    assert.equal(p.hasMore,offset+1<all.length);
    assert.equal(p.noteAreaEpochs.length,p.areaEpochs.length);
    assert.deepEqual(p.noteAreaEpochs.map(x=>x.areaId),
      p.areaEpochs.map(x=>x.areaId));
    assert.equal(p.revision,page(f).revision);
    sequence.push(...ids(p));
  }
  assert.deepEqual(sequence,all);
  assert.deepEqual(ids(page(f,"carol","shared",{limit:1,offset:1})),["s-direct"]);
});

test("note-specific revisions invalidate correct scopes, without exposing body",()=>{
  const f=fixture();
  const before={all:page(f).revision,shared:page(f,"bob","shared").revision,
    personal:page(f,"bob","personal").revision};
  f.db.prepare("UPDATE notes SET body='Alice edited' WHERE id='a-alice'").run();
  assert.equal(page(f).revision,before.all);
  assert.equal(page(f,"bob","shared").revision,before.shared);
  f.db.prepare("UPDATE notes SET title='New shared title' WHERE id='s-child'").run();
  assert.notEqual(page(f).revision,before.all);
  assert.notEqual(page(f,"bob","shared").revision,before.shared);
  assert.equal(page(f,"bob","personal").revision,before.personal);
  const revision=page(f).revision;
  f.db.prepare("UPDATE notes SET title='Inherited shared note' WHERE id='s-child'").run();
  assert.notEqual(page(f).revision,revision,"content ABA must advance note epoch");
  const beforeParent=page(f,"bob","shared").revision;
  f.db.prepare("UPDATE projects SET title='Parent changed' WHERE id='family-project'").run();
  assert.notEqual(page(f,"bob","shared").revision,beforeParent,
    "a project mutation affects the inherited parent witness");
});

test("malformed parameters fail closed",()=>{
  const f=fixture();
  for(const patch of [
    {actorUserId:""},{actorUserId:"bob OR 1=1"},
    {scope:"my-plan"},{scope:"everything"},
    {limit:0},{limit:101},{limit:1.2},
    {offset:-1},{offset:1.2},{offset:1_000_001},
    {restoreGeneration:"bad"}
  ])assert.equal(page(f,"bob","all",patch),null,JSON.stringify(patch));
});

test("actor-bound staging read and same-transaction LIVE note epoch/role guard",()=>{
  const f=fixture();
  const issued=durable.issueDurableTargetStagingSession(f.store,"carol",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const before=f.authority.readGlobalNotePage("carol","all",100,0);
  assert.ok(before,"canonical preflight must pass");
  assert.deepEqual(ids(before),ids(page(f,"carol")));
  assert.equal(guard(f,hash,before).ok,true);
  f.db.prepare("UPDATE notes SET body='Changed after snapshot' WHERE id='s-child'").run();
  assert.equal(guard(f,hash,before).reason,"stale",
    "note_sync_revision must be live checked, not only task epochs");
  const after=f.authority.readGlobalNotePage("carol","all",100,0);
  assert.ok(after);assert.equal(guard(f,hash,after).ok,true);
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-ws','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-area','Empty','shared','new-ws','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-area','carol','viewer')").run();
  assert.equal(guard(f,hash,after).reason,"stale");
  const gained=f.authority.readGlobalNotePage("carol","all",100,0);
  assert.ok(gained);assert.deepEqual(ids(gained),ids(after));
  assert.ok(gained.noteAreaEpochs.some(x=>x.areaId==="new-area"));
  assert.equal(guard(f,hash,gained).ok,true);
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(guard(f,hash,gained).reason,"stale");
  assert.deepEqual(ids(page(f,"carol")),["c-carol"]);
  const revoked=f.authority.readGlobalNotePage("carol","all",100,0);
  assert.ok(revoked);assert.equal(guard(f,hash,revoked).ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"carol").ok,true);
  assert.notEqual(guard(f,hash,revoked).ok,true);
});

test("live note guard rejects incomplete or forged note Area epoch witnesses",()=>{
  const f=fixture();
  const issued=durable.issueDurableTargetStagingSession(f.store,"bob",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const before=f.authority.readGlobalNotePage("bob","all",100,0);
  assert.ok(before);assert.equal(guard(f,hash,before).ok,true);
  for(const forged of [
    {...before,noteAreaEpochs:before.noteAreaEpochs.slice(1)},
    {...before,noteAreaEpochs:before.noteAreaEpochs.map((x,i)=>
      i===0?{...x,noteSyncRevision:-1}:x)},
    {...before,noteAreaEpochs:before.noteAreaEpochs.map((x,i)=>
      i===0?{...x,areaId:"unrelated"}:x)},
  ])assert.equal(guard(f,hash,forged).ok,false);
});
