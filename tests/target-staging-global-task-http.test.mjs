import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const env=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(env.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m2-global-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"untouched");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"isolated-global-task-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/task-index/global/route.ts");
const {readStagingGlobalTaskPageInChild,parseStagingGlobalTaskPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=await import("../lib/target-staging-http-identity.ts");
let seq=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [k,v] of Object.entries(old)){
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"untouched");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++seq)),ownerUserId:"alice",
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
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Shared parent')").run();
  const put=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private secret",null,"2026-11-04"],
    ["b-bob","bob-private",null,"Bob only",null,null],
    ["c-carol","carol-private",null,"Carol only",null,null],
    ["d-erin","erin-private",null,"Erin secret",null,null],
    ["s-alice","family-area",null,"Assigned Alice","alice","2026-11-05"],
    ["s-bob","family-area",null,"Assigned Bob","bob","2026-11-06"],
    ["s-child",null,"project","Inherited shared child","alice",null],
    ["s-completed","family-area",null,"Completed","bob","2026-11-03"],
    ["s-unassigned","family-area",null,"Unassigned shared",null,null],
    ["hidden","hidden-area",null,"Hidden to Bob","erin",null],
  ])put.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-completed'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["bob","b-bob","2026-11-05"],["bob","s-bob","2026-11-07"],
    ["alice","a-alice","2026-11-09"],["erin","d-erin","2026-11-08"],
  ])plan.run(...row);
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const f={stage,db,store};fixtures.push(f);return f;
}
const base="http://localhost:3001/api/target-staging/task-index/global";
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(f,who){
  const r=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(r.ok,true,JSON.stringify(r));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+r.sessionToken;
}
const req=(q="",cookie=owner())=>new Request(base+q,{
  headers:{cookie,"x-forwarded-for":"10.9.61.4"},
});
const get=(q="",cookie=owner())=>GET(req(q,cookie));
const ids=p=>p.tasks.map(t=>t.id);
async function ok(response){
  const res=await response,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),["hasMore","nextCursor","scope","tasks"]);
  for(const t of body.tasks){
    assert.deepEqual(Object.keys(t).sort(),
      ("areaId,areaKind,dueOn,id,projectId,status,title"+
       (t.areaKind==="shared"?",assignedToMe":"")).split(",").sort());
    assert.equal("whenOn" in t,false);
    assert.equal("assigneeUserId" in t,false);
  }
  assert.equal("linearization" in body,false);
  assert.equal("areaEpochs" in body,false);
  assert.equal("revision" in body,false);
  return body;
}

test("both default-off gates and owner session required",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get()).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base))).status,401);
  assert.deepEqual(ids(await ok(get())),[
    "a-alice","s-alice","s-bob","s-child","s-completed","s-unassigned",
  ]);
});

test("global Vše vs personal/shared, viewer and private ACL, inherited Area",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get("?scope=all",bob))),[
    "b-bob","s-alice","s-bob","s-child","s-completed","s-unassigned",
  ]);
  assert.deepEqual(ids(await ok(get("?scope=personal",bob))),["b-bob"]);
  assert.deepEqual(ids(await ok(get("?scope=shared",bob))),[
    "s-alice","s-bob","s-child","s-completed","s-unassigned",
  ]);
  const viewer=await ok(get("?scope=all",carol));
  assert.deepEqual(ids(viewer),[
    "c-carol","s-alice","s-bob","s-child","s-completed","s-unassigned",
  ]);
  assert.ok(viewer.tasks.filter(t=>t.areaKind==="shared")
    .every(t=>t.assignedToMe===false));
  assert.deepEqual(ids(await ok(get("?scope=all",erin))),["d-erin","hidden"]);
  const page=await ok(get("?scope=all",bob));
  assert.equal(page.tasks.find(t=>t.id==="s-bob").assignedToMe,true);
  assert.equal(page.tasks.find(t=>t.id==="s-alice").assignedToMe,false);
  assert.equal(page.tasks.find(t=>t.id==="s-unassigned").assignedToMe,false);
  assert.equal(page.tasks.find(t=>t.id==="s-child").projectId,"project");
  assert.equal(page.tasks.find(t=>t.id==="s-completed").status,"completed");
  assert.ok(!JSON.stringify(page).includes("Alice private secret"));
  assert.ok(!JSON.stringify(page).includes("Erin secret"));
});

test("malformed URL, duplicate parameters, foreign actor and offset are rejected",async()=>{
  fixture();
  for(const q of [
    "?scope=my-plan","?scope=unknown","?scope=all&scope=shared",
    "?scope=all&actor=bob","?assigneeUserId=bob","?offset=1",
    "?limit=0","?limit=101","?limit=01","?limit=1000",
    "?cursor=nope","?cursor=a%00b","?scope=shared&limit=2&limit=3",
  ])assert.equal((await get(q)).status,400,q);
});

test("signed cursor is actor, scope and limit-bound; stale shared edit returns 409",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const q="?scope=all&limit=1";
  const first=await ok(get(q,bob));
  assert.deepEqual(ids(first),["b-bob"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const tail="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(ids(await ok(get(q+tail,bob))),["s-alice"]);
  for(const swapped of ["?scope=shared&limit=1","?scope=personal&limit=1",
    "?scope=all&limit=2"])assert.equal((await get(swapped+tail,bob)).status,400);
  assert.equal((await get(q+tail,carol)).status,400);
  assert.equal((await get(q+tail,owner())).status,400);
  f.db.prepare("UPDATE tasks SET title='Shared updated' WHERE id='s-alice'").run();
  assert.equal((await get(q+tail,bob)).status,409);
});

test("LIVE Area content, session and role witnesses reject stale response",async()=>{
  const f=fixture(),carol=login(f,"carol");
  const hash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const child=()=>readStagingGlobalTaskPageInChild({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all",100,0);
  const check=p=>verifyStagingReadBeforeRelease(
    req("?scope=all",carol),{kind:"session",tokenHash:hash},f.store,"alice",
    p.linearization,undefined,undefined,undefined,undefined,undefined,
    {areas:p.areaEpochs,scope:"global-all"});
  const before=await child();assert.ok(before);
  assert.equal(check(before),"ok");
  f.db.prepare("UPDATE tasks SET title='Changed after snapshot' WHERE id='s-bob'").run();
  assert.equal(check(before),"stale");
  const after=await child();assert.ok(after);assert.equal(check(after),"ok");
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(check(after),"stale");
  assert.deepEqual(ids(await ok(get("?scope=all",carol))),["c-carol"]);
  const revoked=await child();assert.ok(revoked);
  assert.equal(check(revoked),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"carol").ok,true);
  assert.notEqual(check(revoked),"ok");
});

test("empty newly granted Area invalidates global cursor and live page",async()=>{
  const f=fixture(),carol=login(f,"carol");
  const hash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const config={stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash};
  const before=await readStagingGlobalTaskPageInChild(config,"all",100,0);
  assert.ok(before);
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-family','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-family-area','New','shared','new-family','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-family-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-family-area','carol','viewer')").run();
  const current=await readStagingGlobalTaskPageInChild(config,"all",100,0);
  assert.ok(current);
  assert.notEqual(before.revision,current.revision);
  assert.deepEqual(ids(before),ids(current));
  assert.ok(current.areaEpochs.some(a=>a.areaId==="new-family-area"));
});

test("strict child DTO rejects foreign metadata, mismatched roles and forged rows",()=>{
  const personal={areaId:"bob-private",areaKind:"private",access:"private-owner",
    policyRevision:0,contentRevision:2,projectContentRevision:0};
  const shared={areaId:"family-area",areaKind:"shared",access:"viewer",
    policyRevision:0,contentRevision:3,projectContentRevision:0};
  const one={id:"b",title:"Private",projectId:null,areaId:"bob-private",
    areaKind:"private",status:"open",dueOn:null};
  const two={id:"s",title:"Shared",projectId:null,areaId:"family-area",
    areaKind:"shared",status:"completed",dueOn:"2026-11-04",assignedToMe:false};
  const frame={ok:true,scope:"all",tasks:[one,two],hasMore:false,
    revision:"0".repeat(64),
    linearization:{actorUserId:"bob",areas:[
      {areaId:personal.areaId,areaKind:personal.areaKind,
        access:personal.access,policyRevision:personal.policyRevision},
      {areaId:shared.areaId,areaKind:shared.areaKind,
        access:shared.access,policyRevision:shared.policyRevision},
    ]},areaEpochs:[personal,shared]};
  const parse=x=>parseStagingGlobalTaskPage(x,"all",2);
  assert.deepEqual(ids(parse(frame)),["b","s"]);
  const malformed=[
    {...frame,secret:"forged"}, {...frame,scope:"my-plan"},
    {...frame,tasks:[two,one]},
    {...frame,tasks:[one,{...two,id:"b"}]},
    {...frame,tasks:[one,{...two,assigneeUserId:"alice"}]},
    {...frame,tasks:[one,{...two,whenOn:"2026-11-04"}]},
    {...frame,tasks:[{...one,assignedToMe:false},two]},
    {...frame,tasks:[one,{...two,dueOn:"2026-02-29"}]},
    {...frame,tasks:[one,{...two,status:"deleted"}]},
    {...frame,tasks:[{...one,areaId:"family-area"},two]},
    {...frame,tasks:[one],hasMore:true},
    {...frame,areaEpochs:[personal]},
    {...frame,areaEpochs:[{...personal,contentRevision:-1},shared]},
    {...frame,linearization:{...frame.linearization,areas:[
      {...frame.linearization.areas[0],access:"viewer"},
      frame.linearization.areas[1]]}},
  ];
  for(const data of malformed)assert.equal(parse(data),null,JSON.stringify(data).slice(0,200));
});
