import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const previous=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3k3-personal-when-http-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-private-when-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/task-temporal/personal-when/route.ts");
const {readStagingPersonalWhenInChild,parseStagingPersonalWhenPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");

let n=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [k,v] of Object.entries(previous)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++n)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-area",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)")
      .run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('parent','family-area','Family')").run();
  const task=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["p-alice",stage.unassignedAreaId,null,"Alice secret",null,"2026-03-02"],
    ["p-bob","bob-area",null,"Bob private",null,"2026-11-11"],
    ["p-erin","erin-area",null,"Erin secret",null,null],
    ["s-alice","family-area",null,"Shared Alice","alice",null],
    ["s-z-first","family-area",null,"Earlier date later ID","bob","2026-12-01"],
    ["s-a-later","family-area",null,"Later date earlier ID","bob","2026-12-02"],
    ["s-child",null,"parent","Project child","bob",null],
    ["s-unassigned","family-area",null,"Unassigned",null,null],
  ])task.run(...row);
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["alice","p-alice","2026-11-04"],
    ["alice","s-alice","2026-11-05"],
    ["bob","p-bob","2026-11-04"],
    ["bob","s-z-first","2026-11-05"],
    ["bob","s-a-later","2026-11-07"],
    ["bob","s-child","2026-11-09"],
    ["erin","p-erin","2026-11-04"],
  ])plan.run(...row);
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={db,stage,store};fixtures.push(fx);return fx;
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(f,who){
  const x=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(x.ok,true,JSON.stringify(x));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+x.sessionToken;
}
const base="http://localhost:3001/api/target-staging/task-temporal/personal-when";
function params(window="all",evaluationDate=null,throughDate=null,limit=null){
  const p=new URLSearchParams({window});
  if(evaluationDate!==null)p.set("evaluationDate",evaluationDate);
  if(throughDate!==null)p.set("throughDate",throughDate);
  if(limit!==null)p.set("limit",String(limit));
  return "?"+p.toString();
}
const request=(query,cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.58.1"},
});
const get=(query,cookie=owner())=>GET(request(query,cookie));
const ids=body=>body.plans.map(x=>x.taskId);
async function ok(result){
  const res=await result,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.equal(Object.keys(body).sort().join(","),
    "evaluationDate,hasMore,nextCursor,plans,throughDate,window");
  for(const row of body.plans){
    assert.deepEqual(Object.keys(row).sort(),["revision","taskId","whenOn"]);
    assert.equal("title" in row,false);
    assert.equal("dueOn" in row,false);
  }
  return body;
}

test("independent default-off gate and real identity required",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get(params())).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+params()))).status,401);
  const page=await ok(get(params()));
  assert.deepEqual(ids(page),["p-alice","s-alice"]);
  assert.equal(page.window,"all");
  assert.equal(page.evaluationDate,null);
  assert.equal(page.throughDate,null);
  assert.ok(!JSON.stringify(page).includes("privateEpoch"));
  assert.ok(!JSON.stringify(page).includes("linearization"));
  assert.ok(!JSON.stringify(page).includes("Erin secret"));
});

test("strict GET filters reject duplication, invalid day, untrusted identity and offset",async()=>{
  fixture();
  for(const query of [
    "","?window=other",params("all","2026-11-04"),
    params("on-day"),params("on-day","2026-02-29"),
    params("on-day","2026-11-04","2026-11-05"),
    params("upcoming"),params("upcoming","2026-11-04"),
    params("upcoming","2026-11-04","2026-11-04"),
    params("upcoming","2026-11-04","2026-11-03"),
    params("upcoming","2026-11-04","2027-11-04"),
    params("upcoming","2026-11-04","2026-02-29"),
    params("on-day","2026-11-04T00:00:00Z"),
    params()+"&actor=bob",params()+"&userId=bob",
    params()+"&offset=1",params()+"&limit=0",params()+"&limit=101",
    params()+"&limit=01",params()+"&cursor=nope",
    "?window=all&window=all","?window=all&limit=1&limit=2",
    "?window=all&cursor=a%00b",
  ]) assert.equal((await get(query)).status,400,query);
});

test("owner, editor, viewer and private user only read own plans; date before ID",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get(params(),bob))),
    ["p-bob","s-z-first","s-a-later","s-child"]);
  assert.deepEqual(ids(await ok(get(params("on-day","2026-11-04"),bob))),["p-bob"]);
  assert.deepEqual(ids(await ok(get(params("upcoming","2026-11-04","2026-11-10"),bob))),
    ["s-z-first","s-a-later","s-child"]);
  assert.deepEqual(ids(await ok(get(params(),carol))),[]);
  assert.deepEqual(ids(await ok(get(params(),erin))),["p-erin"]);
  assert.deepEqual(ids(await ok(get(params("upcoming","2026-11-04","2026-11-05"))),
    ["s-alice"]);
});

test("signed continuation isolated by actor/session and all private query dimensions",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const q=params("upcoming","2026-11-04","2026-11-10",1);
  const first=await ok(get(q,bob));
  assert.deepEqual(ids(first),["s-z-first"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(ids(await ok(get(q+token,bob))),["s-a-later"]);
  for(const alternate of [
    params("upcoming","2026-11-04","2026-11-11",1),
    params("upcoming","2026-11-05","2026-11-10",1),
    params("upcoming","2026-11-04","2026-11-10",2),
    params("on-day","2026-11-04",null,1),
    params("all",null,null,1),
  ])assert.equal((await get(alternate+token,bob)).status,400,alternate);
  assert.equal((await get(q+token,carol)).status,400);
  assert.equal((await get(q+token,owner())).status,400);
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='s-a-later'").run();
  assert.equal((await get(q+token,bob)).status,409);
  // Alice's cursor is independent from Bob's planning mutations.
  const aliceQuery=params("all",null,null,1);
  const aliceFirst=await ok(get(aliceQuery));
  assert.deepEqual(ids(await ok(get(aliceQuery+"&cursor="+encodeURIComponent(aliceFirst.nextCursor)))),
    ["s-alice"]);
});

test("revoked durable session cannot replay private cursor",async()=>{
  const f=fixture(),bob=login(f,"bob"),q=params("all",null,null,1);
  const first=await ok(get(q,bob));
  assert.ok(first.nextCursor);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.equal((await get(q+"&cursor="+encodeURIComponent(first.nextCursor),bob)).status,401);
});

test("live read refuses private epoch and Area revocation after pinned child snapshot",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const page=await readStagingPersonalWhenInChild({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:tokenHash,
  },"all",null,null,100,0);
  assert.ok(page);
  const verify=()=>verifyStagingReadBeforeRelease(request(params(),bob),
    {kind:"session",tokenHash},f.store,"alice",page.linearization,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {privateEpoch:page.privateEpoch});
  assert.equal(verify(),"ok");
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='s-z-first'").run();
  assert.equal(verify(),"stale");
  // Area membership changes require all assignments to be cleared first.
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(verify(),"stale");
  assert.deepEqual(ids(await ok(get(params(),bob))),["p-bob"]);
});

test("child DTO rejects injected fields, other calendar windows and unsorted plans",()=>{
  const area={areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0};
  const one={taskId:"z-first",whenOn:"2026-11-05",revision:0};
  const two={taskId:"a-later",whenOn:"2026-11-07",revision:0};
  const frame={ok:true,plans:[one,two],hasMore:false,revision:"0".repeat(64),
    privateEpoch:2,linearization:{actorUserId:"bob",areas:[area]},
    window:"upcoming",evaluationDate:"2026-11-04",throughDate:"2026-11-10"};
  const parse=v=>parseStagingPersonalWhenPage(v,"upcoming","2026-11-04","2026-11-10",2);
  assert.deepEqual(ids(parse(frame)),["z-first","a-later"]);
  for(const changed of [
    {...frame,privateSecret:"x"}, {...frame,privateEpoch:-1},
    {...frame,linearization:{actorUserId:"bob",areas:[{...area,access:"viewer",areaKind:"shared"}]}},
    {...frame,linearization:{actorUserId:"bob",areas:[]}},
    {...frame,plans:[two,one]},
    {...frame,plans:[one,{...two,whenOn:"2026-11-05",taskId:"a-later"}]},
    {...frame,plans:[one,{...two,taskId:"z-first"}]},
    {...frame,plans:[one,{...two,taskId:"z-first",whenOn:"2026-11-07"}]},
    {...frame,plans:[one,{...two,whenOn:"2026-11-11"}]},
    {...frame,plans:[one,{...two,whenOn:"2026-02-29"}]},
    {...frame,plans:[one,{...two,assigneeUserId:"bob"}]},
    {...frame,plans:[one],hasMore:true},
    {...frame,window:"on-day"}, {...frame,evaluationDate:"2026-11-05"},
    {...frame,throughDate:"2026-11-11"},
  ])assert.equal(parse(changed),null,JSON.stringify(changed).slice(0,180));
  assert.equal(parseStagingPersonalWhenPage(frame,"upcoming","2026-02-29","2026-11-10",2),null);
});
