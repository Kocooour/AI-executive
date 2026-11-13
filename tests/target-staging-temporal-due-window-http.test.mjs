import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3j2-due-window-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-due-window-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/task-temporal/due-window/route.ts");
const {readStagingTemporalDueWindowInChild,parseStagingTemporalDueWindowPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");

let serial=0;const fixtures=[];
after(()=>{
  for(const fx of fixtures)fx.db.close();
  for(const [key,value] of Object.entries(before)) {
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
  const put=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  const records=[
    ["p-alice",stage.unassignedAreaId,null,"Owner deadline",null,"2026-11-04"],
    ["p-bob","bob-area",null,"Bob deadline",null,"2026-11-04"],
    ["p-bob-old","bob-area",null,"Overdue Bob",null,"2026-11-03"],
    ["p-erin","erin-area",null,"Erin private secret",null,"2026-11-04"],
    ["s-bob-old","family-area",null,"Overdue Bob shared","bob","2026-11-02"],
    ["s-bob-today","family-area",null,"Shared Bob today","bob","2026-11-04"],
    ["s-other","family-area",null,"Assigned to Alice","alice","2026-11-04"],
    ["s-unassigned","family-area",null,"Shared unassigned",null,"2026-11-04"],
    ["s-z-early","family-area",null,"Earlier by date","bob","2026-11-05"],
    ["s-a-later","family-area",null,"Later despite lower ID","bob","2026-11-07"],
    ["s-child",null,"parent","Inherited dueOn","bob","2026-11-09"],
    ["s-undated","family-area",null,"No deadline","bob",null],
    ["s-completed","family-area",null,"Already completed","bob","2026-11-04"],
  ];
  for(const row of records)put.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='s-completed'").run();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={stage,db,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
  fixtures.push(fx);return fx;
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(fx,who){
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const base="http://localhost:3001/api/target-staging/task-temporal/due-window";
const params=(scope="my-plan",window="due-today",evaluationDate="2026-11-04",throughDate=null,limit=null)=>{
  const p=new URLSearchParams({scope,window,evaluationDate});
  if(throughDate!==null)p.set("throughDate",throughDate);
  if(limit!==null)p.set("limit",String(limit));
  return "?"+p.toString();
};
const request=(query,cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.42.1"},
});
const get=(query,cookie=owner())=>GET(request(query,cookie));
async function ok(promise){
  const response=await promise,body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(Object.keys(body).sort().join(","),
    "evaluationDate,hasMore,nextCursor,tasks,throughDate,window");
  return body;
}
const ids=data=>data.tasks.map(t=>t.id);

test("new due-window HTTP gates fail closed without enabling existing temporal API",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get(params())).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+params()))).status,401);
  const body=await ok(get(params()));
  // My Plan combines the owner\u0027s private tasks with assigned shared work.
  assert.deepEqual(ids(body),["p-alice","s-other"]);
  assert.deepEqual(ids(await ok(get(params("personal")))),["p-alice"]);
  assert.equal(body.window,"due-today");
  assert.equal(body.evaluationDate,"2026-11-04");
  assert.equal(body.throughDate,null);
});

test("strict GET query rejects unknown/duplicate filters, bad dates/horizon and cursor input",async()=>{
  fixture();
  for(const query of [
    "", "?scope=shared", "?window=upcoming&scope=shared",
    params("shared","due-today","2026-02-29"),
    params("shared","due-today","2026-11-04T00:00:00Z"),
    params("shared","due-today","2026-11-04","2026-11-05"),
    params("shared","upcoming","2026-11-04"),
    params("shared","upcoming","2026-11-04","2026-11-04"),
    params("shared","upcoming","2026-11-04","2026-11-03"),
    params("shared","upcoming","2026-11-04","2027-11-05"),
    params("shared","upcoming","2026-11-04","2026-02-29"),
    "?scope=other&window=due-today&evaluationDate=2026-11-04",
    "?scope=personal&scope=shared&window=due-today&evaluationDate=2026-11-04",
    "?window=due-today&window=overdue&evaluationDate=2026-11-04",
    "?window=due-today&evaluationDate=2026-11-04&evaluationDate=2026-11-04",
    params()+"&actor=bob",params()+"&offset=1",params()+"&limit=0",
    params()+"&limit=101",params()+"&limit=1&limit=2",
    params()+"&cursor=not-a-token",params()+"&cursor=a%00b",
  ]) assert.equal((await get(query)).status,400,query);
});

test("actor/current Area scope and SQL time ordering; shared viewer remains read-only",async()=>{
  const fx=fixture();
  const bob=login(fx,"bob"),carol=login(fx,"carol"),erin=login(fx,"erin");
  const today=params(),shared=params("shared"),upcoming=params("my-plan","upcoming","2026-11-04","2026-11-11");
  assert.deepEqual(ids(await ok(get(today,bob))),["p-bob","s-bob-today"]);
  assert.deepEqual(ids(await ok(get(shared,bob))),
    ["s-bob-today","s-other","s-unassigned"]);
  assert.deepEqual(ids(await ok(get(shared,carol))),
    ["s-bob-today","s-other","s-unassigned"]);
  assert.deepEqual(ids(await ok(get(today,carol))),[]);
  assert.deepEqual(ids(await ok(get(today,erin))),["p-erin"]);
  assert.deepEqual(ids(await ok(get(params("my-plan","overdue"),bob))),
    ["s-bob-old","p-bob-old"]);
  assert.deepEqual(ids(await ok(get(upcoming,bob))),
    ["s-z-early","s-a-later","s-child"]);
  assert.deepEqual(ids(await ok(get(params("my-plan","upcoming","2026-11-04","2026-11-05"),bob))),
    ["s-z-early"]);
  assert.equal(JSON.stringify(await ok(get(shared,carol))).includes("p-erin"),false);
  for(const task of (await ok(get(today,bob))).tasks){
    assert.equal(task.status,"open");
    assert.equal(task.dueOn,"2026-11-04");
    assert.equal(task.completedAtMs,null);
    assert.equal("when" in task,false);
    assert.equal("assigneeUserId" in task,false);
  }
});

test("signed due-window cursor binds actor, session, scope, window, dates and limit",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const firstQuery=params("shared","upcoming","2026-11-04","2026-11-11",1);
  const first=await ok(get(firstQuery,bob));
  assert.equal(first.hasMore,true);
  assert.deepEqual(ids(first),["s-z-early"]);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token="&cursor="+encodeURIComponent(first.nextCursor);
  const second=await ok(get(firstQuery+token,bob));
  assert.deepEqual(ids(second),["s-a-later"]);
  for(const query of [
    firstQuery.replace("scope=shared","scope=my-plan")+token,
    firstQuery.replace("window=upcoming","window=due-today").replace("&throughDate=2026-11-11","")+token,
    firstQuery.replace("throughDate=2026-11-11","throughDate=2026-11-12")+token,
    firstQuery.replace("evaluationDate=2026-11-04","evaluationDate=2026-11-05")+token,
    firstQuery.replace("limit=1","limit=2")+token,
  ]) assert.equal((await get(query,bob)).status,400,query);
  assert.equal((await get(firstQuery+token,carol)).status,400);
  assert.equal((await get(firstQuery+token,owner())).status,400);
  // A change to the same visible Area invalidates a continuation.
  fx.db.prepare("UPDATE tasks SET title='Changed' WHERE id='s-a-later'").run();
  assert.equal((await get(firstQuery+token,bob)).status,409);
});

test("live release denies role/Area changes even after a successful child read",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={stagingDirectory:fx.stage.directory,
    expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:tokenHash};
  const result=await readStagingTemporalDueWindowInChild(
    config,"shared","due-today","2026-11-04",null,1,0);
  assert.ok(result && result.hasMore);
  const observed=verifyStagingReadBeforeRelease(
    request(params("shared"),bob),{kind:"session",tokenHash},fx.store,
    "alice",result.linearization);
  assert.equal(observed,"ok");
  // Canonical SQLite prohibits revoking a member who still owns assignments.
  fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
  fx.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(verifyStagingReadBeforeRelease(
    request(params("shared"),bob),{kind:"session",tokenHash},fx.store,
    "alice",result.linearization),"stale");
  assert.deepEqual(ids(await ok(get(params("shared"),bob))),[]);
  assert.equal(JSON.stringify(await ok(get(params(),bob))).includes("s-bob-today"),false);
});

test("revoked durable session cannot reuse a due-window cursor",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const baseQuery=params("shared","due-today","2026-11-04",null,1);
  const first=await ok(get(baseQuery,bob));
  assert.ok(first.nextCursor);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  assert.equal((await get(baseQuery+"&cursor="+encodeURIComponent(first.nextCursor),bob)).status,401);
  assert.equal((await get(params("shared"),bob)).status,401);
});

test("child DTO enforces strict fields, current window, Area witness and date+ID sort",()=>{
  const early={id:"z",title:"Due first",projectId:null,
    areaId:"private",areaKind:"private",status:"open",completedAtMs:null,dueOn:"2026-11-05"};
  const later={...early,id:"a",title:"Due later",dueOn:"2026-11-07"};
  const linearization={actorUserId:"alice",areas:[
    {areaId:"private",areaKind:"private",access:"private-owner",policyRevision:0},
  ]};
  const framed={ok:true,tasks:[early,later],hasMore:false,revision:"0".repeat(64),
    linearization,window:"upcoming",evaluationDate:"2026-11-04",throughDate:"2026-11-11"};
  const parse=v=>parseStagingTemporalDueWindowPage(
    v,"personal","upcoming","2026-11-04","2026-11-11",2);
  assert.deepEqual(parse(framed)?.tasks.map(t=>t.id),["z","a"]);
  for(const invalid of [
    {...framed,unknown:"secret"},
    {...framed,window:"due-today"},
    {...framed,evaluationDate:"2026-11-05"},
    {...framed,throughDate:"2026-11-10"},
    {...framed,tasks:[later,early]},
    {...framed,tasks:[early,{...later,dueOn:"2026-11-05",id:"a"}]},
    {...framed,tasks:[early,{...later,title:"leak",privateSecret:"x"}]},
    {...framed,tasks:[early,{...later,status:"completed",completedAtMs:1790000000000}]},
    {...framed,tasks:[early,{...later,dueOn:"2026-11-12"}]},
    {...framed,tasks:[early,{...later,dueOn:"2026-02-30"}]},
    {...framed,tasks:[early,{...later,areaKind:"shared",assignedToMe:true}]},
    {...framed,tasks:[early,early]},
    {...framed,tasks:[early],hasMore:true},
    {...framed,linearization:{...linearization,areas:[]}},
    {...framed,linearization:{...linearization,areas:[
      {areaId:"private",areaKind:"private",access:"viewer",policyRevision:0}] }},
  ]) assert.equal(parse(invalid),null,JSON.stringify(invalid).slice(0,120));
  assert.equal(parseStagingTemporalDueWindowPage(
    framed,"shared","upcoming","2026-11-04","2026-11-11",2),null);
  assert.equal(parseStagingTemporalDueWindowPage(
    framed,"personal","upcoming","2026-02-29","2026-11-11",2),null);
  assert.equal(parseStagingTemporalDueWindowPage(
    framed,"personal","upcoming","2026-11-04","2026-11-04",2),null);
});
