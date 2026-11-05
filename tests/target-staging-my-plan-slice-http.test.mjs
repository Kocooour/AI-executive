import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const vars=[
  "NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const original=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r3-my-plan-slice-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-my-plan-slice-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/my-plan/slice/route.ts");
let serial=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [key,value] of Object.entries(original)){
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
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]]){
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)")
      .run(who,role);
  }
  const add=db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"Alice secret",null,"2026-11-04"],
    ["b-overdue","bob-private","Bob overdue",null,"2026-11-03"],
    ["b-today","bob-private","Bob today",null,"2026-11-04"],
    ["b-next","bob-private","Bob tomorrow",null,"2026-11-05"],
    ["b-next2","bob-private","Bob tomorrow 2",null,"2026-11-05"],
    ["c-private","carol-private","Carol secret",null,"2026-11-04"],
    ["s-bob","family-area","Bob assigned tomorrow","bob","2026-11-05"],
    ["s-unassigned","family-area","Shared unassigned",null,"2026-11-04"],
    ["s-foreign","family-area","Alice assigned","alice","2026-11-04"],
  ])add.run(...row);
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const store={
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  };
  const f={db,stage,store};fixtures.push(f);return f;
}
const base="http://localhost:3001/api/target-staging/my-plan/slice";
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(f,who){
  const response=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(response.ok,true,JSON.stringify(response));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+response.sessionToken;
}
function query(extra={}){
  return "?"+new URLSearchParams({evaluationDate:"2026-11-04",...extra}).toString();
}
function get(q=query(),cookie=owner()){
  return GET(new Request(base+q,{headers:{
    cookie,"x-forwarded-for":"10.99.8.1",
  }}));
}
const ids=section=>section.tasks.map(x=>x.taskId);
async function ok(request){
  const res=await request;const body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),[
    "areaFilter","evaluationDate","hasMore","nextCursor","today","tomorrow",
  ]);
  for(const section of [body.today,body.tomorrow]){
    assert.deepEqual(Object.keys(section).sort(),["hasMore","tasks"]);
    for(const task of section.tasks){
      for(const forbidden of ["userId","assigneeUserId","privateEpoch",
        "linearization","areaEpochs","revision"])
        assert.equal(forbidden in task,false);
      if(task.areaKind==="shared")assert.equal(task.assignedToMe,true);
    }
  }
  return body;
}

test("independent default-off flags, owner cookie, strict request fields",async()=>{
  fixture();
  for(const flag of [
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
  ]){
    process.env[flag]="false";
    assert.equal((await get()).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+query()))).status,401);
  const good=await ok(get());
  assert.deepEqual(ids(good.today),["a-alice","s-foreign"]);
  assert.deepEqual(ids(good.tomorrow),[]);
  for(const invalid of [
    "", "?areaFilter=all",query({evaluationDate:"2026-02-29"}),
    query({evaluationDate:"2026-11-04T00:00Z"}),
    query({evaluationDate:"9999-12-31"}),
    query({areaFilter:"vse"}),query({limit:"0"}),query({limit:"01"}),
    query({limit:"101"}),query({cursor:"bad"}),
    query()+"&actor=bob",query()+"&evaluationDate=2026-11-05",
    query({areaFilter:"personal"})+"&areaFilter=shared",
  ])assert.equal((await get(invalid)).status,400,invalid);
});

test("today includes overdue; tomorrow is exclusive; My Plan is never global Vše",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const page=await ok(get(query(),bob));
  assert.deepEqual(ids(page.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(page.tomorrow),["b-next","b-next2","s-bob"]);
  assert.equal(page.hasMore,false);
  assert.equal(page.nextCursor,null);
  assert.equal(JSON.stringify(page).includes("Alice secret"),false);
  assert.equal(JSON.stringify(page).includes("Shared unassigned"),false);
  assert.equal(JSON.stringify(page).includes("Alice assigned"),false);
  const onlyShared=await ok(get(query({areaFilter:"shared"}),bob));
  assert.deepEqual(ids(onlyShared.today),[]);
  assert.deepEqual(ids(onlyShared.tomorrow),["s-bob"]);
  assert.deepEqual(ids((await ok(get(query(),carol))).today),["c-private"]);
  assert.deepEqual(ids((await ok(get(query(),carol))).tomorrow),[]);
});

test("one signed cursor advances both days independently with no duplicates",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const all=[];
  let cursor=null;
  for(let i=0;i<5;i++){
    const page=await ok(get(query({
      limit:"1",...(cursor?{cursor}:{}),
    }),bob));
    all.push(...ids(page.today),...ids(page.tomorrow));
    if(!page.hasMore){
      assert.equal(page.nextCursor,null);
      break;
    }
    assert.ok(page.nextCursor);
    cursor=page.nextCursor;
  }
  assert.equal(all.length,5);
  assert.equal(new Set(all).size,5);
  assert.deepEqual(all.sort(),[
    "b-overdue","b-today","b-next","b-next2","s-bob",
  ].sort());
});

test("cursor cannot cross session, filter, date, limit or a changed private plan",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const first=await ok(get(query({limit:"1"}),bob));
  const cursor=first.nextCursor;assert.ok(cursor);
  for(const extra of [
    {areaFilter:"personal",limit:"1",cursor},
    {evaluationDate:"2026-11-05",limit:"1",cursor},
    {limit:"2",cursor},
    {limit:"1",cursor:cursor.slice(0,-1)+(cursor.endsWith("A")?"B":"A")},
  ])assert.equal((await get(query(extra),bob)).status,400,JSON.stringify(extra));
  const otherSession=login(f,"bob");
  assert.equal((await get(query({limit:"1",cursor}),otherSession)).status,400);
  f.db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES ('bob','b-next','2026-11-06')").run();
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
});

test("live role revocation invalidates continuation; fresh request hides old shared work",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const cursor=(await ok(get(query({limit:"1"}),bob))).nextCursor;
  assert.ok(cursor);
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  f.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  const fresh=await ok(get(query(),bob));
  assert.deepEqual(ids(fresh.tomorrow),["b-next","b-next2"]);
});

test("two-day atomic child keeps one complete epoch witness and live guard detects a race",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const {readStagingMyPlanTwoDayInChild}=
    await import("../lib/target-staging-read-process.ts");
  const {verifyStagingReadBeforeRelease}=
    await import("../lib/target-staging-http-identity.ts");
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read=()=>readStagingMyPlanTwoDayInChild({
    stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all","2026-11-04","2026-11-05",2,{today:0,tomorrow:0});
  const page=await read();
  assert.ok(page);
  assert.deepEqual(ids(page.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(page.tomorrow),["b-next","b-next2"]);
  assert.deepEqual(page.today.linearization,page.tomorrow.linearization);
  assert.deepEqual(page.today.areaEpochs,page.tomorrow.areaEpochs);
  assert.equal(page.today.privateEpoch,page.tomorrow.privateEpoch);
  const verify=p=>verifyStagingReadBeforeRelease(
    new Request(base+query(),{headers:{cookie:bob}}),
    {kind:"session",tokenHash:hash},f.store,"alice",p.today.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:p.today.areaEpochs,scope:"my-plan"},undefined,
    {privateEpoch:p.today.privateEpoch},
  );
  assert.equal(verify(page),"ok");
  // Mutate only the upcoming bucket AFTER the pinned child released it.
  // The live guard must not release the old combined response.
  f.db.prepare("UPDATE tasks SET due_on='2026-11-06' WHERE id='b-next'").run();
  assert.equal(verify(page),"stale");
  const refreshed=await read();
  assert.ok(refreshed);
  assert.equal(verify(refreshed),"ok");
  assert.deepEqual(ids(refreshed.tomorrow),["b-next2","s-bob"]);
});

test("calendar rollover is local-day based across year end and leap day",async()=>{
  const f=fixture(),bob=login(f,"bob");
  f.db.prepare("UPDATE tasks SET due_on='2026-12-31' WHERE id='b-next'").run();
  f.db.prepare("UPDATE tasks SET due_on='2027-01-01' WHERE id='b-next2'").run();
  f.db.prepare("UPDATE tasks SET due_on='2027-01-01' WHERE id='s-bob'").run();
  const year=await ok(get(query({evaluationDate:"2026-12-31"}),bob));
  assert.deepEqual(ids(year.today),["b-overdue","b-today","b-next"]);
  assert.deepEqual(ids(year.tomorrow),["b-next2","s-bob"]);
  f.db.prepare("INSERT INTO tasks(id,area_id,title,due_on) VALUES ('b-leap','bob-private','Leap-day task','2028-02-29')").run();
  const leap=await ok(get(query({evaluationDate:"2028-02-28"}),bob));
  assert.deepEqual(ids(leap.tomorrow),["b-leap"]);
  const month=await ok(get(query({evaluationDate:"2028-02-29"}),bob));
  assert.ok(ids(month.today).includes("b-leap"));
  assert.deepEqual(ids(month.tomorrow),[]);
});
