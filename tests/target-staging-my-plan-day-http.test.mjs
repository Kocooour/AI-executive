import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3l2-day-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-my-plan-day-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/task-temporal/my-plan-day/route.ts");
const {readStagingMyPlanDayInChild,parseStagingMyPlanDayPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let serial=0;const fixtures=[];
after(()=>{
  for(const fx of fixtures)fx.db.close();
  for(const [key,value] of Object.entries(before)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
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
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Parent')").run();
  const insert=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["p-alice",stage.unassignedAreaId,null,"Alice secret",null,"2026-11-04"],
    ["p-bob","bob-private",null,"Bob private",null,null],
    ["p-bob-old","bob-private",null,"Overdue private",null,"2026-11-03"],
    ["p-bob-next","bob-private",null,"Next week private",null,"2026-11-08"],
    ["p-erin","erin-private",null,"Erin secret",null,"2026-11-04"],
    ["s-bob","family-area",null,"Assigned Bob","bob","2026-11-05"],
    ["s-both","family-area",null,"Both dates","bob","2026-11-08"],
    ["s-child",null,"project","Inherited Area","bob","2026-11-10"],
    ["s-alice","family-area",null,"Assigned Alice","alice","2026-11-04"],
    ["s-unassigned","family-area",null,"Unassigned",null,"2026-11-04"],
    ["s-done","family-area",null,"Completed","bob","2026-11-04"],
    ["s-undated","family-area",null,"Not scheduled","bob",null],
    ["hidden","hidden-area",null,"Hidden","erin","2026-11-04"],
  ])insert.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-done'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["alice","p-alice","2026-11-08"],["bob","p-bob","2026-11-04"],
    ["bob","p-bob-old","2026-11-09"],["bob","s-bob","2026-11-04"],
    ["bob","s-both","2026-11-07"],["erin","p-erin","2026-11-04"],
  ])plan.run(...row);
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={db,store,stage};fixtures.push(fx);return fx;
}
const base="http://localhost:3001/api/target-staging/task-temporal/my-plan-day";
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(f,who){
  const session=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(session.ok,true,JSON.stringify(session));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+session.sessionToken;
}
function params(areaFilter="all",window="today",
  evaluationDate="2026-11-04",throughDate=null,limit=null){
  const p=new URLSearchParams({areaFilter,window,evaluationDate});
  if(throughDate!==null)p.set("throughDate",throughDate);
  if(limit!==null)p.set("limit",String(limit));
  return "?"+p.toString();
}
const req=(q,cookie=owner())=>new Request(base+q,{
  headers:{cookie,"x-forwarded-for":"10.9.75.1"},
});
const get=(q,cookie=owner())=>GET(req(q,cookie));
const ids=p=>p.tasks.map(t=>t.taskId);
async function ok(request){
  const res=await request,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),[
    "areaFilter","evaluationDate","hasMore","nextCursor","tasks","throughDate","window",
  ]);
  assert.equal("privateEpoch" in body,false);
  assert.equal("linearization" in body,false);
  assert.equal("areaEpochs" in body,false);
  for(const task of body.tasks){
    assert.equal("userId" in task,false);
    assert.equal("assigneeUserId" in task,false);
    assert.equal("privateEpoch" in task,false);
    if(task.areaKind==="shared")assert.equal(task.assignedToMe,true);
  }
  return body;
}

test("two explicit default-off staging gates and authenticated owner",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get(params())).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+params()))).status,401);
  assert.deepEqual(ids(await ok(get(params()))),["p-alice","s-alice"]);
});

test("strict URL bounds, unknown/duplicate fields and untrusted actor denied",async()=>{
  fixture();
  const bad=[
    "","?areaFilter=all","?areaFilter=none&window=today&evaluationDate=2026-11-04",
    params("all","all"),params("all","today","2026-02-29"),
    params("all","today","2026-11-04T00:00:00Z"),
    params("all","today","2026-11-04","2026-11-05"),
    params("all","upcoming","2026-11-04"),
    params("all","upcoming","2026-11-04","2026-11-04"),
    params("all","upcoming","2026-11-04","2027-11-04"),
    params("all","upcoming","2026-11-04","2026-02-29"),
    params()+"&actor=bob",params()+"&scope=shared",
    params()+"&offset=1",params()+"&limit=0",
    params()+"&limit=101",params()+"&limit=01",
    params()+"&cursor=nope",params()+"&cursor=a%00b",
    params()+"&window=upcoming",params()+"&areaFilter=shared",
  ];
  for(const q of bad)assert.equal((await get(q)).status,400,q);
});

test("own plans, earliest deadline, owner/shared scope, viewer and project child",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get(params(),bob))),["p-bob-old","p-bob","s-bob"]);
  assert.deepEqual(ids(await ok(get(params("personal"),bob))),["p-bob-old","p-bob"]);
  assert.deepEqual(ids(await ok(get(params("shared"),bob))),["s-bob"]);
  assert.deepEqual(ids(await ok(get(params("all","upcoming","2026-11-04","2026-11-11"),bob))),
    ["s-both","p-bob-next","s-child"]);
  assert.deepEqual(ids(await ok(get(params("shared","upcoming","2026-11-04","2026-11-11"),bob))),
    ["s-both","s-child"]);
  assert.deepEqual(ids(await ok(get(params(),carol))),[]);
  assert.deepEqual(ids(await ok(get(params(),erin))),["hidden","p-erin"]);
  const body=await ok(get(params(),bob));
  assert.ok(!JSON.stringify(body).includes("Alice secret"));
  assert.ok(!JSON.stringify(body).includes("Erin secret"));
  assert.ok(!JSON.stringify(body).includes("Unassigned"));
  assert.equal(body.tasks.find(t=>t.taskId==="p-bob-old").whenOn,"2026-11-09");
  assert.equal(body.tasks.find(t=>t.taskId==="p-bob-old").attentionOn,"2026-11-03");
  assert.ok(!ids(await ok(get(params("all","upcoming","2026-11-04","2026-11-11"),bob)))
    .includes("p-bob-old"));
});

test("signed cursor binds actor/session, filter, dates and limit; stale page denied",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const q=params("all","today","2026-11-04",null,1);
  const first=await ok(get(q,bob));
  assert.deepEqual(ids(first),["p-bob-old"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const part="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(ids(await ok(get(q+part,bob))),["p-bob"]);
  for(const alternate of [
    params("personal","today","2026-11-04",null,1),
    params("all","today","2026-11-05",null,1),
    params("all","upcoming","2026-11-04","2026-11-11",1),
    params("all","today","2026-11-04",null,2),
  ])assert.equal((await get(alternate+part,bob)).status,400);
  assert.equal((await get(q+part,carol)).status,400);
  assert.equal((await get(q+part,owner())).status,400);
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='p-bob'").run();
  assert.equal((await get(q+part,bob)).status,409);
});

test("atomic live Area-content and private-epoch guards reject reassignment/races",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read=()=>readStagingMyPlanDayInChild({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all","today","2026-11-04",null,100,0);
  const page=await read();assert.ok(page);
  const verify=pg=>verifyStagingReadBeforeRelease(req(params(),bob),
    {kind:"session",tokenHash:hash},f.store,"alice",pg.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:pg.areaEpochs,scope:"my-plan"},undefined,
    {privateEpoch:pg.privateEpoch});
  assert.equal(verify(page),"ok");
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  assert.equal(verify(page),"stale");
  const current=await read();assert.ok(current);
  assert.equal(verify(current),"ok");
  assert.deepEqual(ids(await ok(get(params(),bob))),["p-bob-old","p-bob"]);
  f.db.prepare("UPDATE personal_task_plans SET when_on='2026-11-06' WHERE user_id='bob' AND task_id='p-bob'").run();
  assert.equal(verify(current),"stale");
  const refreshed=await read();assert.ok(refreshed);
  assert.equal(verify(refreshed),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.notEqual(verify(refreshed),"ok");
});

test("strict child DTO rejects injected metadata, forgery, unsorted or stale dates",()=>{
  const privateArea={areaId:"bob-private",areaKind:"private",access:"private-owner",
    policyRevision:0,contentRevision:2,projectContentRevision:0};
  const sharedArea={areaId:"family-area",areaKind:"shared",access:"editor",
    policyRevision:0,contentRevision:3,projectContentRevision:0};
  const one={taskId:"a",title:"A",projectId:null,areaId:"bob-private",
    areaKind:"private",dueOn:null,whenOn:"2026-11-04",attentionOn:"2026-11-04"};
  const two={taskId:"b",title:"B",projectId:null,areaId:"family-area",
    areaKind:"shared",assignedToMe:true,dueOn:"2026-11-04",
    whenOn:null,attentionOn:"2026-11-04"};
  const frame={ok:true,areaFilter:"all",window:"today",evaluationDate:"2026-11-04",
    throughDate:null,tasks:[one,two],hasMore:false,revision:"0".repeat(64),
    privateEpoch:2,linearization:{actorUserId:"bob",areas:[
      {areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0},
      {areaId:"family-area",areaKind:"shared",access:"editor",policyRevision:0},
    ]},areaEpochs:[privateArea,sharedArea]};
  const parse=x=>parseStagingMyPlanDayPage(x,"all","today","2026-11-04",null,2);
  assert.deepEqual(ids(parse(frame)),["a","b"]);
  const invalid=[
    {...frame,secret:"x"},{...frame,privateEpoch:-1},
    {...frame,areaEpochs:[privateArea]},
    {...frame,areaEpochs:[{...privateArea,contentRevision:9},sharedArea],
      linearization:{...frame.linearization,areas:[{...frame.linearization.areas[0],access:"viewer"},
        frame.linearization.areas[1]]}},
    {...frame,tasks:[two,one]},
    {...frame,tasks:[one,{...two,taskId:"a"}]},
    {...frame,tasks:[one,{...two,dueOn:"2026-11-05"}]},
    {...frame,tasks:[one,{...two,assignedToMe:false}]},
    {...frame,tasks:[one,{...two,assigneeUserId:"bob"}]},
    {...frame,tasks:[one,{...two,attentionOn:"2026-11-05"}]},
    {...frame,tasks:[one,{...two,whenOn:"2026-02-29"}]},
    {...frame,tasks:[one],hasMore:true},
    {...frame,throughDate:"2026-11-10"},
  ];
  for(const x of invalid)assert.equal(parse(x),null,JSON.stringify(x).slice(0,180));
});
