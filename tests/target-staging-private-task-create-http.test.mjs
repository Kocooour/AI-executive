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
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const original=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r3-task-create-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+
    Buffer.alloc(16,1).toString("base64url")+":"+
    Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"r3-task-create-http-test-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore,TARGET_STAGING_PRIVATE_TASK_CREATE_RECEIPT_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TARGET_STAGING_JOURNAL_FILENAME}=
  await import("../lib/target-staging-anchor-journal.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {POST}=await import("../app/api/target-staging/tasks/route.ts");
const {POST:STATUS}=await import("../app/api/target-staging/tasks/create-status/route.ts");
const {POST:RECOVER}=await import("../app/api/target-staging/tasks/create-recovery/route.ts");
const {POST:CANCEL}=await import("../app/api/target-staging/tasks/create-cancel/route.ts");
const {GET:GET_TASK}=await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const {parseTaskCreateReply,parseTaskCreateStatusReply,parseTaskCreateRecoveryReply}=
  await import("../lib/target-staging-task-create-process.ts");
const {readStagingTemporalDetailInChild}=
  await import("../lib/target-staging-read-process.ts");
const {resolveStagingHttpIdentity,stagingChildSessionConfig}=
  await import("../lib/target-staging-http-identity.ts");
const {releasePrivateTaskCreateCommittedStatus}=
  await import("../lib/target-private-task-create-http.ts");

after(()=>{
  for(const [key,value] of Object.entries(original)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-space','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Private','private','bob-space','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Shared','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  db.close();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return {stage,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function session(fx,userId){
  const result=durable.issueDurableTargetStagingSession(fx.store,userId,900);
  assert.equal(result.ok,true,JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+result.sessionToken;
}
function command(fx,changes={}){
  return {taskId:randomUUID(),commandId:randomUUID(),areaId:fx.stage.unassignedAreaId,
    restoreGeneration:fx.stage.restoreGeneration,title:"Synthetic private task",...changes};
}
const base="http://localhost:3001/api/target-staging/tasks";
function request(url,data,cookie=owner(),headers={}){
  return new Request(url,{method:"POST",headers:{
    ...(cookie?{cookie}:{}),origin:"http://localhost:3001",
    "x-lumi-target-protocol":"1","content-type":"application/json",
    "x-forwarded-for":"10.9.17.35",...headers,
  },body:JSON.stringify(data)});
}
const create=(cmd,cookie,headers)=>POST(request(base,cmd,cookie,headers));
const recover=(cmd,cookie,headers)=>STATUS(request(base+"/create-status",cmd,cookie,headers));
const recoverOpaque=(cmd,cookie,headers)=>RECOVER(
  request(base+"/create-recovery",{commandId:cmd.commandId},cookie,headers));
const cancelOpaque=(cmd,cookie,headers)=>CANCEL(
  request(base+"/create-cancel",{commandId:cmd.commandId},cookie,headers));
async function checked(response,status){
  const value=await response.json();
  assert.equal(response.status,status,JSON.stringify(value));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.doesNotMatch(JSON.stringify(value),/Synthetic private task|bob-private|team-area|receipt_key/);
  return value;
}
function persistence(fx,id){
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{
    const n=(sql,...params)=>db.prepare(sql).get(...params).n;
    return {
      count:n("SELECT COUNT(*) AS n FROM tasks"),
      task:db.prepare("SELECT id,title,area_id,project_id,status,revision FROM tasks WHERE id=?").get(id),
      receipts:n("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
        TARGET_STAGING_PRIVATE_TASK_CREATE_RECEIPT_PREFIX+"%"),
      sequence:n("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"),
      anchor:db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value,
      journal:readFileSync(path.join(fx.stage.directory,TARGET_STAGING_JOURNAL_FILENAME),"utf8"),
    };
  }finally{db.close();}
}
test("private CREATE HTTP inserts once, uses content-free receipt, and survives replay",async()=>{
  const fx=fixture(),cmd=command(fx);
  assert.deepEqual(await checked(await recover(cmd),200),{status:"not_recorded"});
  const before=persistence(fx,cmd.taskId);
  assert.deepEqual(await checked(await create(cmd),201),{ok:true,taskId:cmd.taskId});
  const first=persistence(fx,cmd.taskId);
  assert.deepEqual({...first.task},{
    id:cmd.taskId,title:cmd.title,area_id:cmd.areaId,project_id:null,status:"open",revision:0,
  });
  assert.equal(first.receipts,before.receipts+1);
  assert.equal(first.sequence,before.sequence+1);
  assert.equal(first.journal.includes(cmd.title),false);
  assert.deepEqual(await checked(await recover(cmd),200),{status:"committed"});
  assert.deepEqual(await checked(await recoverOpaque(cmd),200),{status:"committed",taskId:cmd.taskId});
  const read=await GET_TASK(new Request(base+"/"+cmd.taskId,{headers:{cookie:owner()}}),
    {params:Promise.resolve({taskId:cmd.taskId})});
  assert.equal(read.status,200);
  assert.equal((await read.json()).task.id,cmd.taskId);
  assert.deepEqual(await checked(await create(cmd),200),
    {ok:true,taskId:cmd.taskId,replayed:true});
  assert.deepEqual(persistence(fx,cmd.taskId),first);
  assert.deepEqual(await checked(await create({...cmd,taskId:randomUUID()}),409),
    {error:"Revision conflict"});
  assert.deepEqual(await checked(await recover({...cmd,title:"Another"}),409),
    {error:"Revision conflict"});
});
test("live actor and private Area ACL deny foreign and shared writes, without any effects",async()=>{
  const fx=fixture(),bob=session(fx,"bob");
  const own=command(fx,{areaId:"bob-private"});
  assert.equal((await checked(await create(own,bob),201)).taskId,own.taskId);
  assert.deepEqual(await checked(await recover(own,bob),200),{status:"committed"});
  assert.deepEqual(await checked(await recoverOpaque(own,bob),200),{status:"committed",taskId:own.taskId});
  assert.deepEqual(await checked(await recoverOpaque(own),200),{status:"not_recorded"});
  assert.deepEqual(await checked(await recover(own),404),{error:"Not found"});
  assert.equal((await checked(await recover(own,bob+"broken"),401)).code,
    "session_revoked");
  for(const area of [fx.stage.unassignedAreaId,"team-area","missing"]){
    const foreign=command(fx,{areaId:area});
    const before=persistence(fx,foreign.taskId);
    assert.deepEqual(await checked(await create(foreign,bob),404),{error:"Not found"});
    assert.deepEqual(persistence(fx,foreign.taskId),before);
  }
  const shared=command(fx,{areaId:"team-area"});
  assert.deepEqual(await checked(await create(shared),404),{error:"Not found"});
  assert.deepEqual(await checked(await recover(shared),404),{error:"Not found"});
});
test("durable revocation denies create and status and leaves journal untouched",async()=>{
  const fx=fixture(),bob=session(fx,"bob"),cmd=command(fx,{areaId:"bob-private"});
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live=durable.verifyDurableTargetStagingSessionLive(fx.store,tokenHash);
  assert.ok(live?.sessionId);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  const before=persistence(fx,cmd.taskId);
  assert.equal((await checked(await create(cmd,bob),401)).code,"session_revoked");
  assert.equal((await checked(await recover(cmd,bob),401)).code,"session_revoked");
  assert.equal((await checked(await recoverOpaque(cmd,bob),401)).code,"session_revoked");
  assert.deepEqual(persistence(fx,cmd.taskId),before);
});
test("flags, origin, protocol, shape and restore fence fail closed",async()=>{
  const fx=fixture(),cmd=command(fx),before=persistence(fx,cmd.taskId);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED="false";
  assert.equal((await checked(await create(cmd),404)).error,"Not found");
  assert.equal((await checked(await recover(cmd),404)).error,"Not found");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED="true";
  assert.equal((await checked(await create(cmd,""),401)).error!==undefined,true);
  assert.equal((await checked(await create(cmd,owner(),{origin:"https://foreign.invalid"}),403)).error,
    "Cross-origin request rejected");
  assert.equal((await checked(await create(cmd,owner(),{"x-lumi-target-protocol":"0"}),400)).code,
    "protocol_unsupported");
  for(const change of [{projectId:null},{workspaceId:"team"},{assigneeUserId:"bob"},
    {actorUserId:"bob"},{taskId:"NOT-UUID"},{title:" x "},{areaId:null}]){
    assert.equal((await checked(await create({...cmd,...change}),400)).error,"Invalid request");
  }
  assert.equal((await checked(await create({...cmd,entities:[]}),400)).code,
    "legacy_snapshot_rejected");
  assert.equal((await checked(await create({...cmd,restoreGeneration:randomUUID()}),409)).code,
    "resync_required");
  assert.deepEqual(persistence(fx,cmd.taskId),before);
});
test("create status cannot confirm a deleted task or resurrect its tombstone",async()=>{
  const fx=fixture(),cmd=command(fx);
  assert.deepEqual(await checked(await create(cmd),201),{ok:true,taskId:cmd.taskId});
  assert.deepEqual(await checked(await recover(cmd),200),{status:"committed"});
  // Deterministically freeze the actual worker's pre-delete snapshot. The
  // following response is released only AFTER a real SQLite DELETE commits.
  const statusRequest=request(base+"/create-status",cmd);
  const identity=resolveStagingHttpIdentity(statusRequest);
  assert.ok(identity);
  const preDelete=await readStagingTemporalDetailInChild({
    stagingDirectory:fx.stage.directory,
    expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",
    ...stagingChildSessionConfig(identity),
  },cmd.taskId);
  assert.equal(preDelete?.ok,true,"real pre-delete worker must see the task");
  assert.deepEqual(await checked(releasePrivateTaskCreateCommittedStatus(
    statusRequest,identity,fx.store,"alice",cmd,preDelete),200),{status:"committed"});
  const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
  const authority=new TargetStagingSessionAuthority(fx.store);
  try{
    const write=authority.issueWritable("alice");
    assert.ok(write);
    const preview=authority.previewTaskTitleEdit(write.sessionToken,{taskId:cmd.taskId});
    assert.equal(preview.ok,true);
    assert.deepEqual(authority.deleteTask(write.sessionToken,{
      taskId:cmd.taskId,commandId:randomUUID(),
      expectedRevision:preview.snapshotRevision,writeAreaId:cmd.areaId,
      restoreGeneration:cmd.restoreGeneration,
    },true),{ok:true});
  }finally{authority.close();}
  const afterDelete=persistence(fx,cmd.taskId);
  assert.equal(afterDelete.task,undefined);
  assert.deepEqual(await checked(releasePrivateTaskCreateCommittedStatus(
    statusRequest,identity,fx.store,"alice",cmd,preDelete),404),
    {error:"Not found"},"a pre-delete snapshot must fail the live task guard");
  assert.deepEqual(await checked(await recover(cmd),404),{error:"Not found"});
  assert.deepEqual(await checked(await recoverOpaque(cmd),404),{error:"Not found"});
  assert.deepEqual(await checked(await create(cmd),404),{error:"Not found"});
  assert.deepEqual(await checked(await create({...cmd,commandId:randomUUID()}),404),
    {error:"Not found"});
  assert.deepEqual(persistence(fx,cmd.taskId),afterDelete,
    "failed recovery/retries must not alter receipt, journal or tombstones");
});
test("revocation between status snapshot and release fails closed",async()=>{
  const fx=fixture(),bob=session(fx,"bob"),cmd=command(fx,{areaId:"bob-private"});
  assert.deepEqual(await checked(await create(cmd,bob),201),{ok:true,taskId:cmd.taskId});
  const statusRequest=request(base+"/create-status",cmd,bob);
  const identity=resolveStagingHttpIdentity(statusRequest);
  assert.ok(identity);
  const observed=await readStagingTemporalDetailInChild({
    stagingDirectory:fx.stage.directory,
    expectedRestoreGeneration:fx.stage.restoreGeneration,
    ownerUserId:"alice",
    ...stagingChildSessionConfig(identity),
  },cmd.taskId);
  assert.equal(observed?.ok,true);
  const live=durable.verifyDurableTargetStagingSessionLive(fx.store,identity.tokenHash);
  assert.ok(live?.sessionId);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  assert.equal((await checked(releasePrivateTaskCreateCommittedStatus(
    statusRequest,identity,fx.store,"alice",cmd,observed),401)).code,
    "session_revoked","recovery must recheck the live session before releasing");
});
test("exact content-free child DTO parsing rejects all extra properties",()=>{
  assert.deepEqual(parseTaskCreateReply({ok:true,replayed:true}),{ok:true,replayed:true});
  assert.deepEqual(parseTaskCreateStatusReply({ok:true,status:"committed"}),
    {ok:true,status:"committed"});
  assert.deepEqual(parseTaskCreateRecoveryReply({ok:true,status:"committed",
    taskId:randomUUID(),areaId:"safe"}).status,"committed");
  assert.deepEqual(parseTaskCreateRecoveryReply({ok:true,status:"not_recorded"}),
    {ok:true,status:"not_recorded"});
  assert.equal(parseTaskCreateRecoveryReply({ok:true,status:"committed",title:"leak"}),null);
  for(const reply of [{ok:true,taskId:randomUUID()},{ok:true,replayed:false},
    {ok:false,reason:"unauthorized"},{ok:false,reason:"write_failed",title:"leak"}])
    assert.equal(parseTaskCreateReply(reply),null);
  for(const reply of [{ok:true,status:"committed",taskId:randomUUID()},
    {ok:true,status:"unknown"},{ok:false,reason:"session_revoked"}])
    assert.equal(parseTaskCreateStatusReply(reply),null);
});

test("opaque recovery stays content-free and actor-bound on real SQLite",async()=>{
  const fx=fixture(),cmd=command(fx),bob=session(fx,"bob");
  assert.deepEqual(await checked(await recoverOpaque(cmd),200),{status:"not_recorded"});
  assert.deepEqual(await checked(await create(cmd),201),{ok:true,taskId:cmd.taskId});
  assert.deepEqual(await checked(await recoverOpaque(cmd),200),{status:"committed",taskId:cmd.taskId});
  assert.deepEqual(await checked(await recoverOpaque(cmd,bob),200),
    {status:"not_recorded"},"another actor has no matching receipt");
  assert.deepEqual(await checked(await recoverOpaque({...cmd,commandId:randomUUID()}),200),
    {status:"not_recorded"},"random UUID never exposes a title or task ID");
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{
    const rows=db.prepare("SELECT key,value FROM metadata WHERE key LIKE ?")
      .all("r3:private-task-create-recovery-v1:%");
    assert.equal(rows.length,1);
    assert.equal(JSON.stringify(rows).includes(cmd.title),false);
    assert.equal(JSON.stringify(rows).includes(cmd.commandId),false);
    assert.equal(JSON.stringify(rows).includes(cmd.taskId),true);
  }finally{db.close();}
});

test("terminal cancel HTTP is actor-scoped and blocks a late CREATE without new task",async()=>{
  const fx=fixture(),cookie=session(fx,"alice"),cmd=command(fx);
  const before=persistence(fx,cmd.taskId);
  assert.deepEqual(await checked(await cancelOpaque(cmd,cookie),200),
    {status:"cancelled"});
  assert.deepEqual(await checked(await cancelOpaque(cmd,cookie),200),
    {status:"cancelled"},"repeat cancellation is idempotent");
  assert.deepEqual(await checked(await create(cmd,cookie),409),
    {error:"Revision conflict"},"late CREATE must be rejected by the pinned fence");
  const after=persistence(fx,cmd.taskId);
  assert.equal(after.count,before.count);
  assert.equal(after.receipts,before.receipts);
  assert.equal(after.sequence,before.sequence);
  assert.deepEqual(await checked(await recoverOpaque(cmd,cookie),200),
    {status:"not_recorded"},"receipt is not proof that an old CREATE can still write");
  const next=command(fx);
  assert.deepEqual(await checked(await create(next,cookie),201),
    {ok:true,taskId:next.taskId},"a new UUID can be created");
});
test("cancel cannot disguise committed task; invalid requests stay fail-closed",async()=>{
  const fx=fixture(),cookie=session(fx,"alice"),cmd=command(fx);
  assert.deepEqual(await checked(await create(cmd,cookie),201),
    {ok:true,taskId:cmd.taskId});
  const committed=persistence(fx,cmd.taskId);
  assert.deepEqual(await checked(await cancelOpaque(cmd,cookie),200),
    {status:"settled"});
  assert.deepEqual(persistence(fx,cmd.taskId),committed);
  assert.deepEqual(await checked(await CANCEL(request(base+"/create-cancel",
    {commandId:cmd.commandId,actor:"alice"},cookie)),400),{error:"Invalid request"});
  assert.equal((await cancelOpaque(cmd,null)).status,401);
  assert.equal((await CANCEL(request(base+"/create-cancel",
    {commandId:cmd.commandId},cookie,{origin:"https://foreign.invalid"}))).status,403);
});

test("deleted CREATE: signed actor gets terminal no-future-write proof without task data",async()=>{
  const fx=fixture(),cookie=session(fx,"alice"),cmd=command(fx);
  assert.deepEqual(await checked(await create(cmd,cookie),201),
    {ok:true,taskId:cmd.taskId});
  const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
  const authority=new TargetStagingSessionAuthority(fx.store);
  try{
    const write=authority.issueWritable("alice");
    assert.ok(write);
    const preview=authority.previewTaskTitleEdit(write.sessionToken,{taskId:cmd.taskId});
    assert.equal(preview.ok,true);
    assert.deepEqual(authority.deleteTask(write.sessionToken,{
      taskId:cmd.taskId,commandId:randomUUID(),
      expectedRevision:preview.snapshotRevision,writeAreaId:cmd.areaId,
      restoreGeneration:cmd.restoreGeneration,
    },true),{ok:true});
  }finally{authority.close();}
  const deleted=persistence(fx,cmd.taskId);
  assert.equal(deleted.task,undefined);
  assert.deepEqual(await checked(await recover(cmd,cookie),404),
    {error:"Not found"},"detail-guarded status must not release deleted task");
  assert.deepEqual(await checked(await recoverOpaque(cmd,cookie),404),
    {error:"Not found"},"reload recovery must not reveal deleted task ID");
  const settled=await checked(await cancelOpaque(cmd,cookie),200);
  assert.deepEqual(settled,{status:"settled"},"immutable receipt is terminal proof");
  assert.equal(JSON.stringify(settled).includes(cmd.taskId),false);
  assert.deepEqual(await checked(await cancelOpaque(cmd,cookie),200),
    {status:"settled"},"receipt-based terminal proof is idempotent");
  assert.deepEqual(persistence(fx,cmd.taskId),deleted,
    "settlement may not revive a task or mutate durable metadata");
  assert.deepEqual(await checked(await create(cmd,cookie),404),
    {error:"Not found"},"old command cannot insert after deletion");
  assert.deepEqual(await checked(await create({...cmd,taskId:randomUUID()},cookie),409),
    {error:"Revision conflict"},"old UUID with a different task ID conflicts");
  const next=command(fx);
  assert.deepEqual(await checked(await create(next,cookie),201),
    {ok:true,taskId:next.taskId},"a new command UUID may create");
  assert.equal((await cancelOpaque(cmd,null)).status,401,
    "a missing authenticated session cannot query the original receipt");
});
