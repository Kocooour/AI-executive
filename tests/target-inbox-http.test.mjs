import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const envKeys=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-http-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"legacy not touched");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-inbox-http-secret-longer-than-thirty-two",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/inbox/route.ts");
const {POST:TRIAGE}=await import("../app/api/target-staging/inbox/triage/route.ts");
const {POST:RECEIPT}=await import("../app/api/target-staging/inbox/receipt/route.ts");
const {readStagingTargetInboxInChild}=await import("../lib/target-staging-read-process.ts");
const {resolveStagingHttpIdentity,stagingChildSessionConfig,verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let counter=0;const all=[];
after(()=>{
  for(const fx of all)fx.db.close();
  for(const [k,v] of Object.entries(before)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"legacy not touched");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++counter)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const user of ["bob","cara"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(user+"-ws",user);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(user+"-private",user,user+"-ws",user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('shared','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('area-shared','Shared','shared','shared','alice')").run();
  for(const [user,role] of [["alice","admin"],["bob","editor"],["cara","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('area-shared',?,?)")
      .run(user,role);
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title,due_on) VALUES (?,?,?,?)");
  insert.run("alice-only",stage.unassignedAreaId,"Private Alice","2027-11-08");
  insert.run("bob-only","bob-private","Private Bob",null);
  insert.run("shared-task","area-shared","Shared Task",null);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=100 WHERE id='shared-task'").run();
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={stage,db,store};all.push(fx);return fx;
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function session(fx,who){
  const result=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(result.ok,true,JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+result.sessionToken;
}
const base="http://localhost:3001/api/target-staging/inbox";
const read=(cookie=owner(),suffix="")=>GET(new Request(base+suffix,{
  headers:{cookie,"x-forwarded-for":"10.61.3.7"},
}));
function post(kind,command,cookie=owner(),options={}){
  return (kind==="receipt"?RECEIPT:TRIAGE)(new Request(base+"/"+kind,{
    method:"POST",
    headers:{cookie,"content-type":"application/json",
      "x-forwarded-for":"10.61.3.7",
      ...(options.origin===null?{}:{origin:options.origin??"http://localhost:3001"}),
      ...(options.protocol===null?{}:{"x-lumi-target-protocol":options.protocol??"1"})},
    body:JSON.stringify(command),
  }));
}
async function ok(promise){
  const response=await promise,body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  return body;
}
function cmd(row,store,mode="process",prior=null){
  return {commandId:randomUUID(),taskId:row.id,mode,undoOfCommandId:prior,
    expectedRevision:row.expectedRevision,
    expectedTriageRevision:row.triageRevision,writeAreaId:row.effectiveAreaId,
    restoreGeneration:store.expectedRestoreGeneration};
}
const ids=body=>body.items.map(x=>x.id);

test("C-3a: GET is default-off and no identity returns no titles or count",async()=>{
  fixture();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED="false";
  assert.equal((await read()).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED="true";
  assert.equal((await read("")).status,401);
  assert.equal((await read(owner(),"?limit=0")).status,400);
  const b=await ok(read());
  assert.deepEqual(ids(b),["alice-only","shared-task"]);
  assert.equal(b.count,2);
  assert.deepEqual(Object.keys(b).sort(),["count","items","nextCursor","restoreGeneration","snapshotRevision"]);
  assert.match(b.snapshotRevision,/^[a-f0-9]{64}$/);
  assert.equal("linearization" in b,false);
  assert.equal("areaEpochs" in b,false);
  assert.equal(b.items.find(x=>x.id==="shared-task").status,"completed");
  assert.equal(b.items.find(x=>x.id==="shared-task").canProcess,true);
  assert.match(b.items[0].expectedRevision,/^[a-f0-9]{64}$/);
  assert.deepEqual(ids(await ok(read(owner(),"?limit=1"))),["alice-only"]);
});

test("C-3a: private isolation, viewer read-only, revoked member loses count",async()=>{
  const fx=fixture(),bob=session(fx,"bob"),cara=session(fx,"cara");
  assert.deepEqual(ids(await ok(read(bob))),["bob-only","shared-task"]);
  const viewer=await ok(read(cara));
  assert.deepEqual(ids(viewer),["shared-task"]);
  assert.equal(viewer.count,1);
  assert.equal(viewer.items[0].canProcess,false);
  assert.equal(viewer.items[0].expectedRevision,null);
  const raw=await ok(read(bob));
  const process=cmd(raw.items.find(x=>x.id==="shared-task"),fx.store);
  assert.equal((await post("triage",process,cara)).status,404);
  assert.equal((await post("triage",process,bob)).status,200);
  fx.db.prepare("DELETE FROM area_members WHERE area_id='area-shared' AND user_id='cara'").run();
  const afterRevocation=await ok(read(cara));
  assert.equal(afterRevocation.count,0);
  assert.deepEqual(afterRevocation.items,[]);
  const status=await post("receipt",process,cara);
  assert.notEqual(status.status,200,"no receipts after ACL revoke");
  assert.deepEqual(ids(await ok(read(bob))),["bob-only"]);
});

test("C-3a: Process, idempotence, receipt, atomic Undo, completion-independent",async()=>{
  const fx=fixture();
  const first=await ok(read());
  const row=first.items.find(x=>x.id==="shared-task");
  const process=cmd(row,fx.store);
  const beforeTask=fx.db.prepare("SELECT status,completed_at_ms,due_on,area_id,triage_revision FROM tasks WHERE id='shared-task'").get();
  assert.deepEqual(await ok(post("triage",process)),{ok:true});
  assert.deepEqual(await ok(post("triage",process)),{ok:true,replayed:true});
  assert.equal((await ok(read())).count,1);
  const confirmation=await ok(post("receipt",process));
  assert.equal(confirmation.status,"committed");
  assert.match(confirmation.next.expectedRevision,/^[a-f0-9]{64}$/);
  assert.equal(confirmation.next.triageRevision,1);
  assert.equal("areaEpochs" in confirmation,false);
  const undo={...cmd({...row,expectedRevision:confirmation.next.expectedRevision,
      triageRevision:confirmation.next.triageRevision,
      effectiveAreaId:confirmation.next.writeAreaId},fx.store,"undo",process.commandId)};
  assert.deepEqual(await ok(post("triage",undo)),{ok:true});
  assert.deepEqual(await ok(post("triage",undo)),{ok:true,replayed:true});
  assert.equal((await ok(read())).count,2);
  const afterTask=fx.db.prepare("SELECT status,completed_at_ms,due_on,area_id,triage_revision FROM tasks WHERE id='shared-task'").get();
  for(const k of ["status","completed_at_ms","due_on","area_id"])
    assert.equal(afterTask[k],beforeTask[k],k);
  assert.equal(afterTask.triage_revision,beforeTask.triage_revision+2);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts").get().n,2);
  assert.equal((await post("triage",{...undo,commandId:randomUUID()})).status,409);
});

test("C-3a: CSRF/protocol/CAS and stale Area checks cannot commit",async()=>{
  const fx=fixture(),body=await ok(read());
  const row=body.items[0];
  const command=cmd(row,fx.store);
  assert.equal((await post("triage",command,owner(),{origin:"http://attacker.invalid"})).status,403);
  assert.equal((await post("triage",command,owner(),{protocol:null})).status,400);
  assert.equal((await post("triage",{...command,expectedTriageRevision:42})).status,409);
  assert.equal((await post("triage",{...command,writeAreaId:"area-shared"})).status,409);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts").get().n,0);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED="false";
  assert.equal((await post("triage",command)).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED="true";
  assert.equal((await ok(post("receipt",command))).status,"not_recorded");
});

test("C-3a: late same-generation ACL revoke invalidates pinned title and count before HTTP release",async()=>{
  const fx=fixture(),cookie=session(fx,"bob");
  const request=new Request(base,{headers:{cookie,"x-forwarded-for":"10.61.3.7"}});
  const identity=resolveStagingHttpIdentity(request);
  assert.equal(identity.kind,"session");
  const page=await readStagingTargetInboxInChild({
    ...fx.store,ownerUserId:"alice",...stagingChildSessionConfig(identity),
  },50,null);
  assert.ok(page);
  assert.ok(page.items.some(row=>row.title==="Shared Task"));
  assert.ok(page.count>0);
  fx.db.prepare("DELETE FROM area_members WHERE area_id='area-shared' AND user_id='bob'").run();
  const release=verifyStagingReadBeforeRelease(
    request,identity,fx.store,"alice",page.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {scope:"global-all",areas:page.areaEpochs});
  assert.equal(release,"stale","no stale titles or count can be emitted");
  const updated=await ok(read(cookie));
  assert.deepEqual(ids(updated),["bob-only"]);
  assert.equal(updated.count,1);
});
