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
const {issueTargetInboxCommandId}=await import("../lib/target-inbox-command-identity.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/inbox/route.ts");
const {POST:TRIAGE}=await import("../app/api/target-staging/inbox/triage/route.ts");
const {POST:RECEIPT}=await import("../app/api/target-staging/inbox/receipt/route.ts");
const {POST:CANCEL}=await import("../app/api/target-staging/inbox/cancel/route.ts");
const {readStagingTargetInboxInChild}=await import("../lib/target-staging-read-process.ts");
const {resolveStagingHttpIdentity,stagingChildSessionConfig,verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let counter=0;let currentIp="10.61.3.7";const all=[];
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
  currentIp="10.61.3."+String(counter+7);
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
  headers:{cookie,"x-forwarded-for":currentIp},
}));
function post(kind,command,cookie=owner(),options={}){
  return (kind==="receipt"?RECEIPT:kind==="cancel"?CANCEL:TRIAGE)(new Request(base+"/"+kind,{
    method:"POST",
    headers:{cookie,"content-type":"application/json",
      "x-forwarded-for":currentIp,
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
  const fields={taskId:row.id,mode,undoOfCommandId:prior,
    expectedRevision:row.expectedRevision,
    expectedTriageRevision:row.triageRevision,writeAreaId:row.effectiveAreaId,
    restoreGeneration:store.expectedRestoreGeneration};
  return {...fields,commandId:issueTargetInboxCommandId(fields)};
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

test("C-3a: real pinned HTTP receipt survives Area move; no stale Undo or ACL leak",async()=>{
  const fx=fixture();
  const first=await ok(read());
  const process=cmd(first.items.find(x=>x.id==="shared-task"),fx.store);
  assert.deepEqual(await ok(post("triage",process)),{ok:true});
  assert.equal((await ok(post("receipt",process))).status,"committed");
  fx.db.prepare("UPDATE tasks SET area_id=? WHERE id='shared-task'")
    .run(fx.stage.unassignedAreaId);
  const recovered=await ok(post("receipt",process));
  assert.equal(recovered.status,"committed");
  assert.equal(recovered.next,null,
    "the original Process is proven, but the moved task cannot use stale Undo");
  const newer=cmd((await ok(read())).items.find(x=>x.id==="alice-only"),fx.store);
  assert.deepEqual(await ok(post("triage",newer)),{ok:true},
    "reconciliation does not block fresh authorized commands");
  // An old shared editor must not read the receipt after it moves private.
  const bob=session(fx,"bob");
  assert.notEqual((await post("receipt",process,bob)).status,200);
});

test("C-3a: real HTTP confirms tombstoned Process without Undo or ACL leakage",async()=>{
  const fx=fixture();
  const first=await ok(read());
  const process=cmd(first.items.find(x=>x.id==="shared-task"),fx.store);
  assert.deepEqual(await ok(post("triage",process)),{ok:true});
  const validUndo=await ok(post("receipt",process));
  assert.equal(validUndo.status,"committed");
  assert.ok(validUndo.next,"Process initially permits Undo before deletion");
  const authority=new TargetStagingSessionAuthority(fx.store);
  try{
    const token=authority.issueWritable("alice").sessionToken;
    const preview=authority.previewTaskTitleEdit(token,{taskId:"shared-task"});
    assert.equal(preview.ok,true);
    assert.deepEqual(authority.deleteTask(token,{
      commandId:randomUUID(),taskId:"shared-task",
      expectedRevision:preview.snapshotRevision,writeAreaId:"area-shared",
      restoreGeneration:fx.stage.restoreGeneration,
    }),{ok:true},"real pinned delete creates tombstone");
    assert.equal(fx.db.prepare("SELECT 1 FROM tasks WHERE id='shared-task'").get(),
      undefined);
    assert.ok(fx.db.prepare("SELECT 1 FROM task_tombstones WHERE id='shared-task'").get());
    const confirmed=await ok(post("receipt",process));
    assert.deepEqual(confirmed,{ok:true,status:"committed",next:null},
      "deleted task's original receipt must resolve without stale Undo");
    const noReceipt=await post("receipt",{...process,commandId:randomUUID()});
    assert.notEqual(noReceipt.status,200,"tombstone cannot disclose a missing UUID");
    const bob=session(fx,"bob");
    const cara=session(fx,"cara");
    assert.notEqual((await post("receipt",process,bob)).status,200,
      "another actor's UUID cannot confirm a shared tombstone");
    assert.notEqual((await post("receipt",process,cara)).status,200,
      "a shared viewer cannot read the tombstone receipt");
    const staleUndo=cmd({
      id:"shared-task",expectedRevision:validUndo.next.expectedRevision,
      triageRevision:validUndo.next.triageRevision,
      effectiveAreaId:validUndo.next.writeAreaId,
    },fx.store,"undo",process.commandId);
    assert.notEqual((await post("triage",staleUndo)).status,200,
      "Undo cannot resurrect a tombstoned task");
    const current=await ok(read());
    assert.ok(!ids(current).includes("shared-task"));
    const fresh=cmd(current.items.find(x=>x.id==="alice-only"),fx.store);
    assert.deepEqual(await ok(post("triage",fresh)),{ok:true},
      "new commands proceed after the tombstone receipt is reconciled");
  }finally{authority.close();}
});

test("C-3a: own tombstone receipt fails closed immediately on ACL revocation",async()=>{
  const fx=fixture();
  const bob=session(fx,"bob");
  const row=(await ok(read(bob))).items.find(x=>x.id==="shared-task");
  const process=cmd(row,fx.store);
  assert.deepEqual(await ok(post("triage",process,bob)),{ok:true});
  const authority=new TargetStagingSessionAuthority(fx.store);
  try{
    const token=authority.issueWritable("alice").sessionToken;
    const preview=authority.previewTaskTitleEdit(token,{taskId:"shared-task"});
    assert.equal(preview.ok,true);
    assert.deepEqual(authority.deleteTask(token,{
      commandId:randomUUID(),taskId:"shared-task",
      expectedRevision:preview.snapshotRevision,writeAreaId:"area-shared",
      restoreGeneration:fx.stage.restoreGeneration,
    }),{ok:true});
  }finally{authority.close();}
  const before=await ok(post("receipt",process,bob));
  assert.deepEqual(before,{ok:true,status:"committed",next:null});
  fx.db.prepare("DELETE FROM area_members WHERE area_id='area-shared' AND user_id='bob'").run();
  assert.notEqual((await post("receipt",process,bob)).status,200,
    "revoked editor must not see its historical receipt");
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


test("C-3a: lost POST + concurrent title edit is safely cancelled under pinned lock",async()=>{
  const fx=fixture(),page=await ok(read());
  const row=page.items.find(x=>x.id==="shared-task"),original=cmd(row,fx.store);
  // Simulate an original POST lost before the server received it.
  assert.equal((await ok(post("receipt",original))).status,"not_recorded");
  fx.db.prepare("UPDATE tasks SET title='Concurrent title edit' WHERE id='shared-task'").run();
  assert.equal((await post("triage",original)).status,409,"exact replay has stale CAS");
  assert.equal((await ok(post("receipt",original))).status,"cancelled",
    "stale monotonic CAS, not a missing receipt alone, proves late write impossible");
  const beforeCancel=fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision;
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"},
    "terminal CAS proof is idempotent without creating metadata");
  assert.deepEqual(await ok(post("receipt",original)),{ok:true,status:"cancelled",next:null});
  assert.equal(fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision,beforeCancel,"stale cancellation cannot advance revision again");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r3:inbox-triage-cancel-v1:%'")
    .get().n,0,"no permanent negative receipt is created");
  assert.equal((await post("triage",original)).status,409,
    "a late original POST cannot write after cancellation");
  assert.equal((await post("triage",{...original,expectedTriageRevision:7})).status,409,
    "different stale payload cannot commit after CAS moved");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts").get().n,0);
  assert.equal(fx.db.prepare("SELECT triage_state FROM tasks WHERE id='shared-task'")
    .get().triage_state,"unprocessed");
  const now=(await ok(read())).items.find(x=>x.id==="shared-task");
  assert.equal(now.title,"Concurrent title edit");
  assert.deepEqual(await ok(post("triage",cmd(now,fx.store))),{ok:true},
    "fresh, newly authorized CAS succeeds after cancellation");
});

test("C-3a: the full legacy actor ledger cannot block CAS-safe cancellation",async()=>{
  const fx=fixture(),page=await ok(read());
  const original=cmd(page.items.find(x=>x.id==="shared-task"),fx.store);
  const {targetInboxTriageCancellationKey}=
    await import("../lib/target-inbox-triage-writer.ts");
  const legacy=targetInboxTriageCancellationKey("alice",original.commandId);
  const legacyPrefix=legacy.slice(0,-64);
  const seed=fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  fx.db.exec("BEGIN IMMEDIATE");
  try{
    for(let i=0;i<4096;i++){
      const receipt=i.toString(16).padStart(64,"0");
      assert.notEqual(legacyPrefix+receipt,legacy);
      seed.run(legacyPrefix+receipt,"0".repeat(64));
    }
    fx.db.exec("COMMIT");
  }catch(error){fx.db.exec("ROLLBACK");throw error;}
  // The old actor-only bucket is genuinely full before trying to cancel.
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key>=? AND key<?")
    .get(legacyPrefix,legacyPrefix+"g").n,4096);
  fx.db.prepare("UPDATE tasks SET title='Changed after lost POST' WHERE id='shared-task'").run();
  assert.equal((await post("triage",original)).status,409,"old CAS was invalidated");
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r3:inbox-triage-cancel-v1:%'")
    .get().n,4096,"new cancellation must not increase the historical fence ledger");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key>=? AND key<?")
    .get(legacyPrefix,legacyPrefix+"g").n,4096,"all legacy fences remain durable");
  assert.deepEqual(await ok(post("receipt",original)),{ok:true,status:"cancelled",next:null});
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.equal((await post("triage",original)).status,409,
    "a delayed original write cannot commit after legacy-bucket rollover");
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]},"rollover must retain canonical store integrity");
});

test("C-3a: a full first hash shard cannot starve monotonic CAS cancellation",async()=>{
  const fx=fixture(),page=await ok(read());
  const original=cmd(page.items.find(x=>x.id==="shared-task"),fx.store);
  const {targetInboxTriageCancellationShardKeys}=await import("../lib/target-inbox-triage-writer.ts");
  const [first,second,...rest]=targetInboxTriageCancellationShardKeys("alice",original.commandId);
  assert.equal(rest.length,3,"there must be a unique final 64-hex fallback");
  const shardPrefix=first.slice(0,-64),receiptPrefix=first.slice(-64,-60);
  const seed=fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  fx.db.exec("BEGIN IMMEDIATE");
  try{
    for(let i=0;i<4096;i++){
      const receipt=receiptPrefix+i.toString(16).padStart(60,"0");
      assert.notEqual(shardPrefix+receipt,first);
      seed.run(shardPrefix+receipt,"0".repeat(64));
    }
    fx.db.exec("COMMIT");
  }catch(error){fx.db.exec("ROLLBACK");throw error;}
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key>=? AND key<?")
    .get(shardPrefix,shardPrefix+"g").n,4096);
  const before=fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision;
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.equal(fx.db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(second),undefined,"cancel never writes a new hash shard");
  assert.equal(fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision,before+1,"the pinned cancellation invalidates old CAS once");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key>=? AND key<?")
    .get(shardPrefix,shardPrefix+"g").n,4096,"existing shard stays unchanged");
  assert.deepEqual(await ok(post("receipt",original)),{ok:true,status:"cancelled",next:null});
  assert.equal((await post("triage",original)).status,409);
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]},"old shard and retired CAS remain canonical");
});

test("C-3a: malformed or duplicate cancellation shards fail canonical preflight closed",async()=>{
  const {targetInboxTriageCancellationKey,targetInboxTriageCancellationShardKeys}=
    await import("../lib/target-inbox-triage-writer.ts");
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  for(const shape of ["wrong-shard","duplicate-across-depths"]){
    const fx=fixture(),page=await ok(read());
    const original=cmd(page.items.find(x=>x.id==="shared-task"),fx.store);
    const legacy=targetInboxTriageCancellationKey("alice",original.commandId);
    const first=targetInboxTriageCancellationShardKeys("alice",original.commandId)[0];
    const seed=fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
    if(shape==="wrong-shard"){
      const prefix=first.slice(0,-64),actual=prefix.slice(-5,-1);
      const forged=prefix.slice(0,-5)+(actual==="ffff"?"0000":"ffff")+":"+
        first.slice(-64);
      seed.run(forged,"0".repeat(64));
    }else{
      seed.run(legacy,"0".repeat(64));
      seed.run(first,"0".repeat(64));
    }
    const check=inspectIsolatedTargetStore({...fx.store,mode:"r2-model"});
    assert.equal(check.ok,false,shape);
    assert.ok(check.issues.includes("metadata_invalid"),JSON.stringify(check));
    assert.equal((await post("cancel",original)).status,503,
      "never mutate a malformed cancellation ledger");
  }
});

test("C-3a: forged tombstone witness cannot pass canonical preflight",async()=>{
  const fx=fixture(),page=await ok(read());
  const original=cmd(page.items.find(x=>x.id==="shared-task"),fx.store);
  const {createHash}=await import("node:crypto");
  const prefix="r3:inbox-tombstone-cancel-v1:";
  const taskId="never-existing-task";
  const key=prefix+createHash("sha256").update(JSON.stringify([
    "inbox-tombstone-cancel-v1","alice",taskId,
  ])).digest("hex");
  fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run(key,JSON.stringify(["alice",taskId]));
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  const checked=inspectIsolatedTargetStore({...fx.store,mode:"r2-model"});
  assert.equal(checked.ok,false);
  assert.ok(checked.issues.includes("metadata_invalid"),JSON.stringify(checked));
  assert.equal((await post("cancel",original)).status,503,
    "untrusted metadata must block a subsequent pinned write");
});

test("C-3a: Area move and tombstone remain safely cancellable, without leaking missing UUIDs",async()=>{
  const fx=fixture();
  const original=cmd((await ok(read())).items.find(x=>x.id==="shared-task"),fx.store);
  fx.db.prepare("UPDATE tasks SET area_id=? WHERE id='shared-task'")
    .run(fx.stage.unassignedAreaId);
  assert.deepEqual(await ok(post("receipt",original)),
    {ok:true,status:"cancelled",next:null},
    "a moved task has a permanently stale original CAS, not just a missing receipt");
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.deepEqual(await ok(post("receipt",original)),{ok:true,status:"cancelled",next:null});
  assert.equal((await post("triage",original)).status,409);

  const current=(await ok(read())).items.find(x=>x.id==="shared-task");
  const tombstoneCommand=cmd(current,fx.store);
  const authority=new TargetStagingSessionAuthority(fx.store);
  try{
    const token=authority.issueWritable("alice").sessionToken;
    const preview=authority.previewTaskTitleEdit(token,{taskId:"shared-task"});
    assert.equal(preview.ok,true);
    assert.deepEqual(authority.deleteTask(token,{
      commandId:randomUUID(),taskId:"shared-task",expectedRevision:preview.snapshotRevision,
      writeAreaId:fx.stage.unassignedAreaId,restoreGeneration:fx.stage.restoreGeneration,
    }),{ok:true});
  }finally{authority.close();}
  assert.notEqual((await post("receipt",tombstoneCommand)).status,200,
    "no tombstone existence leak for an arbitrary missing UUID");
  const tombstoneMarkers=()=>fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
    .get("r3:inbox-tombstone-cancel-v1:%").n;
  assert.equal(tombstoneMarkers(),0);
  assert.deepEqual(await ok(post("cancel",tombstoneCommand)),{ok:true,status:"cancelled"});
  assert.equal(tombstoneMarkers(),1,"only one marker per actor and deleted task");
  assert.deepEqual(await ok(post("receipt",tombstoneCommand)),
    {ok:true,status:"cancelled",next:null});
  assert.equal((await post("triage",tombstoneCommand)).status,409);
  for(let i=0;i<3;i++){
    const another={...tombstoneCommand,commandId:randomUUID()};
    assert.deepEqual(await ok(post("cancel",another)),{ok:true,status:"cancelled"});
    assert.equal((await ok(post("receipt",another))).status,"cancelled");
  }
  assert.equal(tombstoneMarkers(),1,"random UUIDs cannot multiply tombstone metadata");
  assert.notEqual((await post("receipt",tombstoneCommand,session(fx,"bob"))).status,200,
    "another actor cannot probe Alice's explicit terminal marker");
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]},"actor-scoped marker must pass canonical preflight");
});

test("C-3a: fabricated task and arbitrary UUID floods cannot create permanent fences",async()=>{
  const fx=fixture(),page=await ok(read());
  const original=cmd(page.items.find(x=>x.id==="shared-task"),fx.store);
  const beforeRevision=fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision;
  const beforeLog=fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  const fenceCount=()=>fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
    .get("r3:inbox-%cancel-v1:%").n;
  const beforeFences=fenceCount();
  const fake={...original,taskId:"never-existing-task",commandId:randomUUID()};
  assert.equal((await post("cancel",fake)).status,404,
    "writable Area alone cannot authorize a nonexistent task or insert a fence");
  assert.equal(fenceCount(),beforeFences);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n,beforeLog);
  // A live CAS can only be invalidated once. More fake command IDs using
  // that original CAS cannot add rows or repeatedly bump the task revision.
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"cancelled"});
  assert.equal(fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision,beforeRevision+1);
  const afterLog=fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  assert.equal(afterLog,beforeLog+1);
  for(let i=0;i<4;i++){
    const another={...original,commandId:randomUUID()};
    assert.deepEqual(await ok(post("cancel",another)),{ok:true,status:"cancelled"});
    assert.equal((await post("triage",another)).status,409,
      "a fabricated command cannot use the old CAS after cancellation");
  }
  assert.equal(fenceCount(),beforeFences,"no arbitrary UUID creates permanent metadata");
  assert.equal(fx.db.prepare("SELECT revision FROM tasks WHERE id='shared-task'")
    .get().revision,beforeRevision+1,"only one monotonic revision advance");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n,afterLog);
  assert.deepEqual(await ok(post("receipt",original)),{ok:true,status:"cancelled",next:null});
  const now=(await ok(read())).items.find(x=>x.id==="shared-task");
  assert.deepEqual(await ok(post("triage",cmd(now,fx.store))),{ok:true},
    "a fresh authorized command works with its new CAS");
  const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});

test("C-3a: original commit wins cancel race, preserving receipt/Undo and ACL",async()=>{
  const fx=fixture();
  const original=cmd((await ok(read())).items.find(x=>x.id==="shared-task"),fx.store);
  assert.deepEqual(await ok(post("triage",original)),{ok:true});
  assert.deepEqual(await ok(post("cancel",original)),{ok:true,status:"committed"});
  const receipt=await ok(post("receipt",original));
  assert.equal(receipt.status,"committed");
  assert.ok(receipt.next);
  const prefix="r3:inbox-triage-cancel-v1:";
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
    .get(prefix+"%").n,0,"never insert a negative fence for an already committed UUID");
  const undo=cmd({id:original.taskId,
    expectedRevision:receipt.next.expectedRevision,
    triageRevision:receipt.next.triageRevision,
    effectiveAreaId:receipt.next.writeAreaId},fx.store,"undo",original.commandId);
  assert.deepEqual(await ok(post("triage",undo)),{ok:true});
  const bob=session(fx,"bob");
  fx.db.prepare("DELETE FROM area_members WHERE area_id='area-shared' AND user_id='bob'").run();
  assert.notEqual((await post("cancel",original,bob)).status,200,
    "a revoked editor cannot probe another actor's UUID");
  assert.equal((await post("cancel",original,owner(),{origin:"http://attacker.invalid"})).status,403);
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

test("C-3a: opaque pagination witness changes on same-count task and ACL mutations",async()=>{
  const fx=fixture();
  const first=await ok(read(owner(),"?limit=1"));
  assert.equal(first.count,2);
  assert.ok(first.nextCursor);
  const nextBefore=await ok(read(owner(),"?limit=1&cursor="+
    encodeURIComponent(first.nextCursor)));
  assert.equal(nextBefore.snapshotRevision,first.snapshotRevision);
  fx.db.prepare("UPDATE tasks SET title='Changed without a membership count change' WHERE id='shared-task'").run();
  const afterEdit=await ok(read(owner(),"?limit=1"));
  assert.equal(afterEdit.count,first.count);
  assert.notEqual(afterEdit.snapshotRevision,first.snapshotRevision);
  // Preserve the invariant that a shared Area always has at least one admin.
  fx.db.prepare("UPDATE area_members SET role='admin' WHERE area_id='area-shared' AND user_id='bob'").run();
  fx.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='area-shared' AND user_id='alice'").run();
  const afterRole=await ok(read(owner(),"?limit=1"));
  assert.equal(afterRole.count,first.count);
  assert.notEqual(afterRole.snapshotRevision,afterEdit.snapshotRevision);
});
