import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const vars = ["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before = Object.fromEntries(vars.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3f-http-temporal-"));
const legacy = path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env, {
  NODE_ENV:"production", AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH: "scrypt:" + Buffer.alloc(16,1).toString("base64url") +
    ":" + Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-temporal-http-session-secret-at-least-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:"true",
});
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("./support/owner-session-test-cookie.mjs");
const { GET } = await import("../app/api/target-staging/task-temporal/route.ts");
const { GET: GET_DETAIL } = await import("../app/api/target-staging/task-temporal/detail/route.ts");
const { readStagingTemporalPageInChild, parseStagingTemporalPage,
  readStagingTemporalDetailInChild, parseStagingTemporalDetail } =
  await import("../lib/target-staging-read-process.ts");
const { verifyStagingReadBeforeRelease } =
  await import("../lib/target-staging-http-identity.ts");
let serial=0;
after(() => {
  for(const [key,value] of Object.entries(before)) {
    if(value === undefined) delete process.env[key]; else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture() {
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-area",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for (const [actor,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(actor,role);
  }
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)");
  insert.run("p-alice",stage.unassignedAreaId,"Alice personal",null);
  insert.run("p-bob","bob-area","Bob personal",null);
  insert.run("p-erin","erin-area","Erin secret",null);
  insert.run("s-bob","family-area","Shared Bob","bob");
  insert.run("s-unassigned","family-area","Shared unassigned",null);
  insert.run("s-complete","family-area","Shared done","bob");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793700000000,due_on='2026-11-03' WHERE id='s-complete'").run();
  db.close();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return {stage,store:{stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration}};
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(fx,who) {
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const base="http://localhost:3001/api/target-staging/task-temporal";
const req=(query="",cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.24.1"}});
const get=(query="",cookie=owner())=>GET(req(query,cookie));
async function ok(responsePromise) {
  const res=await responsePromise; const body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.equal(Object.keys(body).sort().join(","),"hasMore,nextCursor,tasks");
  return body;
}

test("separate temporal gate, cookie and strict filter/limit parsing",async()=>{
  fixture();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED="false";
  assert.equal((await get()).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED="true";
  assert.equal((await GET(new Request(base))).status,401);
  for(const q of ["?scope=none","?status=today","?limit=101","?offset=1",
    "?scope=shared&scope=personal","?status=open&status=completed",
    "?limit=1&limit=2","?cursor=abc","?actor=bob"])
    assert.equal((await get(q)).status,400,q);
});

test("scope/status/DTO allowlist and viewer versus editor are actor-bound",async()=>{
  const fx=fixture();
  const [bob,carol,erin]=["bob","carol","erin"].map(who=>login(fx,who));
  assert.deepEqual((await ok(get())).tasks.map(t=>t.id),["p-alice"]);
  assert.deepEqual((await ok(get("?scope=personal",bob))).tasks.map(t=>t.id),["p-bob"]);
  assert.deepEqual((await ok(get("?scope=shared",bob))).tasks.map(t=>t.id),
    ["s-bob","s-complete","s-unassigned"]);
  assert.deepEqual((await ok(get("?scope=my-plan",bob))).tasks.map(t=>t.id),
    ["p-bob","s-bob","s-complete"]);
  assert.deepEqual((await ok(get("?scope=my-plan",carol))).tasks,[]);
  assert.deepEqual((await ok(get("?scope=shared&status=completed",carol))).tasks.map(t=>t.id),
    ["s-complete"]);
  assert.deepEqual((await ok(get("?scope=personal",erin))).tasks.map(t=>t.id),["p-erin"]);
  const done=(await ok(get("?scope=shared&status=completed",bob))).tasks[0];
  assert.equal(done.completedAtMs,1793700000000);
  assert.equal(done.dueOn,"2026-11-03");
  assert.equal(done.assignedToMe,true);
  assert.equal(Object.keys(done).sort().join(","),
    "areaId,areaKind,assignedToMe,completedAtMs,dueOn,id,projectId,status,title");
  assert.equal(JSON.stringify(await ok(get("?scope=shared",carol))).includes("p-erin"),false);
});

test("signed temporal cursor is bound to actor, scope, status, and current Area epoch",async()=>{
  const fx=fixture();const bob=login(fx,"bob");const carol=login(fx,"carol");
  const first=await ok(get("?scope=shared&status=open&limit=1",bob));
  assert.equal(first.hasMore,true);
  assert.deepEqual(first.tasks.map(t=>t.id),["s-bob"]);
  const suffix="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual((await ok(get("?scope=shared&status=open&limit=1"+suffix,bob)))
    .tasks.map(t=>t.id),["s-unassigned"]);
  assert.equal((await get("?scope=shared&status=completed"+suffix,bob)).status,400);
  assert.equal((await get("?scope=my-plan&status=open"+suffix,bob)).status,400);
  assert.equal((await get("?scope=shared&status=open"+suffix,carol)).status,400);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET title='Changed' WHERE id='s-unassigned'").run();
  db.close();
  assert.equal((await get("?scope=shared&status=open"+suffix,bob)).status,409);
});

test("live Area revocation after child snapshot blocks release without leaking a task",async()=>{
  const fx=fixture();const bob=login(fx,"bob");
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const page=await readStagingTemporalPageInChild({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"shared","all",1,0);
  assert.ok(page && page.hasMore);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id IN ('s-bob','s-complete')").run();
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  db.close();
  assert.equal(verifyStagingReadBeforeRelease(req("?scope=shared",bob),
    {kind:"session",tokenHash:hash},fx.store,"alice",page.linearization),"stale");
  assert.deepEqual((await ok(get("?scope=shared",bob))).tasks,[]);
});

test("child-to-HTTP boundary rejects injected task fields and mismatched Area witness",()=>{
  const task={id:"",title:"Blank ID valid in SQLite",projectId:null,
    areaId:"a",areaKind:"private",status:"open",completedAtMs:null,dueOn:null};
  const linearization={actorUserId:"alice",areas:[
    {areaId:"a",areaKind:"private",access:"private-owner",policyRevision:0}]};
  const page={ok:true,tasks:[task],hasMore:false,revision:"0".repeat(64),linearization};
  assert.deepEqual(parseStagingTemporalPage(page,"personal","all",1)?.tasks[0],task);
  assert.equal(parseStagingTemporalPage({...page,tasks:[{...task,secret:"leak"}]},"personal","all",1),null);
  assert.equal(parseStagingTemporalPage({...page,tasks:[{...task,areaKind:"shared",assignedToMe:true}]},"personal","all",1),null);
  assert.equal(parseStagingTemporalPage({...page,linearization:{...linearization,areas:[]}},"personal","all",1),null);
  assert.equal(parseStagingTemporalPage({...page,tasks:[{...task,status:"completed",completedAtMs:null}]},"personal","all",1),null);
  assert.equal(parseStagingTemporalPage({...page,tasks:[{...task,dueOn:"2026-02-30"}]},"personal","all",1),null);
  assert.equal(parseStagingTemporalPage({...page,hasMore:true},"personal","all",2),null);
});

const detailBase=base+"/detail";
const detailRequest=(taskId,cookie=owner())=>new Request(
  detailBase+"?taskId="+encodeURIComponent(taskId),{
    headers:{cookie,"x-forwarded-for":"10.9.24.1"},
  });
const detailGet=(taskId,cookie=owner())=>GET_DETAIL(detailRequest(taskId,cookie));
async function okDetail(responsePromise) {
  const res=await responsePromise;const body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.equal(Object.keys(body).sort().join(","),"task");
  return body.task;
}

test("R2d.3g detail has independent default-off gate, auth and strict query",async()=>{
  fixture();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED="false";
  assert.equal((await detailGet("p-alice")).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED="true";
  assert.equal((await GET_DETAIL(new Request(detailBase+"?taskId=p-alice"))).status,401);
  for(const query of ["","?foo=bar","?taskId=p-alice&taskId=p-bob",
    "?taskId=p-alice&scope=shared","?taskId=%00","?taskId=x&limit=1"]) {
    assert.equal((await GET_DETAIL(new Request(detailBase+query,{
      headers:{cookie:owner(),"x-forwarded-for":"10.9.24.1"},
    }))).status,400,query);
  }
});

test("R2d.3g temporal detail preserves private/shared viewer ACL and no member IDs",async()=>{
  const fx=fixture();const bob=login(fx,"bob"),carol=login(fx,"carol");
  const aliceTask=await okDetail(detailGet("p-alice"));
  assert.equal(aliceTask.title,"Alice personal");
  assert.equal("assignedToMe" in aliceTask,false);
  assert.equal((await okDetail(detailGet("p-bob",bob))).id,"p-bob");
  const completed=await okDetail(detailGet("s-complete",carol));
  assert.equal(completed.status,"completed");
  assert.equal(completed.completedAtMs,1793700000000);
  assert.equal(completed.dueOn,"2026-11-03");
  assert.equal(completed.assignedToMe,false);
  assert.equal((await okDetail(detailGet("s-bob",bob))).assignedToMe,true);
  assert.equal((await detailGet("p-alice",bob)).status,404);
  assert.equal((await detailGet("p-bob",carol)).status,404);
  assert.equal((await detailGet("missing",bob)).status,404);
  assert.equal(JSON.stringify(completed).includes("bob"),false);
});

test("R2d.3g accepts legacy TEXT task IDs including empty, padded, Unicode and long",async()=>{
  const fx=fixture();
  const db=new DatabaseSync(fx.stage.databasePath);
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  const ids=["","  padded  ","\u{1f600}-item","x".repeat(3000)];
  for(const id of ids) insert.run(id,fx.stage.unassignedAreaId,"Unusual task ID");
  db.close();
  for(const id of ids) {
    const t=await okDetail(detailGet(id));
    assert.equal(t.id,id);
    assert.equal(t.title,"Unusual task ID");
  }
});

test("R2d.3g detail guard validates exact task and inherited parent revisions on LIVE store",async()=>{
  const fx=fixture();const bob=login(fx,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read=async(taskId)=>readStagingTemporalDetailInChild({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:tokenHash,
  },taskId);
  const verify=detail=>verifyStagingReadBeforeRelease(detailRequest(detail.task.id,bob),
    {kind:"session",tokenHash},fx.store,"alice",detail.linearization,
    undefined,undefined,undefined,undefined,undefined,undefined,detail.guard);
  const first=await read("s-bob");
  assert.ok(first?.ok);
  assert.equal(verify(first.detail),"ok");
  const db=new DatabaseSync(fx.stage.databasePath);
  // Task edit bumps revision; membership remains, so an Area-only witness would miss it.
  db.prepare("UPDATE tasks SET due_on='2026-11-07' WHERE id='s-bob'").run();
  assert.equal(verify(first.detail),"stale");
  const second=await read("s-bob");
  assert.ok(second?.ok);
  // Moving a task out of its original Area also invalidates release.
  db.prepare("UPDATE tasks SET area_id='bob-area',assignee_user_id=NULL WHERE id='s-bob'").run();
  assert.equal(verify(second.detail),"stale");
  assert.equal((await detailGet("s-bob",bob)).status,200);
  db.close();
});

test("R2d.3g inherited project revision, membership revocation and session revocation fail closed",async()=>{
  const fx=fixture();const carol=login(fx,"carol");
  const tokenHash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('family-project','family-area','Family project')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('child','family-project','Task child')").run();
  const config={stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:tokenHash};
  const first=await readStagingTemporalDetailInChild(config,"child");
  assert.ok(first?.ok);
  const verify=(r)=>verifyStagingReadBeforeRelease(detailRequest("child",carol),
    {kind:"session",tokenHash},fx.store,"alice",r.detail.linearization,
    undefined,undefined,undefined,undefined,undefined,undefined,r.detail.guard);
  assert.equal(verify(first),"ok");
  db.prepare("UPDATE projects SET title='New title' WHERE id='family-project'").run();
  assert.equal(verify(first),"stale");
  const second=await readStagingTemporalDetailInChild(config,"child");
  assert.ok(second?.ok);
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(verify(second),"stale");
  assert.equal((await detailGet("child",carol)).status,404);
  db.close();
  // Session invalidation takes precedence over a stale Area check.
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"carol").ok,true);
  assert.notEqual(verify(second),"ok");
});

test("R2d.3g strict child allowlist never leaks guard or foreign fields",()=>{
  const task={id:"",title:"Blank",projectId:null,areaId:"a",areaKind:"private",
    status:"open",completedAtMs:null,dueOn:null};
  const linearization={actorUserId:"alice",areas:[
    {areaId:"a",areaKind:"private",access:"private-owner",policyRevision:0}]};
  const guard={taskId:"",projectId:null,areaId:"a",taskRevision:0,parentRevision:null};
  const payload={ok:true,task,linearization,guard};
  assert.deepEqual(parseStagingTemporalDetail(payload,"")?.detail.task,task);
  assert.equal(parseStagingTemporalDetail({...payload,task:{...task,assigneeUserId:"alice"}},""),null);
  assert.equal(parseStagingTemporalDetail({...payload,guard:{...guard,areaId:"foreign"}},""),null);
  assert.equal(parseStagingTemporalDetail({...payload,guard:{...guard,parentRevision:0}},""),null);
  assert.equal(parseStagingTemporalDetail({...payload,linearization:{...linearization,areas:[]}},""),null);
  assert.equal(parseStagingTemporalDetail({...payload,extra:"bad"},""),null);
});
