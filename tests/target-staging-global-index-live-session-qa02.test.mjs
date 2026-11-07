/** QA-02: full staging GET -> transport -> BE-17 chain -> BE-18/19 session.
 * All identities/stores/cookies below are synthetic and isolated from legacy. */
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const names=[
  "NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-qa02-global-live-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"keep-existing-data");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"qa02-isolated-global-index-session-secret-20261107",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {GET}=await import("../app/api/target-staging/global-index/route.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {createGlobalIndexReadSession}=
  await import("../lib/target-staging-global-index-read-session.ts");

let serial=0;
const databases=[];
after(()=>{
  for(const db of databases)db.close();
  for(const [name,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[name];
    else process.env[name]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),
    "keep-existing-data","legacy store not touched");
  rmSync(root,{recursive:true,force:true});
});

function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","eve"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [id,owner] of [["family","alice"],["hidden","eve"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(id,owner);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(id+"-area",id,id,owner);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","eve","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  const project=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"Alice private project"],
    ["b-bob","bob-private","Bob private project"],
    ["c-carol","carol-private","Carol private project"],
    ["e-eve","eve-private","Eve private project"],
    ["s-empty","family-area","Shared empty project"],
    ["s-shared","family-area","Shared project"],
    ["z-hidden","hidden-area","Hidden project"],
  ])project.run(...row);
  const task=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private task"],
    ["b-bob","bob-private",null,"Bob private task"],
    ["c-carol","carol-private",null,"Carol private task"],
    ["e-eve","eve-private",null,"Eve private task"],
    ["s-shared",null,"s-shared","Unassigned shared task"],
    ["z-hidden",null,"z-hidden","Hidden task"],
  ])task.run(...row);
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private note","ALICE PRIVATE BODY"],
    ["b-bob","bob-private",null,"Bob private note","BOB PRIVATE BODY"],
    ["c-carol","carol-private",null,"Carol private note","CAROL PRIVATE BODY"],
    ["e-eve","eve-private",null,"Eve private note","EVE PRIVATE BODY"],
    ["s-shared",null,"s-shared","Shared note title","SHARED PRIVATE BODY"],
    ["z-hidden",null,"z-hidden","Hidden note","HIDDEN PRIVATE BODY"],
  ])note.run(...row);
  const store={
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  };
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return{stage,db,store};
}
function cookie(f,actor){
  const session=durable.issueDurableTargetStagingSession(f.store,actor,900);
  assert.equal(session.ok,true,JSON.stringify(session));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+session.sessionToken;
}
const owner=()=>sessionCookieName+"="+createSessionToken();
const endpoint="http://localhost:3001/api/target-staging/global-index";
/** Only an in-process HTTP adapter; all route auth, HMAC and child reads are REAL. */
function adapter(currentCookie,counter){
  return async(url,init)=>{
    counter.count++;
    assert.equal(init.method,"GET");
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    const target=new URL(url,"http://localhost:3001");
    assert.equal(target.origin,"http://localhost:3001");
    assert.equal(target.pathname,"/api/target-staging/global-index");
    assert.equal(target.searchParams.has("actor"),false);
    assert.equal(target.searchParams.has("areaId"),false);
    const response=await GET(new Request(endpoint+target.search,{
      signal:init.signal,
      headers:{cookie:currentCookie(),"x-forwarded-for":"10.96.4.2"},
    }));
    assert.equal(response.headers.get("cache-control"),"no-store");
    return response;
  };
}
const reader=(currentCookie,count,scope="all",limit=2,getContext=()=>"auth-epoch-1")=>
  createGlobalIndexReadSession({scope,limit,contextVersion:getContext},
    adapter(currentCookie,count));
function labels(snapshot){
  assert.equal(snapshot.status,"ready",JSON.stringify(snapshot));
  return snapshot.page.items.map(({kind,item})=>kind+":"+item.id);
}
function noBodies(snapshot){
  const raw=JSON.stringify(snapshot);
  for(const word of [
    "PRIVATE BODY","SHARED PRIVATE BODY","HIDDEN PRIVATE BODY",
    "policyRevision","areaEpochs","linearization","actorUserId",
  ])assert.ok(!raw.includes(word),"not a public field: "+word);
}
async function all(reader,max=15){
  let result=await reader.loadFirst(),rounds=0;
  assert.equal(result.ok,true,JSON.stringify(result));
  while(result.page.hasMore){
    assert.ok(++rounds<max,"bounded explicit cursor traversal");
    result=await reader.loadMore();
    assert.equal(result.ok,true,JSON.stringify(result));
  }
  return reader.getSnapshot();
}

test("QA-02 real HTTP -> BE19 reader keeps owner, editor and viewer scopes isolated",async()=>{
  const f=fixture();
  const actors=[["alice",owner(),[
    "project:a-alice","task:a-alice","note:a-alice",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared"]],
  ["bob",cookie(f,"bob"),[
    "project:b-bob","task:b-bob","note:b-bob",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared"]],
  ["carol",cookie(f,"carol"),[
    "project:c-carol","task:c-carol","note:c-carol",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared"]]];
  for(const [actor,session,expected] of actors){
    const count={count:0},controller=reader(()=>session,count);
    const snapshot=await all(controller);
    assert.deepEqual(labels(snapshot),expected,actor);
    noBodies(snapshot);
    assert.equal(count.count,4,"2-item real HTTP page limit, no prefetch");
    assert.equal(snapshot.page.hasMore,false);
    controller.dispose();
  }
  const shared=reader(()=>actors[2][1],{count:0},"shared",50);
  const result=await shared.loadFirst();
  assert.equal(result.ok,true);
  assert.deepEqual(labels(shared.getSnapshot()),actors[2][2].slice(3));
  const unassigned=result.page.items.find(x=>x.kind==="task");
  assert.equal(unassigned.item.assignedToMe,false,
    "viewer must see unassigned shared work in global scope");
});

test("QA-02 actor switch after a real first page invalidates old cursor and titles",async()=>{
  const f=fixture(),bob=cookie(f,"bob"),carol=cookie(f,"carol");
  let activeCookie=bob,epoch="account-bob-1";
  const count={count:0};
  const old=reader(()=>activeCookie,count,"all",1,()=>epoch);
  assert.equal((await old.loadFirst()).ok,true);
  assert.deepEqual(labels(old.getSnapshot()),["project:b-bob"]);
  activeCookie=carol;epoch="account-carol-2";
  assert.deepEqual(old.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(await old.loadMore(),{ok:false,reason:"stale"});
  assert.equal(count.count,1,"old reader cannot issue GET under a new actor");
  const fresh=reader(()=>activeCookie,count,"all",1,()=>epoch);
  assert.equal((await fresh.loadFirst()).ok,true);
  assert.deepEqual(labels(fresh.getSnapshot()),["project:c-carol"]);
  epoch="account-bob-1";activeCookie=bob;
  assert.deepEqual(old.getSnapshot(),{status:"failed",reason:"stale"},
    "A-B-A context must not resurrect old Bob titles");
  assert.deepEqual(await old.loadFirst(),{ok:false,reason:"stale"});
  fresh.dispose();
});

test("QA-02 durable session revocation between real pages clears accumulated titles",async()=>{
  const f=fixture(),bob=cookie(f,"bob"),count={count:0};
  const controller=reader(()=>bob,count,"all",1);
  assert.deepEqual(labels((await controller.loadFirst()).ok&&controller.getSnapshot()),
    ["project:b-bob"]);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"bob").ok,true);
  const next=await controller.loadMore();
  assert.equal(next.ok,false);
  assert.ok(["signed-out","stale"].includes(next.reason),JSON.stringify(next));
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:next.reason});
  assert.equal(count.count,2,"one real GET, no retries or partial continuation");
});

test("QA-02 revoked viewer membership after suspend cannot leak old shared rows",async()=>{
  const f=fixture(),carol=cookie(f,"carol"),count={count:0};
  const controller=reader(()=>carol,count,"shared",2);
  assert.equal((await controller.loadFirst()).ok,true);
  assert.deepEqual(labels(controller.getSnapshot()),
    ["project:s-empty","project:s-shared"]);
  controller.suspend();
  assert.deepEqual(controller.getSnapshot(),{status:"suspended"});
  f.db.prepare("DELETE FROM area_members WHERE area_id=? AND user_id=?")
    .run("family-area","carol");
  assert.deepEqual(await controller.loadMore(),{ok:false,reason:"not-ready"});
  assert.equal(controller.resume(),true);
  assert.deepEqual(controller.getSnapshot(),{status:"idle"});
  assert.equal((await controller.loadFirst()).ok,true);
  assert.deepEqual(labels(controller.getSnapshot()),[],
    "new live Area ACL must not publish prior shared project, task or note");
  noBodies(controller.getSnapshot());
  assert.equal(count.count,2,"resume does not fetch; explicit GET revalidates ACL");
});

test("QA-02 body-only note epoch invalidates real HMAC cursor and entire reader",async()=>{
  const f=fixture(),bob=cookie(f,"bob"),count={count:0};
  const controller=reader(()=>bob,count,"all",1);
  assert.equal((await controller.loadFirst()).ok,true);
  assert.deepEqual(labels(controller.getSnapshot()),["project:b-bob"]);
  f.db.prepare("UPDATE notes SET body=? WHERE id=?")
    .run("NEW SHARED PRIVATE BODY","s-shared");
  const stale=await controller.loadMore();
  assert.deepEqual(stale,{ok:false,reason:"stale"});
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.equal(count.count,2,"HMAC note revision conflict, never auto retry");
});

test("QA-02 default-off HTTP flag fails closed through actual reader then explicit reload",async()=>{
  const f=fixture(),bob=cookie(f,"bob"),count={count:0};
  const controller=reader(()=>bob,count,"all",3);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED="false";
  const first=await controller.loadFirst();
  assert.deepEqual(first,{ok:false,reason:"unavailable"});
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"unavailable"});
  assert.equal(count.count,1);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED="true";
  assert.equal((await controller.loadFirst()).ok,true);
  assert.deepEqual(labels(controller.getSnapshot()),
    ["project:b-bob","task:b-bob","note:b-bob"]);
  assert.equal(count.count,2,"flag change does not trigger background GET");
});
