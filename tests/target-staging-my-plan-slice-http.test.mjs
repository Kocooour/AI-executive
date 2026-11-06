import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
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
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
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
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/my-plan/slice/route.ts");
const {GET:statusGET,PATCH:statusPATCH}=
  await import("../app/api/target-staging/task-temporal/status/route.ts");
const {POST:statusReceiptPOST}=
  await import("../app/api/target-staging/task-temporal/status/receipt/route.ts");
const {GET:dueGET,PATCH:duePATCH}=
  await import("../app/api/target-staging/task-temporal/due-on/route.ts");
const {POST:dueReceiptPOST}=
  await import("../app/api/target-staging/task-temporal/due-on/receipt/route.ts");
const {GET:whenGET,PATCH:whenPATCH}=
  await import("../app/api/target-staging/task-temporal/personal-when/command/route.ts");
const {POST:whenReceiptPOST}=
  await import("../app/api/target-staging/task-temporal/personal-when/command/receipt/route.ts");
const {prepareMyPlanWhen,dispatchMyPlanWhen,checkMyPlanWhenReceipt}=
  await import("../lib/target-staging-my-plan-when-client.ts");
const {prepareMyPlanStatus,dispatchMyPlanStatus,checkMyPlanStatusReceipt}=
  await import("../lib/target-staging-my-plan-status-client.ts");
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

/** BE-09: exercise real HTTP route handlers with the SAME durable actor
 * and isolated SQLite store; no mocks, external server or production data. */
const statusURL="http://localhost:3001/api/target-staging/task-temporal/status";
const dueURL="http://localhost:3001/api/target-staging/task-temporal/due-on";
const whenURL="http://localhost:3001/api/target-staging/task-temporal/personal-when/command";
async function writePreview(handler,url,taskId,cookie){
  const response=await handler(new Request(url+"?taskId="+encodeURIComponent(taskId),{
    headers:{cookie,"x-forwarded-for":"10.99.8.64"},
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  return body;
}
function writeCommand(handler,url,command,cookie){
  return handler(new Request(url,{
    method:handler===statusPATCH||handler===whenPATCH||handler===duePATCH
      ?"PATCH":"POST",
    headers:{
      cookie,"x-forwarded-for":"10.99.8.64",
      "content-type":"application/json",
      origin:"http://localhost:3001","x-lumi-target-protocol":"1",
    },
    body:JSON.stringify(command),
  }));
}
async function accepted(handler,url,command,cookie,expected){
  const response=await writeCommand(handler,url,command,cookie);
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(body,expected);
}
const unique=page=>new Set([...ids(page.today),...ids(page.tomorrow)]).size===
  ids(page.today).length+ids(page.tomorrow).length;

test("BE-09 My Plan -> private whenOn -> status -> receipts -> fresh Undo stays coherent",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const initial=await ok(get(query(),bob));
  assert.deepEqual(ids(initial.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(initial.tomorrow),["b-next","b-next2","s-bob"]);
  const cursor=(await ok(get(query({limit:"1"}),bob))).nextCursor;
  assert.ok(cursor);

  // Scheduling belongs to Bob, not the shared dueOn; it moves the task
  // from Tomorrow into Today under a fresh private epoch and CAS.
  const {whenOn:oldWhen,...whenCAS}=await writePreview(
    whenGET,whenURL,"b-next",bob);
  assert.equal(oldWhen,null);
  const schedule={...whenCAS,taskId:"b-next",whenOn:"2026-11-04",
    commandId:randomUUID()};
  await accepted(whenPATCH,whenURL,schedule,bob,{ok:true});
  await accepted(whenReceiptPOST,whenURL+"/receipt",schedule,bob,
    {status:"committed"});
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  const moved=await ok(get(query(),bob));
  assert.deepEqual(ids(moved.today),["b-overdue","b-next","b-today"]);
  assert.deepEqual(ids(moved.tomorrow),["b-next2","s-bob"]);
  assert.equal(unique(moved),true);

  // Completion is a distinct shared task write, not a private plan write.
  const statusCAS=await writePreview(statusGET,statusURL,"s-bob",bob);
  const complete={...statusCAS,taskId:"s-bob",status:"completed",
    commandId:randomUUID()};
  await accepted(statusPATCH,statusURL,complete,bob,{ok:true});
  await accepted(statusReceiptPOST,statusURL+"/receipt",complete,bob,
    {status:"committed"});
  const completed=await ok(get(query(),bob));
  assert.deepEqual(ids(completed.today),["b-overdue","b-next","b-today"]);
  assert.deepEqual(ids(completed.tomorrow),["b-next2"]);
  assert.equal(unique(completed),true);

  // Undo means fresh independently authorized CAS, not old command replay.
  const {whenOn:planned,...currentWhenCAS}=await writePreview(
    whenGET,whenURL,"b-next",bob);
  assert.equal(planned,"2026-11-04");
  const clear={...currentWhenCAS,taskId:"b-next",whenOn:null,
    commandId:randomUUID()};
  assert.notEqual(clear.commandId,schedule.commandId);
  await accepted(whenPATCH,whenURL,clear,bob,{ok:true});
  const refreshed=await writePreview(statusGET,statusURL,"s-bob",bob);
  const reopen={...refreshed,taskId:"s-bob",status:"open",commandId:randomUUID()};
  assert.notEqual(reopen.commandId,complete.commandId);
  await accepted(statusPATCH,statusURL,reopen,bob,{ok:true});
  await accepted(statusReceiptPOST,statusURL+"/receipt",reopen,bob,
    {status:"committed"});

  const restored=await ok(get(query(),bob));
  assert.deepEqual(ids(restored.today),ids(initial.today));
  assert.deepEqual(ids(restored.tomorrow),ids(initial.tomorrow));
  assert.equal(unique(restored),true);
  // Old original receipts remain readable by the SAME current writer and
  // cannot authorize a duplicate PATCH or leak to a different actor.
  await accepted(whenReceiptPOST,whenURL+"/receipt",schedule,bob,
    {status:"committed"});
  await accepted(statusReceiptPOST,statusURL+"/receipt",complete,bob,
    {status:"committed"});
  assert.equal((await writeCommand(whenReceiptPOST,whenURL+"/receipt",
    schedule,carol)).status,404);
  assert.equal((await writeCommand(statusReceiptPOST,statusURL+"/receipt",
    complete,carol)).status,404);
  const outsider=await ok(get(query(),carol));
  assert.deepEqual(ids(outsider.today),["c-private"]);
  assert.deepEqual(ids(outsider.tomorrow),[]);
  assert.ok(!JSON.stringify(outsider).includes("Bob"));
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
});

test("BE-09 role and session revocation invalidate old My Plan cursor and write receipts",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const cursor=(await ok(get(query({limit:"1"}),bob))).nextCursor;
  assert.ok(cursor);
  const savedStatus={...await writePreview(statusGET,statusURL,"s-bob",bob),
    taskId:"s-bob",status:"completed",commandId:randomUUID()};
  const {whenOn:ignored,...whenCAS}=await writePreview(
    whenGET,whenURL,"s-bob",bob);
  const savedWhen={...whenCAS,taskId:"s-bob",whenOn:"2026-11-04",
    commandId:randomUUID()};
  // Assignment must be revoked before role downgrade (SQLite invariant).
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  f.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  const fresh=await ok(get(query(),bob));
  assert.deepEqual(ids(fresh.tomorrow),["b-next","b-next2"]);
  for(const [handler,url] of [[statusGET,statusURL],[whenGET,whenURL]]){
    const response=await handler(new Request(url+"?taskId=s-bob",{
      headers:{cookie:bob},
    }));
    assert.equal(response.status,404);
  }
  assert.equal((await writeCommand(statusReceiptPOST,statusURL+"/receipt",
    savedStatus,bob)).status,404);
  assert.equal((await writeCommand(whenReceiptPOST,whenURL+"/receipt",
    savedWhen,bob)).status,404);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.equal((await get(query(),bob)).status,401);
  const denied=await whenGET(new Request(whenURL+"?taskId=b-next",{
    headers:{cookie:bob},
  }));
  assert.equal(denied.status,401);
});

test("BE-10 shared deadline and actor-private whenOn preserve earliest attention and CAS",async()=>{
  const f=fixture(),alice=owner(),bob=login(f,"bob"),carol=login(f,"carol");
  const baseline=await ok(get(query(),bob));
  assert.deepEqual(ids(baseline.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(baseline.tomorrow),["b-next","b-next2","s-bob"]);
  const initialDue=await writePreview(dueGET,dueURL,"s-bob",bob);
  assert.equal(initialDue.dueOn,"2026-11-05");
  const staleBobCommand={
    ...(({dueOn,...cas})=>cas)(initialDue),
    taskId:"s-bob",dueOn:"2026-11-06",commandId:randomUUID(),
  };
  const cursor=(await ok(get(query({limit:"1"}),bob))).nextCursor;
  assert.ok(cursor);

  // Bob moves his PERSONAL whenOn after the shared deadline. The earlier
  // dueOn still determines his attention day; no duplicated row is allowed.
  const {whenOn:prior,...privateCAS}=await writePreview(
    whenGET,whenURL,"s-bob",bob);
  assert.equal(prior,null);
  const laterPlan={...privateCAS,taskId:"s-bob",whenOn:"2026-11-06",
    commandId:randomUUID()};
  await accepted(whenPATCH,whenURL,laterPlan,bob,{ok:true});
  await accepted(whenReceiptPOST,whenURL+"/receipt",laterPlan,bob,
    {status:"committed"});
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  const stillDue=await ok(get(query(),bob));
  assert.deepEqual(ids(stillDue.today),ids(baseline.today));
  assert.deepEqual(ids(stillDue.tomorrow),ids(baseline.tomorrow));
  assert.equal(unique(stillDue),true);
  const stillDueTask=stillDue.tomorrow.tasks.find(x=>x.taskId==="s-bob");
  assert.equal(stillDueTask.whenOn,"2026-11-06");
  assert.equal(stillDueTask.dueOn,"2026-11-05");
  assert.equal(stillDueTask.attentionOn,"2026-11-05");
  assert.equal((await writePreview(dueGET,dueURL,"s-bob",alice)).dueOn,
    "2026-11-05","private whenOn cannot mutate shared dueOn");

  // Alice may edit the shared deadline as an Area admin even though the task
  // is assigned to Bob, not Alice. Bob's pre-Alice CAS must be rejected.
  const {dueOn:oldDue,...aliceCAS}=await writePreview(
    dueGET,dueURL,"s-bob",alice);
  assert.equal(oldDue,"2026-11-05");
  const bringForward={...aliceCAS,taskId:"s-bob",
    dueOn:"2026-11-04",commandId:randomUUID()};
  await accepted(duePATCH,dueURL,bringForward,alice,{ok:true});
  await accepted(dueReceiptPOST,dueURL+"/receipt",bringForward,alice,
    {status:"committed"});
  const conflict=await writeCommand(duePATCH,dueURL,staleBobCommand,bob);
  assert.equal(conflict.status,409,JSON.stringify(await conflict.clone().json()));
  assert.equal(conflict.headers.get("cache-control"),"no-store");
  await accepted(dueReceiptPOST,dueURL+"/receipt",staleBobCommand,bob,
    {status:"not_recorded"});

  const advanced=await ok(get(query(),bob));
  assert.deepEqual(ids(advanced.today),["b-overdue","b-today","s-bob"]);
  assert.deepEqual(ids(advanced.tomorrow),["b-next","b-next2"]);
  assert.equal(unique(advanced),true);
  const advancedTask=advanced.today.tasks.find(x=>x.taskId==="s-bob");
  assert.equal(advancedTask.attentionOn,"2026-11-04");
  assert.equal(advancedTask.whenOn,"2026-11-06");
  assert.equal(advancedTask.dueOn,"2026-11-04");

  // The editor's plan is actor-private, not a global list of shared tasks.
  const alicePlan=await ok(get(query(),alice));
  assert.equal([...ids(alicePlan.today),...ids(alicePlan.tomorrow)]
    .includes("s-bob"),false);
  assert.equal((await dueGET(new Request(
    dueURL+"?taskId=s-bob",{headers:{cookie:carol}}
  ))).status,404,"Area viewer cannot obtain writable dueOn CAS");
  assert.equal((await writeCommand(dueReceiptPOST,dueURL+"/receipt",
    bringForward,carol)).status,404,"viewer cannot inspect another actor receipt");

  // Undo the shared deadline and Bob's private plan as two NEW actor-specific
  // CAS commands. Neither operation replays an old request.
  const {dueOn:forwarded,...revertCAS}=await writePreview(
    dueGET,dueURL,"s-bob",alice);
  assert.equal(forwarded,"2026-11-04");
  const revert={...revertCAS,taskId:"s-bob",dueOn:"2026-11-05",
    commandId:randomUUID()};
  assert.notEqual(revert.commandId,bringForward.commandId);
  await accepted(duePATCH,dueURL,revert,alice,{ok:true});
  const {whenOn:planned,...clearCAS}=await writePreview(
    whenGET,whenURL,"s-bob",bob);
  assert.equal(planned,"2026-11-06");
  const clear={...clearCAS,taskId:"s-bob",whenOn:null,
    commandId:randomUUID()};
  assert.notEqual(clear.commandId,laterPlan.commandId);
  await accepted(whenPATCH,whenURL,clear,bob,{ok:true});
  await accepted(dueReceiptPOST,dueURL+"/receipt",revert,alice,
    {status:"committed"});
  await accepted(whenReceiptPOST,whenURL+"/receipt",clear,bob,
    {status:"committed"});
  const restored=await ok(get(query(),bob));
  assert.deepEqual(ids(restored.today),ids(baseline.today));
  assert.deepEqual(ids(restored.tomorrow),ids(baseline.tomorrow));
  assert.equal(unique(restored),true);
  const current=restored.tomorrow.tasks.find(x=>x.taskId==="s-bob");
  assert.equal(current.dueOn,"2026-11-05");
  assert.equal(current.whenOn,null);
  // Receipts refer to original commands, not current materialized values.
  await accepted(dueReceiptPOST,dueURL+"/receipt",bringForward,alice,
    {status:"committed"});
  await accepted(whenReceiptPOST,whenURL+"/receipt",laterPlan,bob,
    {status:"committed"});
  await accepted(dueReceiptPOST,dueURL+"/receipt",staleBobCommand,bob,
    {status:"not_recorded"});
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
});

test("BE-11 committed writes can be reconciled after lost responses and reauthentication",async()=>{
  const f=fixture(),firstSession=login(f,"bob");
  const baseline=await ok(get(query(),firstSession));
  assert.deepEqual(ids(baseline.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(baseline.tomorrow),["b-next","b-next2","s-bob"]);

  // The server receives the write but the client never observes its response.
  // The next action is read-only reconciliation, NEVER a second PATCH.
  const {whenOn:initialWhen,...whenCAS}=await writePreview(
    whenGET,whenURL,"b-next",firstSession);
  assert.equal(initialWhen,null);
  const scheduling={...whenCAS,taskId:"b-next",whenOn:"2026-11-04",
    commandId:randomUUID()};
  await writeCommand(whenPATCH,whenURL,scheduling,firstSession);

  // During a temporary feature-gate outage receipt is unavailable, NOT a
  // reliable signal that a previous command was rolled back.
  const oldWhenGate=process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED;
  try {
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED="false";
    assert.equal((await writeCommand(whenReceiptPOST,whenURL+"/receipt",
      scheduling,firstSession)).status,404);
  } finally {
    if(oldWhenGate===undefined)
      delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED;
    else process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED=oldWhenGate;
  }
  await accepted(whenReceiptPOST,whenURL+"/receipt",scheduling,firstSession,
    {status:"committed"});
  const scheduled=await ok(get(query(),firstSession));
  assert.deepEqual(ids(scheduled.today),["b-overdue","b-next","b-today"]);
  assert.deepEqual(ids(scheduled.tomorrow),["b-next2","s-bob"]);
  assert.equal(unique(scheduled),true);

  // A permanently revoked durable session cannot inspect receipts. The SAME
  // actor with a freshly issued session can recover the original command.
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.equal((await writeCommand(whenReceiptPOST,whenURL+"/receipt",
    scheduling,firstSession)).status,401);
  assert.equal((await get(query(),firstSession)).status,401);
  const secondSession=login(f,"bob");
  await accepted(whenReceiptPOST,whenURL+"/receipt",scheduling,secondSession,
    {status:"committed"});

  // Simulate a second lost response for shared completion, independently
  // confirmed from its original exact six-field command.
  const statusCAS=await writePreview(statusGET,statusURL,"s-bob",secondSession);
  const completing={...statusCAS,taskId:"s-bob",status:"completed",
    commandId:randomUUID()};
  await writeCommand(statusPATCH,statusURL,completing,secondSession);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.equal((await writeCommand(statusReceiptPOST,statusURL+"/receipt",
    completing,secondSession)).status,401);
  const thirdSession=login(f,"bob");
  await accepted(statusReceiptPOST,statusURL+"/receipt",completing,thirdSession,
    {status:"committed"});
  const afterCompletion=await ok(get(query(),thirdSession));
  assert.deepEqual(ids(afterCompletion.today),["b-overdue","b-next","b-today"]);
  assert.deepEqual(ids(afterCompletion.tomorrow),["b-next2"]);
  assert.equal(unique(afterCompletion),true);

  // Both Undo mutations must obtain CURRENT CAS from the reauthenticated
  // identity and use fresh IDs. Old original-command receipts stay committed.
  const {whenOn:nowWhen,...clearCAS}=await writePreview(
    whenGET,whenURL,"b-next",thirdSession);
  assert.equal(nowWhen,"2026-11-04");
  const clear={...clearCAS,taskId:"b-next",whenOn:null,
    commandId:randomUUID()};
  assert.notEqual(clear.commandId,scheduling.commandId);
  await accepted(whenPATCH,whenURL,clear,thirdSession,{ok:true});
  const reopenCAS=await writePreview(statusGET,statusURL,"s-bob",thirdSession);
  const reopen={...reopenCAS,taskId:"s-bob",status:"open",
    commandId:randomUUID()};
  assert.notEqual(reopen.commandId,completing.commandId);
  await accepted(statusPATCH,statusURL,reopen,thirdSession,{ok:true});

  const restored=await ok(get(query(),thirdSession));
  assert.deepEqual(ids(restored.today),ids(baseline.today));
  assert.deepEqual(ids(restored.tomorrow),ids(baseline.tomorrow));
  assert.equal(unique(restored),true);
  await accepted(whenReceiptPOST,whenURL+"/receipt",scheduling,thirdSession,
    {status:"committed"});
  await accepted(statusReceiptPOST,statusURL+"/receipt",completing,thirdSession,
    {status:"committed"});
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
});

test("BE-11 never-sent command stays not_recorded and does not mutate the plan",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const baseline=await ok(get(query(),bob));
  const {whenOn:before,...previewCAS}=await writePreview(
    whenGET,whenURL,"b-next",bob);
  assert.equal(before,null);
  const lostBeforeDispatch={...previewCAS,taskId:"b-next",
    whenOn:"2026-11-04",commandId:randomUUID()};
  // The network fails BEFORE PATCH dispatch, so only the receipt is queried.
  await accepted(whenReceiptPOST,whenURL+"/receipt",lostBeforeDispatch,bob,
    {status:"not_recorded"});
  const unchanged=await ok(get(query(),bob));
  assert.deepEqual(unchanged,baseline);
  // An explicit fresh action is distinct from a replay of an uncertain one.
  const {whenOn:stillNull,...newCAS}=await writePreview(
    whenGET,whenURL,"b-next",bob);
  assert.equal(stillNull,null);
  const explicit={...newCAS,taskId:"b-next",whenOn:"2026-11-04",
    commandId:randomUUID()};
  assert.notEqual(explicit.commandId,lostBeforeDispatch.commandId);
  await accepted(whenPATCH,whenURL,explicit,bob,{ok:true});
  await accepted(whenReceiptPOST,whenURL+"/receipt",explicit,bob,
    {status:"committed"});
  await accepted(whenReceiptPOST,whenURL+"/receipt",lostBeforeDispatch,bob,
    {status:"not_recorded"});
  const changed=await ok(get(query(),bob));
  assert.ok(ids(changed.today).includes("b-next"));
  assert.equal(unique(changed),true);
});

/** BE-12: a real fetch-compatible in-process HTTP bridge from the
 * actual UI-04a transports to real Node route handlers. No stub responses:
 * only the network-transport outcome can be intentionally lost AFTER PATCH. */
function routedClient(cookie){
  const calls=[];
  let lostPatch=0;
  let afterPatch=null;
  const handlers={
    "/api/target-staging/task-temporal/personal-when/command":{
      GET:whenGET,PATCH:whenPATCH,
    },
    "/api/target-staging/task-temporal/personal-when/command/receipt":{
      POST:whenReceiptPOST,
    },
    "/api/target-staging/task-temporal/status":{
      GET:statusGET,PATCH:statusPATCH,
    },
    "/api/target-staging/task-temporal/status/receipt":{
      POST:statusReceiptPOST,
    },
  };
  async function fetchRequest(relative,init={}){
    const url=new URL(relative,"http://localhost:3001");
    assert.equal(url.origin,"http://localhost:3001");
    const method=init.method??"GET";
    const handler=handlers[url.pathname]?.[method];
    assert.equal(typeof handler,"function","only exact staging endpoints are allowed");
    const headers=new Headers(init.headers);
    headers.set("cookie",cookie);
    headers.set("x-forwarded-for","10.99.8.116");
    if(method!=="GET")headers.set("origin",url.origin);
    const request=new Request(url,{method,headers,body:init.body,signal:init.signal});
    calls.push([method,url.pathname]);
    const response=await handler(request);
    if(method==="PATCH"&&lostPatch>0){
      lostPatch--;
      const callback=afterPatch;
      afterPatch=null;
      if(callback)callback(response);
      throw Error("simulated lost HTTP response after real write handler");
    }
    return response;
  }
  return {
    fetch:fetchRequest,calls,
    loseNextPatch(callback=null){lostPatch++;afterPatch=callback;},
  };
}

test("BE-12 real client CAS transports and authenticated route handlers agree end-to-end",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const original=await ok(get(query(),bob));
  const bridge=routedClient(bob);
  const prepWhen=await prepareMyPlanWhen({
    taskId:"b-next",areaId:"bob-private",whenOn:"2026-11-04",
  },bridge.fetch);
  assert.equal(prepWhen.ok,true,JSON.stringify(prepWhen));
  assert.equal(prepWhen.previousWhenOn,null);
  bridge.loseNextPatch(response=>assert.equal(response.status,200));
  const saved=await dispatchMyPlanWhen(prepWhen.command,bridge.fetch);
  assert.equal(saved.kind,"committed");
  assert.deepEqual(bridge.calls.map(([method])=>method),["GET","PATCH","POST"]);
  assert.deepEqual(await checkMyPlanWhenReceipt(prepWhen.command,bridge.fetch),
    {kind:"committed"});
  const moved=await ok(get(query(),bob));
  assert.deepEqual(ids(moved.today),["b-overdue","b-next","b-today"]);
  assert.deepEqual(ids(moved.tomorrow),["b-next2","s-bob"]);
  assert.equal(unique(moved),true);

  const prepStatus=await prepareMyPlanStatus({
    taskId:"s-bob",areaId:"family-area",status:"completed",
  },bridge.fetch);
  assert.equal(prepStatus.ok,true,JSON.stringify(prepStatus));
  bridge.loseNextPatch(response=>assert.equal(response.status,200));
  const completed=await dispatchMyPlanStatus(prepStatus.command,bridge.fetch);
  assert.equal(completed.kind,"committed");
  assert.deepEqual(await checkMyPlanStatusReceipt(prepStatus.command,bridge.fetch),
    {kind:"committed"});
  const after=await ok(get(query(),bob));
  assert.deepEqual(ids(after.tomorrow),["b-next2"]);
  assert.equal(unique(after),true);

  // A viewer's transport can GET only a refused preview; it cannot PATCH.
  const viewer=routedClient(carol);
  assert.deepEqual(await prepareMyPlanWhen({
    taskId:"s-bob",areaId:"family-area",whenOn:"2026-11-04",
  },viewer.fetch),{ok:false,reason:"unavailable"});
  assert.deepEqual(viewer.calls.map(([method])=>method),["GET"]);

  const undoStatus=await prepareMyPlanStatus({
    taskId:"s-bob",areaId:"family-area",status:"open",
  },bridge.fetch);
  assert.equal(undoStatus.ok,true,JSON.stringify(undoStatus));
  assert.notEqual(undoStatus.command.commandId,prepStatus.command.commandId);
  assert.equal((await dispatchMyPlanStatus(undoStatus.command,bridge.fetch)).kind,
    "committed");
  const undoWhen=await prepareMyPlanWhen({
    taskId:"b-next",areaId:"bob-private",whenOn:null,
  },bridge.fetch);
  assert.equal(undoWhen.ok,true,JSON.stringify(undoWhen));
  assert.equal(undoWhen.previousWhenOn,"2026-11-04");
  assert.notEqual(undoWhen.command.commandId,prepWhen.command.commandId);
  assert.equal((await dispatchMyPlanWhen(undoWhen.command,bridge.fetch)).kind,
    "committed");
  const restored=await ok(get(query(),bob));
  assert.deepEqual(ids(restored.today),ids(original.today));
  assert.deepEqual(ids(restored.tomorrow),ids(original.tomorrow));
  assert.equal(unique(restored),true);
  assert.deepEqual(await checkMyPlanWhenReceipt(prepWhen.command,bridge.fetch),
    {kind:"committed"});
  assert.deepEqual(await checkMyPlanStatusReceipt(prepStatus.command,bridge.fetch),
    {kind:"committed"});
});

test("BE-12 client remains uncertain on post-commit session revocation until new-actor-session receipt",async()=>{
  const f=fixture(),oldCookie=login(f,"bob");
  const oldBridge=routedClient(oldCookie);
  const prepared=await prepareMyPlanWhen({
    taskId:"b-next",areaId:"bob-private",whenOn:"2026-11-04",
  },oldBridge.fetch);
  assert.equal(prepared.ok,true,JSON.stringify(prepared));
  oldBridge.loseNextPatch(response=>{
    assert.equal(response.status,200);
    assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
      f.store,"bob").ok,true);
  });
  const dispatched=await dispatchMyPlanWhen(prepared.command,oldBridge.fetch);
  assert.equal(dispatched.kind,"uncertain");
  assert.deepEqual(oldBridge.calls.map(([method])=>method),
    ["GET","PATCH","POST"]);
  assert.equal((await get(query(),oldCookie)).status,401);
  assert.deepEqual(await checkMyPlanWhenReceipt(
    prepared.command,oldBridge.fetch),{kind:"unknown",reason:"signed-out"});

  const newCookie=login(f,"bob"),newBridge=routedClient(newCookie);
  assert.deepEqual(await checkMyPlanWhenReceipt(
    prepared.command,newBridge.fetch),{kind:"committed"});
  const read=await ok(get(query(),newCookie));
  assert.deepEqual(ids(read.today),["b-overdue","b-next","b-today"]);
  assert.equal(unique(read),true);
  // The newly authenticated actor can issue a FRESH, independent Undo CAS.
  const undo=await prepareMyPlanWhen({
    taskId:"b-next",areaId:"bob-private",whenOn:null,
  },newBridge.fetch);
  assert.equal(undo.ok,true,JSON.stringify(undo));
  assert.notEqual(undo.command.commandId,prepared.command.commandId);
  assert.equal((await dispatchMyPlanWhen(undo.command,newBridge.fetch)).kind,
    "committed");
  const restored=await ok(get(query(),newCookie));
  assert.deepEqual(ids(restored.today),["b-overdue","b-today"]);
  assert.deepEqual(ids(restored.tomorrow),["b-next","b-next2","s-bob"]);
  assert.deepEqual(await checkMyPlanWhenReceipt(
    prepared.command,newBridge.fetch),{kind:"committed"});
  assert.equal(oldBridge.calls.filter(([method])=>method==="PATCH").length,1);
});

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

test("project-only revision in an empty authorized Area invalidates cursor",async()=>{
  const f=fixture(),bob=login(f,"bob");
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('bob-empty','Empty','private','bob-ws','bob')").run();
  const first=await ok(get(query({limit:"1"}),bob));
  const cursor=first.nextCursor;assert.ok(cursor);
  // An unrelated person's Area cannot invalidate Bob's continuation.
  f.db.prepare("UPDATE areas SET project_content_revision=project_content_revision+1 WHERE id='carol-private'").run();
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,200);
  const before=f.db.prepare(
    "SELECT content_revision AS content,project_content_revision AS project FROM areas WHERE id='bob-empty'"
  ).get();
  // Simulate a project-only content change not reflected in task content.
  f.db.prepare("UPDATE areas SET project_content_revision=project_content_revision+1 WHERE id='bob-empty'").run();
  const after=f.db.prepare(
    "SELECT content_revision AS content,project_content_revision AS project FROM areas WHERE id='bob-empty'"
  ).get();
  assert.equal(after.content,before.content);
  assert.equal(after.project,before.project+1);
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  const fresh=await ok(get(query({limit:"1"}),bob));
  assert.deepEqual(ids(fresh.today),ids(first.today));
  assert.deepEqual(ids(fresh.tomorrow),ids(first.tomorrow));
});

test("real project rename expires My Plan cursor without a task epoch change",async()=>{
  const f=fixture(),bob=login(f,"bob");
  f.db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('b-project','bob-private','Old title')").run();
  const cursor=(await ok(get(query({limit:"1"}),bob))).nextCursor;
  assert.ok(cursor);
  const epochs=()=>f.db.prepare(
    "SELECT content_revision AS content,project_content_revision AS project FROM areas WHERE id='bob-private'"
  ).get();
  const before=epochs();
  // Project title trigger bumps project revision / Area project-content epoch.
  f.db.prepare("UPDATE projects SET title='New title' WHERE id='b-project'").run();
  const after=epochs();
  assert.equal(after.content,before.content);
  assert.equal(after.project,before.project+1);
  assert.equal((await get(query({limit:"1",cursor}),bob)).status,409);
  assert.equal((await get(query({limit:"1"}),bob)).status,200);
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
