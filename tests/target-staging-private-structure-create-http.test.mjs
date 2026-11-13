/** Real-route + real SQLite acceptance for default-off owner-private project creation. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const original=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r3-project-create-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+
    Buffer.alloc(16,1).toString("base64url")+":"+
    Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"r3-project-create-http-test-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PRIVATE_STRUCTURE_CREATE_WITNESS_MAX_BYTES}
  =await import("../lib/target-store-bootstrap.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {TARGET_STAGING_JOURNAL_FILENAME}=await import("../lib/target-staging-anchor-journal.ts");
const {PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX,
  PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX,
  PRIVATE_STRUCTURE_CREATE_CANCEL_PREFIX}=await import("../lib/target-private-structure-create-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
// Use the test-only provisioned owner-cookie fixture; production must fail closed.
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {POST:PROJECT}=await import("../app/api/target-staging/projects/route.ts");
const {POST:PROJECT_STATUS}=await import("../app/api/target-staging/projects/create-status/route.ts");
const {POST:PROJECT_RECOVERY}=await import("../app/api/target-staging/projects/create-recovery/route.ts");
const {POST:CHILD}=await import("../app/api/target-staging/project-tasks/route.ts");
const {POST:CHILD_STATUS}=await import("../app/api/target-staging/project-tasks/create-status/route.ts");
const {POST:CHILD_RECOVERY}=await import("../app/api/target-staging/project-tasks/create-recovery/route.ts");
const {POST:PROJECT_CANCEL}=await import("../app/api/target-staging/projects/create-cancel/route.ts");
const {POST:CHILD_CANCEL}=await import("../app/api/target-staging/project-tasks/create-cancel/route.ts");
const {GET:PROJECT_TARGETS}=await import("../app/api/target-staging/projects/create-targets/route.ts");
const {isTargetReadRequest}=await import("../lib/target-edit-fetch.ts");
const {privateStructureActorScope}=await import("../lib/target-private-structure-owner-scope.ts");

const fixtures=[];
function assertValidStore(fx){
  for(const mode of ["stage","r2-model"]){
    const check=inspectIsolatedTargetStore({stagingDirectory:fx.stage.directory,
      expectedOwnerUserId:"alice",expectedRestoreGeneration:fx.stage.restoreGeneration,mode});
    assert.equal(check.ok,true,JSON.stringify(check));
  }
}
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('bob-space','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES('bob-private','Foreign','private','bob-space','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('team-area','Shared','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','bob','editor')").run();
  db.close();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={stage,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
  fixtures.push(fx);return fx;
}
after(()=>{
  for(const [key,value] of Object.entries(original)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const owner=()=>sessionCookieName+"="+createSessionToken();
function session(fx,userId){
  const result=durable.issueDurableTargetStagingSession(fx.store,userId,900);
  assert.equal(result.ok,true,JSON.stringify(result));
  return {cookie:durable.TARGET_STAGING_SESSION_COOKIE+"="+result.sessionToken,
    sessionId:result.sessionId};
}
const project=(fx,changes={})=>({
  projectId:randomUUID(),commandId:randomUUID(),
  areaId:fx.stage.unassignedAreaId,restoreGeneration:fx.stage.restoreGeneration,
  title:"Synthetic owner project",...changes,
});
const child=(fx,projectId,changes={})=>({
  taskId:randomUUID(),commandId:randomUUID(),projectId,
  restoreGeneration:fx.stage.restoreGeneration,title:"Synthetic project child",...changes,
});
const base="http://localhost:3001/api/target-staging";
function request(endpoint,data,cookie=owner(),headers={}){
  return new Request(base+endpoint,{method:"POST",headers:{
    ...(cookie?{cookie}:{}),origin:"http://localhost:3001",
    "x-lumi-target-protocol":"1","content-type":"application/json",
    "x-forwarded-for":"10.9.18.1",...headers,
  },body:JSON.stringify(data)});
}
const call=(handler,endpoint,data,cookie)=>handler(request(endpoint,data,cookie));
async function checked(response,status){
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.doesNotMatch(JSON.stringify(data),/Synthetic|bob-private|team-area|receipt-v1/);
  return data;
}
const cp=(cmd,cookie)=>call(PROJECT,"/projects",cmd,cookie);
const cs=(cmd,cookie)=>call(PROJECT_STATUS,"/projects/create-status",cmd,cookie);
const cr=(cmd,cookie)=>call(PROJECT_RECOVERY,"/projects/create-recovery",
  {commandId:cmd.commandId},cookie);
const ct=(cmd,cookie)=>call(CHILD,"/project-tasks",cmd,cookie);
const cts=(cmd,cookie)=>call(CHILD_STATUS,"/project-tasks/create-status",cmd,cookie);
const ctr=(cmd,cookie)=>call(CHILD_RECOVERY,"/project-tasks/create-recovery",
  {commandId:cmd.commandId},cookie);
const scoped=(actor="alice")=>privateStructureActorScope(actor,
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION);
const pc=(cmd,cookie,ownerScope=scoped())=>call(PROJECT_CANCEL,"/projects/create-cancel",
  {commandId:cmd.commandId,ownerScope},cookie);
const tc=(cmd,cookie,ownerScope=scoped())=>call(CHILD_CANCEL,"/project-tasks/create-cancel",
  {commandId:cmd.commandId,ownerScope},cookie);
const targets=(cookie=owner())=>PROJECT_TARGETS(new Request(base+"/projects/create-targets",{
  method:"GET",headers:{cookie,"x-forwarded-for":"10.9.18.1"},
}));
function state(fx){
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{
    const n=(table)=>db.prepare("SELECT COUNT(*) AS n FROM "+table).get().n;
    return {
      projects:n("projects"),tasks:n("tasks"),changes:n("change_log"),
      receipts:db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX+"%").n,
      witnesses:db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX+"%").n,
      cancels:db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(PRIVATE_STRUCTURE_CREATE_CANCEL_PREFIX+"%").n,
      project:db.prepare("SELECT id,title,area_id,revision FROM projects LIMIT 1").get(),
      task:db.prepare("SELECT id,title,area_id,project_id,assignee_user_id,status,revision FROM tasks LIMIT 1").get(),
      metadata:JSON.stringify(db.prepare("SELECT key,value FROM metadata").all()),
      journal:readFileSync(path.join(fx.stage.directory,TARGET_STAGING_JOURNAL_FILENAME),"utf8"),
    };
  }finally{db.close();}
}
test("project and project-child create, replay and content-free ledger/journal",async()=>{
  const fx=fixture(),p=project(fx);
  const initial=state(fx);
  const first=await checked(await cp(p),201);
  assert.equal(first.id,p.projectId);
  assertValidStore(fx);
  assert.deepEqual(await checked(await cp(p),200),{ok:true,id:p.projectId,replayed:true});
  assert.deepEqual(await checked(await cs(p),200),{status:"committed",id:p.projectId});
  assert.deepEqual(await checked(await cr(p),200),{status:"committed",id:p.projectId});
  const t=child(fx,p.projectId);
  assert.deepEqual(await checked(await ct(t),201),{ok:true,id:t.taskId});
  assertValidStore(fx);
  assert.deepEqual(await checked(await ct(t),200),{ok:true,id:t.taskId,replayed:true});
  assert.deepEqual(await checked(await cts(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
  assert.deepEqual(await checked(await ctr(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
  const after=state(fx);
  assert.equal(after.projects,initial.projects+1);
  assert.equal(after.tasks,initial.tasks+1);
  assert.equal(after.receipts,2);
  assert.equal(after.witnesses,2);
  assert.equal(after.project.area_id,p.areaId);
  assert.equal(after.task.project_id,p.projectId);
  assert.equal(after.task.area_id,null,"child must inherit, not store its own Area");
  assert.equal(after.task.assignee_user_id,null);
  assert.equal(after.task.status,"open");
  assert.equal(after.task.revision,0);
  assert.equal(after.project.revision,0);
  assert.match(after.journal,/"k":"project_create"/);
  assert.match(after.journal,/"k":"project_task_create"/);
  assert.doesNotMatch(after.journal+after.metadata,/Synthetic owner project|Synthetic project child/);
  assert.equal(after.changes,initial.changes+2,"replays must not create a second event");
});
test("project Area must be explicitly owner-private; foreign, shared, missing and invalid rejected",async()=>{
  const fx=fixture(),p=project(fx);
  for(const areaId of ["bob-private","team-area","absent"]){
    await checked(await cp(project(fx,{areaId})),404);
  }
  await checked(await cp({...p,areaId:undefined}),400);
  await checked(await cp({...p,scope:"shared"}),400);
  await checked(await cp(project(fx,{restoreGeneration:randomUUID()})),409);
  await checked(await cs(project(fx,{restoreGeneration:randomUUID()})),404);
  assert.deepEqual(await checked(await cr(p),200),{status:"not_recorded"});
  assert.equal(state(fx).receipts,0);
});
test("child rejects foreign, missing, shared and client-supplied Areas",async()=>{
  const fx=fixture(),p=project(fx);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const foreign=randomUUID(),shared=randomUUID();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
    .run(foreign,"bob-private","Foreign");
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
    .run(shared,"team-area","Shared");
  db.close();
  for(const projectId of [foreign,shared,randomUUID()]){
    await checked(await ct(child(fx,projectId)),404);
  }
  await checked(await ct(child(fx,p.projectId)),404,"parent not created");
  await checked(await cp(p),201);
  await checked(await ct(child(fx,p.projectId,{areaId:p.areaId})),400);
  await checked(await ct(child(fx,p.projectId,{restoreGeneration:randomUUID()})),409);
  assert.equal(state(fx).receipts,1);
});
test("actor-scoped receipts forbid command reuse, and stolen commands cannot replay",async()=>{
  const fx=fixture(),p=project(fx);
  await checked(await cp(p),201);
  await checked(await cp({...p,projectId:randomUUID()}),409);
  await checked(await cp({...p,title:"Changed"}),409);
  const bob=session(fx,"bob");
  await checked(await cp(p,bob.cookie),404);
  assert.deepEqual(await checked(await cr(p,bob.cookie),200),{status:"not_recorded"});
  await checked(await cs(p,bob.cookie),404);
  const t=child(fx,p.projectId);
  await checked(await ct(t),201);
  await checked(await ct({...t,taskId:randomUUID()}),409);
  await checked(await ct({...t,title:"Changed"}),409);
  await checked(await ct(t,bob.cookie),404);
  assert.deepEqual(await checked(await ctr(t,bob.cookie),200),{status:"not_recorded"});
});
test("revoked durable session cannot create, confirm or recover",async()=>{
  const fx=fixture(),p=project(fx),live=session(fx,"alice");
  await checked(await cp(p,live.cookie),201);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  const response=await checked(await cp(p,live.cookie),401);
  assert.equal(response.code,"session_revoked");
  assert.equal((await checked(await cs(p,live.cookie),401)).code,"session_revoked");
  assert.equal((await checked(await cr(p,live.cookie),401)).code,"session_revoked");
  const t=child(fx,p.projectId);
  assert.equal((await checked(await ct(t,live.cookie),401)).code,"session_revoked");
  assert.equal((await checked(await ctr(t,live.cookie),401)).code,"session_revoked");
});
test("creation flags are independently default-off, recovery POSTs enter shared read queue",async()=>{
  const fx=fixture(),p=project(fx),t=child(fx,p.projectId);
  delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED;
  await checked(await cp(p),404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED="true";
  delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED;
  await checked(await ct(t),404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED="true";
  for(const endpoint of [
    "/projects/create-status","/projects/create-recovery",
    "/project-tasks/create-status","/project-tasks/create-recovery",
  ])assert.equal(isTargetReadRequest(base+endpoint,{method:"POST"}),true,endpoint);
  assert.equal(isTargetReadRequest(base+"/projects",{method:"POST"}),false);
  assert.equal(isTargetReadRequest(base+"/project-tasks",{method:"POST"}),false);
  assert.equal(state(fx).receipts,0);
});
test("tombstoned IDs cannot be reused even with a fresh command ID",async()=>{
  const fx=fixture(),id=randomUUID(),taskId=randomUUID(),live=randomUUID();
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("BEGIN IMMEDIATE");
  try{
    const nextSeq=()=>db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM change_log")
      .get().seq;
    const tombstoneProject=db.prepare(
      "INSERT INTO project_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES(?,?,?,?,?)");
    const tombstoneTask=db.prepare(
      "INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES(?,?,?,?,?)");
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
      .run(id,fx.stage.unassignedAreaId,"Deleted project");
    tombstoneProject.run(id,fx.stage.unassignedAreaId,1,nextSeq(),Date.now());
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
      .run(live,fx.stage.unassignedAreaId,"Live project");
    db.prepare("INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)")
      .run(taskId,live,"Deleted child");
    tombstoneTask.run(taskId,fx.stage.unassignedAreaId,1,nextSeq(),Date.now());
    db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
    db.exec("COMMIT");
  }catch(error){
    db.exec("ROLLBACK");
    throw error;
  }finally{db.close();}
  // The fixtures must themselves pass canonical preflight. A raw DELETE without
  // a matching next-revision tombstone fails SQLite's deletion guard.
  assertValidStore(fx);
  await checked(await cp(project(fx,{projectId:id})),404);
  await checked(await ct(child(fx,live,{taskId})),404);
  assertValidStore(fx);
  assert.equal(state(fx).receipts,0);
});

test("child creation accepts an existing private text-ID project with exact parent identity",async()=>{
  const fx=fixture(),id="alice-private-project";
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
    .run(id,fx.stage.unassignedAreaId,"Existing private project");
  db.close();
  const t=child(fx,id);
  assert.deepEqual(await checked(await ct(t),201),{ok:true,id:t.taskId});
  assertValidStore(fx);
  assert.deepEqual(await checked(await ct(t),200),{ok:true,id:t.taskId,replayed:true});
  assert.deepEqual(await checked(await cts(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
  assert.deepEqual(await checked(await ctr(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
  const verify=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{
    const row=verify.prepare("SELECT project_id,area_id FROM tasks WHERE id=?").get(t.taskId);
    assert.equal(row.project_id,id);
    assert.equal(row.area_id,null);
  }finally{verify.close();}
  await checked(await ct(child(fx,id.toUpperCase())),404);
  await checked(await ct(child(fx,"unknown-private-parent")),404);
});

test("maximum-length escaped existing project IDs preserve preflight, replay and recovery",async()=>{
  const fx=fixture();
  // JSON.stringify expands quotes and backslashes. Both are legal 512-byte
  // private project IDs even though their serialized witness exceeds 900 bytes.
  const parentIds=[String.fromCharCode(92).repeat(512),String.fromCharCode(34).repeat(512)];
  const db=new DatabaseSync(fx.stage.databasePath);
  for(const id of parentIds){
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
      .run(id,fx.stage.unassignedAreaId,"Synthetic escaped private parent");
  }
  db.close();
  assertValidStore(fx);
  for(const id of parentIds){
    const t=child(fx,id);
    assert.deepEqual(await checked(await ct(t),201),{ok:true,id:t.taskId});
    // A valid CREATE must not leave metadata that blocks the very next
    // canonical preflight or read-only status and recovery.
    assertValidStore(fx);
    assert.deepEqual(await checked(await ct(t),200),{ok:true,id:t.taskId,replayed:true});
    assert.deepEqual(await checked(await cts(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
    assert.deepEqual(await checked(await ctr(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
    const verify=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
    try{
      const row=verify.prepare("SELECT project_id,area_id FROM tasks WHERE id=?").get(t.taskId);
      assert.equal(row.project_id,id);
      assert.equal(row.area_id,null);
      const rows=verify.prepare("SELECT value FROM metadata WHERE key LIKE ?")
        .all(PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX+"%");
      const witness=rows.find(r=>JSON.parse(r.value).projectId===id);
      assert.ok(witness,"CREATE stores a recoverable witness for its exact parent ID");
      const bytes=Buffer.byteLength(witness.value,"utf8");
      assert.ok(bytes>900,"exercise the former broken 900-byte limit");
      assert.ok(bytes<=TARGET_STAGING_PRIVATE_STRUCTURE_CREATE_WITNESS_MAX_BYTES);
      const reply=JSON.stringify({ok:true,status:"committed",id:t.taskId,
        projectId:id,areaId:fx.stage.unassignedAreaId});
      assert.ok(Buffer.byteLength(reply,"utf8")>1024,
        "recovery child reply must exercise the generic writer's former 1024-byte limit");
    }finally{verify.close();}
  }
  assertValidStore(fx);
});

test("canonical preflight fails closed on malformed structure recovery witnesses",async()=>{
  const fx=fixture(),p=project(fx);
  await checked(await cp(p),201);
  assertValidStore(fx);
  const db=new DatabaseSync(fx.stage.databasePath);
  const row=db.prepare("SELECT key,value FROM metadata WHERE key LIKE ?").get(
    PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX+"%");
  db.prepare("UPDATE metadata SET value=? WHERE key=?").run(
    JSON.stringify({...JSON.parse(row.value),title:"must not appear in receipt"}),row.key);
  db.close();
  const invalid=inspectIsolatedTargetStore({stagingDirectory:fx.stage.directory,
    expectedOwnerUserId:"alice",expectedRestoreGeneration:fx.stage.restoreGeneration});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.issues.includes("metadata_invalid"),JSON.stringify(invalid));
});

test("canonical preflight rejects a receipt whose recovery witness was removed",async()=>{
  const fx=fixture(),p=project(fx);
  await checked(await cp(p),201);
  assertValidStore(fx);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("DELETE FROM metadata WHERE key LIKE ?").run(
    PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX+"%");
  db.close();
  const invalid=inspectIsolatedTargetStore({stagingDirectory:fx.stage.directory,
    expectedOwnerUserId:"alice",expectedRestoreGeneration:fx.stage.restoreGeneration});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.issues.includes("metadata_invalid"),JSON.stringify(invalid));
});

test("terminal cancel fences never-delivered project and child POSTs; late POST cannot insert",async()=>{
  const fx=fixture(),p=project(fx),t=child(fx,"legacy-unresolved-parent");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
    .run("legacy-unresolved-parent",fx.stage.unassignedAreaId,"Existing private parent");
  db.close();
  const before=state(fx);
  for(const [command,cancel,create,status] of [
    [p,pc,cp,cs],[t,tc,ct,cts],
  ]){
    assert.deepEqual(await checked(await cancel(command),200),{status:"cancelled"});
    assertValidStore(fx);
    assert.deepEqual(await checked(await cancel(command),200),{status:"cancelled"});
    await checked(await create(command),409,"late create after committed cancel fence");
    assert.deepEqual(await checked(await status(command),200),{status:"not_recorded"});
    assertValidStore(fx);
  }
  const after=state(fx);
  assert.equal(after.projects,before.projects);
  assert.equal(after.tasks,before.tasks);
  assert.equal(after.receipts,before.receipts);
  assert.equal(after.witnesses,before.witnesses);
  assert.equal(after.cancels,before.cancels+2);
  assert.doesNotMatch(after.metadata,/Synthetic project child|Synthetic owner project/);
  assert.match(after.journal,/"cancel":1/);
});
test("settled cancellation returns content-free proof and never deletes a committed record",async()=>{
  const fx=fixture(),p=project(fx);
  await checked(await cp(p),201);
  assert.deepEqual(await checked(await pc(p),200),{status:"settled"});
  assert.equal(state(fx).cancels,0);
  assert.deepEqual(await checked(await cr(p),200),{status:"committed",id:p.projectId});
  const t=child(fx,p.projectId);
  await checked(await ct(t),201);
  assert.deepEqual(await checked(await tc(t),200),{status:"settled"});
  assert.deepEqual(await checked(await ctr(t),200),{status:"committed",id:t.taskId,projectId:t.projectId});
  assert.equal(state(fx).cancels,0);
  assertValidStore(fx);
});
test("cancel fence keys are actor scoped and retain all owner ACL boundaries",async()=>{
  const fx=fixture(),p=project(fx),bob=session(fx,"bob");
  await checked(await pc(p,bob.cookie,scoped("alice")),404,
    "different actor cannot use original owner's bound marker");
  assert.equal(state(fx).cancels,0);
  assert.deepEqual(await checked(await pc(p,bob.cookie,scoped("bob")),200),
    {status:"cancelled"});
  assertValidStore(fx);
  await checked(await cp(p),201);
  assert.deepEqual(await checked(await pc(p),200),{status:"settled"});
  assertValidStore(fx);
});
test("structure private Area catalog works with all note create flags off",async()=>{
  const fx=fixture();
  for(const key of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED"])process.env[key]="false";
  const result=await targets();
  const data=await checked(result,200);
  assert.deepEqual(data.restoreGeneration,fx.stage.restoreGeneration);
  assert.equal(data.ownerScope,scoped());
  assert.match(data.ownerScope,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(data.areas.some(a=>a.id===fx.stage.unassignedAreaId));
  await checked(await cp(project(fx)),201);
  assertValidStore(fx);
});

test("reauth to same actor retains scope and fences delayed old-session POST; another actor is denied",async()=>{
  const fx=fixture(),first=session(fx,"alice"),second=session(fx,"alice"),
    bob=session(fx,"bob"),p=project(fx),t=child(fx,"legacy-private-project");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES(?,?,?)")
    .run("legacy-private-project",fx.stage.unassignedAreaId,"Original parent");
  db.close();
  const scope1=(await checked(await targets(first.cookie),200)).ownerScope;
  const scope2=(await checked(await targets(second.cookie),200)).ownerScope;
  const bobResponse=await targets(bob.cookie);
  assert.equal(bobResponse.status,200);
  const bobScope=(await bobResponse.json()).ownerScope;
  assert.equal(scope1,scope2,"stable across same-actor durable reauth");
  assert.notEqual(scope1,bobScope,"different actors get distinct opaque witness");
  for(const [command,create,cancel] of [[p,cp,pc],[t,ct,tc]]){
    const countBefore=state(fx).cancels;
    await checked(await cancel(command,bob.cookie,scope1),404);
    assert.equal(state(fx).cancels,countBefore);
    assert.deepEqual(await checked(await cancel(command,second.cookie,scope1),200),
      {status:"cancelled"});
    await checked(await create(command,first.cookie),409,
      "the still-live original session cannot commit after the new session fenced it");
    assertValidStore(fx);
  }
  assert.equal(state(fx).cancels,2);
});
