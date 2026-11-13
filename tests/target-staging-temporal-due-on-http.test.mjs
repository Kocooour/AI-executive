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
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before=Object.fromEntries(vars.map(x=>[x,process.env[x]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3i2-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"legacy unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-temporal-due-on-http-secret-at-least-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore,TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET,PATCH}=await import("../app/api/target-staging/task-temporal/due-on/route.ts");
const {POST}=await import("../app/api/target-staging/task-temporal/due-on/receipt/route.ts");
const {
  parseTemporalDueOnWriteReply,parseTemporalDueOnReceiptReply,
  parseTemporalDueOnAtomicReceiptReply,readTemporalDueOnAtomicReceiptInChild,
}=await import("../lib/target-staging-temporal-due-on-http-process.ts");
const {
  readStagingTemporalDetailInChild,
  readStagingTemporalDueOnPreviewInChild,parseStagingTemporalDueOnPreview,
}=await import("../lib/target-staging-read-process.ts");
const {targetTaskWriteRevision}=
  await import("../lib/target-task-write-preflight.ts");
const {verifyTemporalDueOnTaskLive}=
  await import("../lib/target-staging-temporal-due-on-http.ts");
let counter=0;
after(()=>{
  for(const [key,value] of Object.entries(before)) {
    if (value===undefined) delete process.env[key]; else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"legacy unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++counter)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  insert.run("p-alice",stage.unassignedAreaId,"Private Alice");
  insert.run("p-bob","bob-private","Private Bob");
  insert.run("s-bob","family-area","Shared Bob");
  insert.run("s-viewer","family-area","Shared Viewer");
  insert.run("  č padded  ","family-area","Unicode padded");
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
function login(fx,actor){
  const result=durable.issueDurableTargetStagingSession(fx.store,actor,900);
  assert.equal(result.ok,true,JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+result.sessionToken;
}
const base="http://localhost:3001/api/target-staging/task-temporal/due-on";
function query(taskId,cookie=owner(),extra=""){
  return GET(new Request(base+"?taskId="+encodeURIComponent(taskId)+extra,{
    headers:{cookie,"x-forwarded-for":"10.11.82.1"},
  }));
}
function call(method,payload,cookie=owner(),options={}){
  const url=base+(method==="POST"?"/receipt":"")+(options.query||"");
  return (method==="PATCH"?PATCH:POST)(new Request(url,{
    method,headers:{
      cookie,"content-type":"application/json",
      "x-forwarded-for":"10.11.82.1",
      ...(options.origin===null?{}:{origin:options.origin||"http://localhost:3001"}),
      ...(options.protocol===null?{}:{"x-lumi-target-protocol":options.protocol||"1"}),
    },body:typeof payload==="string"?payload:JSON.stringify(payload),
  }));
}
async function preview(taskId,cookie=owner()){
  const r=await query(taskId,cookie);
  const b=await r.json();
  assert.equal(r.status,200,JSON.stringify(b));
  assert.equal(r.headers.get("cache-control"),"no-store");
  assert.equal(Object.keys(b).sort().join(","),
    "dueOn,expectedRevision,restoreGeneration,writeAreaId");
  assert.match(b.expectedRevision,/^[a-f0-9]{64}$/);
  return b;
}
async function command(taskId,dueOn,cookie=owner()){
  const {dueOn:observed,...revision}=await preview(taskId,cookie);
  return {taskId,dueOn,commandId:randomUUID(),...revision};
}
const state=(fx,taskId)=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare("SELECT due_on AS dueOn,status,completed_at_ms AS completedAtMs,revision FROM tasks WHERE id=?").get(taskId);}
  finally{db.close();}
};
const receiptCount=fx=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
    .get(TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX+"%").n;}
  finally{db.close();}
};

test("four independent gates and authentication fail closed, preview validates ID",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await query("p-alice")).status,404,flag);
    assert.equal((await call("PATCH",{})).status,404,flag);
    assert.equal((await call("POST",{})).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+"?taskId=p-alice"))).status,401);
  assert.equal((await PATCH(new Request(base,{method:"PATCH",body:"{}"}))).status,401);
  for(const s of ["","?foo=bar","?taskId=p-alice&taskId=p-bob",
    "?taskId=x&actor=bob","?taskId=%00","?taskId="]){
    const r=await GET(new Request(base+s,{headers:{cookie:owner()}}));
    assert.equal(r.status,400,s);
  }
  assert.equal((await query("unknown")).status,404);
  assert.equal((await preview("p-alice")).dueOn,null);
  // dueOn has an independent flag; status writes are not enabled by it.
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED="false";
  assert.equal((await query("p-alice")).status,200);
});

test("BE-08 dueOn child gate stays independent of status-write gate",async()=>{
  const fx=fixture();
  const oldStatus=process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED;
  const oldDue=process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED;
  const config={...fx.store,ownerUserId:"alice"};
  try{
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED="false";
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED="true";
    const preview=await readStagingTemporalDueOnPreviewInChild(config,"p-alice");
    assert.equal(preview?.ok,true,JSON.stringify(preview));
    assert.equal((await query("p-alice")).status,200);
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED="false";
    assert.equal(await readStagingTemporalDueOnPreviewInChild(config,"p-alice"),null);
    assert.equal((await query("p-alice")).status,404);
  }finally{
    if(oldStatus===undefined)delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED;
    else process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED=oldStatus;
    if(oldDue===undefined)delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED;
    else process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED=oldDue;
  }
});

test("BE-08 dueOn CAS, date and task guard share one pinned snapshot",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const config={...fx.store,ownerUserId:"alice",
    sessionTokenHash:durable.hashTargetStagingSessionToken(bob.split("=")[1])};
  const captured=await readStagingTemporalDueOnPreviewInChild(config,"s-bob");
  assert.equal(captured?.ok,true,JSON.stringify(captured));
  assert.equal(captured.detail.task.areaId,"family-area");
  assert.equal(captured.detail.task.dueOn,null);
  assert.equal(captured.detail.linearization.areas[0].access,"editor");
  assert.match(captured.expectedRevision,/^[a-f0-9]{64}$/);
  const db=new DatabaseSync(fx.stage.databasePath);
  try{assert.equal(captured.expectedRevision,targetTaskWriteRevision(db,"s-bob"));}
  finally{db.close();}
  const live=()=>verifyTemporalDueOnTaskLive(
    new Request(base+"?taskId=s-bob",{headers:{cookie:bob}}),
    {kind:"session",tokenHash:config.sessionTokenHash},
    {...fx.store,ownerUserId:"alice"},captured.detail);
  assert.equal(live(),"ok");
  const external=await preview("s-bob",bob);
  assert.deepEqual(external,{
    expectedRevision:captured.expectedRevision,
    dueOn:captured.detail.task.dueOn,
    writeAreaId:captured.detail.task.areaId,
    restoreGeneration:fx.stage.restoreGeneration,
  });
  const viewer=await readStagingTemporalDueOnPreviewInChild({
    ...fx.store,ownerUserId:"alice",
    sessionTokenHash:durable.hashTargetStagingSessionToken(carol.split("=")[1]),
  },"s-bob");
  assert.deepEqual(viewer,{ok:false,reason:"inaccessible"});
  assert.deepEqual(await readStagingTemporalDueOnPreviewInChild(config,"p-alice"),
    {ok:false,reason:"inaccessible"});
  const change=new DatabaseSync(fx.stage.databasePath);
  try{change.prepare("UPDATE tasks SET due_on='2028-05-19' WHERE id='s-bob'").run();}
  finally{change.close();}
  assert.equal(live(),"stale","a task mutation after preview invalidates its guard");
  const current=await readStagingTemporalDueOnPreviewInChild(config,"s-bob");
  assert.equal(current?.ok,true,JSON.stringify(current));
  assert.equal(current.detail.task.dueOn,"2028-05-19");
  assert.notEqual(current.expectedRevision,captured.expectedRevision);
  assert.equal((await preview("s-bob",bob)).expectedRevision,current.expectedRevision);
  const revoke=new DatabaseSync(fx.stage.databasePath);
  try{revoke.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();}
  finally{revoke.close();}
  assert.equal((await query("s-bob",bob)).status,404);
  assert.deepEqual(await readStagingTemporalDueOnPreviewInChild(config,"s-bob"),
    {ok:false,reason:"inaccessible"});
});

test("BE-08 strict dueOn preview DTO denies malformed or mismatched task witness",async()=>{
  const fx=fixture();
  const result=await readStagingTemporalDueOnPreviewInChild({
    ...fx.store,ownerUserId:"alice",
  },"p-alice");
  assert.equal(result?.ok,true,JSON.stringify(result));
  for(const malformed of [
    {...result,expectedRevision:"bad"},
    {...result,actorUserId:"alice"},
    {...result,detail:{...result.detail,privatePlan:"secret"}},
    {...result,detail:{...result.detail,guard:{
      ...result.detail.guard,taskId:"p-bob",
    }}},
    {...result,detail:{...result.detail,task:{
      ...result.detail.task,id:"p-bob",
    }}},
    {...result,detail:{...result.detail,linearization:{
      ...result.detail.linearization,areas:[{
        ...result.detail.linearization.areas[0],access:"viewer",
      }],
    }}},
  ])assert.equal(parseStagingTemporalDueOnPreview(malformed,"p-alice"),null);
});

test("BE-08 dueOn preview accepts long title and preserves public four-field DTO",async()=>{
  const fx=fixture();
  const db=new DatabaseSync(fx.stage.databasePath);
  try{db.prepare("UPDATE tasks SET title=? WHERE id='p-alice'").run("x".repeat(1800));}
  finally{db.close();}
  const snapshot=await readStagingTemporalDueOnPreviewInChild({
    ...fx.store,ownerUserId:"alice",
  },"p-alice");
  assert.equal(snapshot?.ok,true,JSON.stringify(snapshot));
  const response=await query("p-alice");
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const data=await response.json();
  assert.equal(data.expectedRevision,snapshot.expectedRevision);
  assert.deepEqual(Object.keys(data).sort(),
    ["dueOn","expectedRevision","restoreGeneration","writeAreaId"]);
  assert.equal(JSON.stringify(data).includes("x".repeat(80)),false);
});

test("private dueOn set, replay, read-only receipt and clear are atomic",async()=>{
  const fx=fixture();
  const c=await command("p-alice","2028-02-29");
  const initial=state(fx,"p-alice");
  assert.deepEqual(await (await call("POST",c)).json(),{status:"not_recorded"});
  const first=await call("PATCH",c);
  assert.equal(first.status,200,JSON.stringify(await first.clone().json()));
  assert.deepEqual(await first.json(),{ok:true});
  assert.equal(state(fx,"p-alice").dueOn,"2028-02-29");
  assert.equal(state(fx,"p-alice").status,initial.status);
  assert.equal(state(fx,"p-alice").completedAtMs,initial.completedAtMs);
  assert.equal(state(fx,"p-alice").revision,initial.revision+1);
  assert.deepEqual(await (await call("POST",c)).json(),{status:"committed"});
  assert.deepEqual(await (await call("PATCH",c)).json(),{ok:true,replayed:true});
  assert.equal(receiptCount(fx),1);
  const reopened=await command("p-alice",null);
  assert.deepEqual(await (await call("PATCH",reopened)).json(),{ok:true});
  assert.equal(state(fx,"p-alice").dueOn,null);
  assert.equal(state(fx,"p-alice").status,initial.status);
  assert.equal(state(fx,"p-alice").completedAtMs,initial.completedAtMs);
  assert.equal(receiptCount(fx),2);
  assert.deepEqual(await (await call("POST",c)).json(),{status:"committed"});
});

test("BE-07 dueOn receipt and task/Area witness use one pinned snapshot",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const cmd=await command("s-bob","2028-04-15",bob);
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash};
  const snapshot=()=>readTemporalDueOnAtomicReceiptInChild(config,cmd);
  const before=await snapshot();
  assert.equal(before?.ok,true,JSON.stringify(before));
  assert.deepEqual(before.receipt,{ok:true,status:"not_recorded"});
  assert.equal(before.detail.task.areaId,"family-area");
  const identity={kind:"session",tokenHash};
  const request=new Request(base+"/receipt",{
    method:"POST",headers:{cookie:bob,origin:"http://localhost:3001"},body:"{}",
  });
  const live=witness=>verifyTemporalDueOnTaskLive(request,identity,{
    ...fx.store,ownerUserId:"alice",
  },witness.detail);
  assert.equal(live(before),"ok");
  assert.deepEqual(await (await call("PATCH",cmd,bob)).json(),{ok:true});
  assert.equal(live(before),"stale","the original task revision cannot release a later receipt");
  const committed=await snapshot();
  assert.equal(committed?.ok,true,JSON.stringify(committed));
  assert.deepEqual(committed.receipt,{ok:true,status:"committed"});
  assert.equal(live(committed),"ok");
  assert.deepEqual(await (await call("POST",cmd,bob)).json(),{status:"committed"});
  const viewer=await readTemporalDueOnAtomicReceiptInChild({
    ...config,sessionTokenHash:durable.hashTargetStagingSessionToken(carol.split("=")[1]),
  },cmd);
  assert.deepEqual(viewer,{ok:false,reason:"inaccessible"});
  const foreign=await readTemporalDueOnAtomicReceiptInChild(config,
    {...cmd,taskId:"p-alice"});
  assert.deepEqual(foreign,{ok:false,reason:"inaccessible"});
  const db=new DatabaseSync(fx.stage.databasePath);
  try{
    // This fixture contains no assigned shared tasks; the role transition
    // satisfies the schema's membership downgrade integrity rule.
    db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  }finally{db.close();}
  assert.equal(live(committed),"stale");
  assert.deepEqual(await snapshot(),{ok:false,reason:"inaccessible"});
  assert.equal((await call("POST",cmd,bob)).status,404);
});

test("BE-07 strict internal child rejects extra receipt or forged task witness",async()=>{
  const fx=fixture(),cmd=await command("p-alice","2028-02-29");
  const sample=await readTemporalDueOnAtomicReceiptInChild({
    ...fx.store,ownerUserId:"alice",
  },cmd);
  assert.equal(sample?.ok,true,JSON.stringify(sample));
  for(const broken of [
    {...sample,actorUserId:"alice"},
    {...sample,receipt:{ok:true,status:"committed",commandId:cmd.commandId}},
    {...sample,receipt:{ok:true,status:"unknown"}},
    {...sample,detail:{...sample.detail,secret:"untrusted"}},
    {...sample,detail:{...sample.detail,guard:{
      ...sample.detail.guard,areaId:"foreign",
    }}},
    {...sample,detail:{...sample.detail,task:{
      ...sample.detail.task,id:"p-bob",
    }}},
    {...sample,detail:{...sample.detail,linearization:{
      ...sample.detail.linearization,areas:[{
        ...sample.detail.linearization.areas[0],access:"viewer",
      }],
    }}},
    {ok:true,detail:sample.detail},
  ])assert.equal(parseTemporalDueOnAtomicReceiptReply(broken,cmd.taskId),null);
});

test("BE-07 dueOn reconciliation accepts a bounded task title over 1 KiB",async()=>{
  const fx=fixture();
  const db=new DatabaseSync(fx.stage.databasePath);
  try{db.prepare("UPDATE tasks SET title=? WHERE id='p-alice'").run("x".repeat(1800));}
  finally{db.close();}
  const cmd=await command("p-alice","2028-02-29");
  const reply=await readTemporalDueOnAtomicReceiptInChild({
    ...fx.store,ownerUserId:"alice",
  },cmd);
  assert.equal(reply?.ok,true,JSON.stringify(reply));
  assert.deepEqual(reply.receipt,{ok:true,status:"not_recorded"});
  const response=await call("POST",cmd);
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(),{status:"not_recorded"});
});

test("current private/shared ACL denies foreign users and shared viewers before receipt",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const shared=await command("s-bob","2028-02-29",bob);
  assert.equal((await query("s-bob",carol)).status,404);
  assert.equal((await call("PATCH",shared,carol)).status,404);
  assert.equal((await call("POST",shared,carol)).status,404);
  assert.equal((await call("PATCH",shared,bob)).status,200);
  assert.deepEqual(await (await call("POST",shared,bob)).json(),{status:"committed"});
  assert.equal((await query("p-alice",bob)).status,404);
  assert.equal((await call("PATCH",await command("p-alice","2028-02-29"),bob)).status,404);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  db.close();
  assert.equal((await call("PATCH",shared,bob)).status,404);
  assert.equal((await call("POST",shared,bob)).status,404);
});

test("dueOn command strict contract, anti-CSRF, protocol, stale and conflict",async()=>{
  const fx=fixture(),c=await command("p-alice","2028-02-29");
  assert.equal((await call("PATCH",c,owner(),{origin:"https://foreign.test"})).status,403);
  assert.equal((await call("PATCH",c,owner(),{origin:null})).status,403);
  assert.equal((await call("PATCH",c,owner(),{protocol:null})).status,400);
  assert.equal((await call("POST",c,owner(),{protocol:null})).status,400);
  assert.equal((await call("PATCH",{...c,actorUserId:"alice"})).status,400);
  assert.equal((await call("PATCH",{...c,completedAtMs:1})).status,400);
  assert.equal((await call("PATCH",{...c,dueOn:"2026-02-29"})).status,400);
  assert.equal((await call("PATCH",{...c,dueOn:"2026-11-04T00:00:00Z"})).status,400);
  assert.equal((await call("PATCH",{...c,baseRevision:"old"})).status,400);
  assert.equal((await call("PATCH",{...c,restoreGeneration:randomUUID()})).status,409);
  assert.equal((await call("PATCH",{...c,writeAreaId:"bob-private"})).status,404);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET title='Other edit' WHERE id='p-alice'").run();
  db.close();
  assert.equal((await call("PATCH",c)).status,409);
  const fresh=await command("p-alice","2028-02-29");
  assert.equal((await call("PATCH",fresh)).status,200);
  assert.equal((await call("PATCH",{...fresh,dueOn:null})).status,409);
  assert.equal((await call("POST",{...fresh,dueOn:null})).status,409);
  assert.equal((await call("PATCH",await command("p-alice","2028-02-29"))).status,409);
  assert.equal(receiptCount(fx),1);
});

test("Unicode padded task IDs and dynamic durable-session revocation",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const id="  č padded  ";
  const c=await command(id,"2030-12-31",bob);
  assert.deepEqual(await (await call("PATCH",c,bob)).json(),{ok:true});
  assert.deepEqual(await (await call("POST",c,bob)).json(),{status:"committed"});
  assert.equal(state(fx,id).dueOn,"2030-12-31");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  assert.equal((await call("POST",c,bob)).status,401);
  assert.equal((await call("PATCH",c,bob)).status,401);
  assert.equal((await query(id,bob)).status,401);
});


/** Construct the same verified durable-session identity consumed by receipt release. */
async function capturedDueOnDetail(fx,taskId,cookie) {
  const tokenHash=durable.hashTargetStagingSessionToken(cookie.split("=")[1]);
  const detail=await readStagingTemporalDetailInChild({
    ...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash,
  },taskId);
  assert.equal(detail?.ok,true,JSON.stringify(detail));
  const request=new Request(base+"/receipt",{
    method:"POST",headers:{cookie,origin:"http://localhost:3001"},
    body:"{}",
  });
  const identity={kind:"session",tokenHash};
  assert.equal(verifyTemporalDueOnTaskLive(request,identity,{
    ...fx.store,ownerUserId:"alice",
  },detail.detail),"ok","the initial snapshot must be valid");
  return {detail:detail.detail,request,identity};
}
function liveDueOnGuard(fx,captured) {
  return verifyTemporalDueOnTaskLive(captured.request,captured.identity,{
    ...fx.store,ownerUserId:"alice",
  },captured.detail);
}

test("R2d.3i.2 refuses a receipt snapshot when shared write membership changes before release",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  // First store a real committed receipt; its existence must not grant stale access.
  const saved=await command("s-bob","2028-02-29",bob);
  assert.equal((await call("PATCH",saved,bob)).status,200);
  const captured=await capturedDueOnDetail(fx,"s-bob",bob);
  const db=new DatabaseSync(fx.stage.databasePath);
  try {
    db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  } finally { db.close(); }
  assert.equal(liveDueOnGuard(fx,captured),"stale",
    "a role downgrade between read and response must suppress an old receipt");
  const response=await call("POST",saved,bob);
  assert.equal(response.status,404,"now-viewer cannot reconcile a previously committed command");
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(JSON.stringify(await response.json()).includes("committed"),false);
});

test("R2d.3i.2 rejects a task Area move between receipt snapshot and release",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const captured=await capturedDueOnDetail(fx,"s-bob",bob);
  const db=new DatabaseSync(fx.stage.databasePath);
  try {
    // Bob remains a writer in the destination private Area; the important
    // invariant is exact snapshot identity, not merely current readability.
    db.prepare("UPDATE tasks SET area_id='bob-private' WHERE id='s-bob'").run();
  } finally { db.close(); }
  assert.equal(liveDueOnGuard(fx,captured),"stale",
    "a moved task cannot release results observed under its previous Area");
});

test("R2d.3i.2 rejects inherited parent revisions between receipt snapshot and release",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const db=new DatabaseSync(fx.stage.databasePath);
  try {
    db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p-inherited','family-area','Parent')").run();
    db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('t-inherited','p-inherited','Child')").run();
  } finally { db.close(); }
  const captured=await capturedDueOnDetail(fx,"t-inherited",bob);
  const edit=new DatabaseSync(fx.stage.databasePath);
  try {
    edit.prepare("UPDATE projects SET title='Renamed' WHERE id='p-inherited'").run();
  } finally { edit.close(); }
  assert.equal(liveDueOnGuard(fx,captured),"stale",
    "a changed parent revision invalidates the original child receipt witness");
});

test("strict child result parsers never accept injected fields or invalid status",()=>{
  assert.deepEqual(parseTemporalDueOnWriteReply({ok:true}),{ok:true});
  assert.deepEqual(parseTemporalDueOnWriteReply({ok:true,replayed:true}),{ok:true,replayed:true});
  assert.equal(parseTemporalDueOnWriteReply({ok:true,task:{id:"secret"}}),null);
  assert.equal(parseTemporalDueOnWriteReply({ok:false,reason:"unauthorized"}),null);
  assert.deepEqual(parseTemporalDueOnReceiptReply({ok:true,status:"committed"}),
    {ok:true,status:"committed"});
  assert.equal(parseTemporalDueOnReceiptReply({ok:true,status:"completed"}),null);
  assert.equal(parseTemporalDueOnReceiptReply({ok:true,status:"committed",actor:"bob"}),null);
});
