import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const flagNames=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED",
];
const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  ...flagNames,"AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5c2-attention-cmd-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-attention-command-secret-at-least-32",
  ...Object.fromEntries(flagNames.map(k=>[k,"true"])),
});
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX:PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET,PATCH}=await import("../app/api/target-staging/attention/command/route.ts");
const {POST}=await import("../app/api/target-staging/attention/command/receipt/route.ts");
const {GET:LIST}=await import("../app/api/target-staging/attention/route.ts");
const {parseAttentionCommandWriteReply,parseAttentionCommandReceiptReply,
  parseAttentionCommandReceiptSnapshotReply,readAttentionCommandReceiptSnapshotInChild}=
  await import("../lib/target-staging-attention-command-process.ts");
const {parseStagingAttentionCommandPreview,readStagingAttentionCommandPreviewInChild}=
  await import("../lib/target-staging-read-process.ts");
const {verifyAttentionCommandPreviewLive}=
  await import("../lib/target-staging-attention-command-http.ts");

let count=0;
after(()=>{
  for(const [key,value] of Object.entries(old)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const TZ="Europe/Prague";
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
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
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title,due_on,assignee_user_id,status) VALUES (?,?,?,?,?,?)");
  // 2020 dates are always overdue against the real server clock.
  for(const row of [
    ["p-alice",stage.unassignedAreaId,"Alice secret title","2020-01-01",null,"open"],
    ["p-alice2",stage.unassignedAreaId,"Alice second","2020-01-02",null,"open"],
    ["p-done",stage.unassignedAreaId,"Alice done","2020-01-01",null,"open"],
    ["p-future",stage.unassignedAreaId,"Alice future","2099-01-01",null,"open"],
    ["p-bob","bob-private","Bob secret title","2020-01-01",null,"open"],
    ["s-bob","family-area","Bob assigned","2020-01-01","bob","open"],
    ["s-other","family-area","Not assigned","2020-01-01","alice","open"],
  ])insert.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1 WHERE id='p-done'").run();
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
function login(fx,who){
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const origin="http://localhost:3001";
const base=origin+"/api/target-staging/attention/command";
const OCC="2020-01-01";
function query(taskId,rule="deadline_overdue",on=OCC,cookie=owner(),extra=""){
  return GET(new Request(base+"?taskId="+encodeURIComponent(taskId)+
    "&ruleId="+rule+"&occurrenceOn="+on+extra,{
    headers:{cookie,"x-forwarded-for":"10.52.21.3"},
  }));
}
function call(method,command,cookie=owner(),options={}){
  const url=base+(method==="POST"?"/receipt":"")+(options.query||"");
  return (method==="PATCH"?PATCH:POST)(new Request(url,{
    method,headers:{
      cookie,"content-type":"application/json","x-forwarded-for":"10.52.21.3",
      ...(options.origin===null?{}:{origin:options.origin||origin}),
      ...(options.protocol===null?{}:{"x-lumi-target-protocol":options.protocol||"1"}),
    },body:typeof command==="string"?command:JSON.stringify(command),
  }));
}
const PREVIEW_KEYS=["expectedAttentionEpoch","expectedRevision","expectedStateRevision",
  "lifecycle","restoreGeneration","snoozedUntilMs","writeAreaId"];
async function preview(taskId,rule="deadline_overdue",on=OCC,cookie=owner()){
  const response=await query(taskId,rule,on,cookie);
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(result).sort(),PREVIEW_KEYS);
  assert.match(result.expectedRevision,/^[a-f0-9]{64}$/);
  return result;
}
async function command(taskId,action,cookie=owner(),
  {rule="deadline_overdue",on=OCC,until=null}={}){
  const {lifecycle,snoozedUntilMs,...cas}=await preview(taskId,rule,on,cookie);
  return {...cas,commandId:randomUUID(),taskId,ruleId:rule,occurrenceOn:on,action,
    snoozedUntilMs:action==="snooze"?(until??Date.now()+3_600_000):null,timeZone:TZ};
}
const read=(fx,sql,...params)=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare(sql).get(...params);}
  finally{db.close();}
};
const state=(fx,actor,taskId,rule="deadline_overdue",on=OCC)=>read(fx,
  "SELECT state,snoozed_until_ms AS until,revision FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?",
  actor,taskId,rule,on);
const epoch=(fx,actor)=>read(fx,"SELECT revision FROM personal_attention_epochs WHERE user_id=?",actor).revision;
const receiptCount=fx=>read(fx,"SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",PREFIX+"%").n;
const mutable=fx=>JSON.stringify([
  read(fx,"SELECT COUNT(*) AS n FROM personal_attention_states"),
  read(fx,"SELECT COALESCE(SUM(revision),0) AS n FROM personal_attention_epochs"),
  receiptCount(fx),read(fx,"SELECT COUNT(*) AS n FROM tasks WHERE revision<>0")]);
const listAttention=async(view,cookie=owner())=>{
  const res=await LIST(new Request(origin+"/api/target-staging/attention?view="+view+
    "&timeZone="+TZ,{headers:{cookie,"x-forwarded-for":"10.52.21.3"}}));
  const body=await res.json();assert.equal(res.status,200,JSON.stringify(body));
  return body;
};

test("all four flags independently default off per method; identity and selectors fail closed",async()=>{
  fixture();
  for(const flag of flagNames){
    process.env[flag]="false";
    assert.equal((await query("p-alice")).status,404,flag);
    assert.equal((await call("PATCH",{})).status,404,flag);
    assert.equal((await call("POST",{})).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+"?taskId=p-alice&ruleId=deadline_overdue&occurrenceOn="+OCC))).status,401);
  assert.equal((await PATCH(new Request(base,{method:"PATCH",body:"{}"}))).status,401);
  assert.equal((await POST(new Request(base+"/receipt",{method:"POST",body:"{}"}))).status,401);
  const bad=["","?taskId=p-alice","?taskId=p-alice&ruleId=deadline_overdue",
    "?taskId=p-alice&ruleId=nope&occurrenceOn="+OCC,
    "?taskId=p-alice&ruleId=deadline_overdue&occurrenceOn=2026-02-29",
    "?taskId=p-alice&ruleId=deadline_overdue&occurrenceOn="+OCC+"&actor=bob",
    "?taskId=p-alice&taskId=p-bob&ruleId=deadline_overdue&occurrenceOn="+OCC,
    "?taskId=&ruleId=deadline_overdue&occurrenceOn="+OCC,
    "?taskId=%00&ruleId=deadline_overdue&occurrenceOn="+OCC];
  for(const tail of bad){
    const r=await GET(new Request(base+tail,{headers:{cookie:owner()}}));
    assert.equal(r.status,400,tail);
  }
});

test("preview returns exactly the CAS inputs and lifecycle derived from the raw row and server now",async()=>{
  const fx=fixture();
  const first=await preview("p-alice");
  assert.deepEqual(first,{
    expectedRevision:first.expectedRevision,
    expectedAttentionEpoch:0,expectedStateRevision:null,
    writeAreaId:fx.stage.unassignedAreaId,restoreGeneration:fx.stage.restoreGeneration,
    lifecycle:"active",snoozedUntilMs:null,
  });
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES ('alice','p-alice','deadline_overdue',?,'dismissed',NULL)").run(OCC);
  db.close();
  const dismissed=await preview("p-alice");
  assert.equal(dismissed.lifecycle,"dismissed");
  assert.equal(dismissed.expectedStateRevision,0);
  assert.equal(dismissed.expectedAttentionEpoch,epoch(fx,"alice"));
  const future=Date.now()+3_600_000;
  const db2=new DatabaseSync(fx.stage.databasePath);
  db2.prepare("UPDATE personal_attention_states SET state='snoozed',snoozed_until_ms=? WHERE user_id='alice'").run(future);
  db2.close();
  const snoozed=await preview("p-alice");
  assert.equal(snoozed.lifecycle,"snoozed");
  assert.equal(snoozed.snoozedUntilMs,future);
  const db3=new DatabaseSync(fx.stage.databasePath);
  db3.prepare("UPDATE personal_attention_states SET snoozed_until_ms=? WHERE user_id='alice'").run(Date.now()-1000);
  db3.close();
  const expired=await preview("p-alice");
  assert.equal(expired.lifecycle,"active","expired snooze is active again");
  assert.equal(expired.snoozedUntilMs,null);
  assert.equal(expired.expectedStateRevision,
    read(fx,"SELECT revision FROM personal_attention_states WHERE user_id='alice'").revision,
    "row revision retained for the CAS");
});

test("preview is an indistinguishable 404 for viewer, unassigned, foreign, completed, stale occurrence and unknown",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const bodies=[];
  for(const [id,rule,on,cookie] of [
    ["s-bob","deadline_overdue",OCC,carol],         // viewer
    ["s-other","deadline_overdue",OCC,bob],         // not assigned
    ["p-alice","deadline_overdue",OCC,bob],         // foreign private
    ["p-bob","deadline_overdue",OCC,owner()],       // foreign private (owner identity)
    ["p-done","deadline_overdue",OCC,owner()],      // completed
    ["unknown","deadline_overdue",OCC,owner()],     // nonexistent
    ["p-alice","deadline_overdue","2020-01-09",owner()], // not the task's date
    ["p-alice","planned_date_passed",OCC,owner()],  // no plan
  ]){
    const r=await query(id,rule,on,cookie);
    assert.equal(r.status,404,id+rule+on);
    bodies.push(JSON.stringify(await r.json()));
  }
  assert.equal(new Set(bodies).size,1);
  const mine=await preview("s-bob","deadline_overdue",OCC,bob);
  assert.equal(mine.writeAreaId,"family-area");
});

test("UI flow: attention item -> preview -> dismiss -> hidden -> restore -> active; replay, receipt, no leaks",async()=>{
  const fx=fixture(),cookie=owner();
  const list=await listAttention("active");
  const item=list.items.find(i=>i.taskId==="p-alice");
  assert.ok(item);
  assert.equal(item.lifecycle,"active");
  const c=await command(item.taskId,"dismiss",cookie,{rule:item.ruleId,on:item.relevantOn});
  assert.equal(c.expectedAttentionEpoch,list.attentionEpoch);
  assert.deepEqual(Object.keys(c).sort(),[
    "action","commandId","expectedAttentionEpoch","expectedRevision","expectedStateRevision",
    "occurrenceOn","restoreGeneration","ruleId","snoozedUntilMs","taskId","timeZone","writeAreaId"]);
  const before=mutable(fx);
  const status=await call("POST",c,cookie);
  assert.deepEqual(await status.json(),{status:"not_recorded"});
  assert.equal(mutable(fx),before,"receipt POST never mutates");
  const ok=await call("PATCH",c,cookie);
  const okText=await ok.clone().text();
  assert.equal(ok.status,200,okText);
  assert.deepEqual(JSON.parse(okText),{ok:true});
  for(const secret of ["Alice secret title","alice","2020-01-01"])
    assert.equal(okText.includes(secret),false);
  assert.equal(state(fx,"alice","p-alice").state,"dismissed");
  assert.equal(epoch(fx,"alice"),1);
  assert.equal((await listAttention("active")).items.some(i=>i.taskId==="p-alice"),false);
  const hidden=await listAttention("hidden");
  const hiddenItem=hidden.items.find(i=>i.taskId==="p-alice");
  assert.equal(hiddenItem.lifecycle,"dismissed");
  const receipt=await call("POST",c,cookie);
  const receiptText=await receipt.text();
  assert.deepEqual(JSON.parse(receiptText),{status:"committed"});
  for(const secret of ["Alice secret title","alice","2020-01-01"])
    assert.equal(receiptText.includes(secret),false);
  assert.deepEqual(await (await call("PATCH",c,cookie)).json(),{ok:true,replayed:true});
  assert.equal(epoch(fx,"alice"),1,"replay does not move the epoch");
  assert.equal(receiptCount(fx),1);
  // Restore (Undo) from a fresh preview.
  const pv=await preview("p-alice");
  assert.equal(pv.lifecycle,"dismissed");
  assert.equal(pv.expectedStateRevision,0);
  const restore=await command("p-alice","restore",cookie);
  assert.deepEqual(await (await call("PATCH",restore,cookie)).json(),{ok:true});
  assert.equal(state(fx,"alice","p-alice"),undefined);
  assert.equal((await listAttention("active")).items.some(i=>i.taskId==="p-alice"),true);
  assert.equal((await preview("p-alice")).lifecycle,"active");
  assert.equal(receiptCount(fx),2);
  // The old dismiss receipt is still committed after restore.
  assert.deepEqual(await (await call("POST",c,cookie)).json(),{status:"committed"});
});

test("snooze, stale CAS, idempotency conflict, not_active, unchanged and invalid snooze map to content-free statuses",async()=>{
  const fx=fixture(),cookie=owner();
  const snooze=await command("p-alice","snooze",cookie);
  assert.equal((await call("PATCH",snooze,cookie)).status,200);
  assert.equal(state(fx,"alice","p-alice").state,"snoozed");
  assert.equal((await preview("p-alice")).lifecycle,"snoozed");
  // Idempotency conflict: same commandId, different payload.
  const conflict={...snooze,snoozedUntilMs:snooze.snoozedUntilMs+1000};
  assert.equal((await call("PATCH",conflict,cookie)).status,409);
  assert.equal((await call("POST",conflict,cookie)).status,409);
  // Stale CAS: the old expected epoch/state after a successful write.
  assert.equal((await call("PATCH",{...snooze,commandId:randomUUID()},cookie)).status,409);
  // not_active: dismissing an already-snoozed (hidden) occurrence.
  const again=await command("p-alice","dismiss",cookie);
  const notActive=await call("PATCH",again,cookie);
  assert.equal(notActive.status,409);
  assert.deepEqual(await notActive.json(),{error:"Revision conflict"});
  // not_active: a future deadline is not a current candidate.
  const futureCmd=await command("p-alice","restore",cookie);
  assert.equal((await call("PATCH",futureCmd,cookie)).status,200);
  const db=new DatabaseSync(fx.stage.databasePath);
  const row=db.prepare("SELECT revision FROM tasks WHERE id='p-future'").get();db.close();
  assert.ok(row);
  const fut=await command("p-future","dismiss",cookie,{on:"2099-01-01"}).catch(()=>null);
  assert.ok(fut,"preview for a future occurrence is allowed (task's own date)");
  assert.equal((await call("PATCH",{...fut,ruleId:"deadline_overdue"},cookie)).status,404);
  // unchanged: restoring an active occurrence.
  const noop=await command("p-alice","restore",cookie);
  const unchanged=await call("PATCH",noop,cookie);
  assert.equal(unchanged.status,409);
  // invalid snooze window -> 400, nothing written.
  const bad=await command("p-alice","snooze",cookie,{until:Date.now()+40*86_400_000});
  const before=mutable(fx);
  assert.equal((await call("PATCH",bad,cookie)).status,400);
  assert.equal(mutable(fx),before);
});

test("CSRF, exact fields, protocol, size, query and cross-Area commands fail closed",async()=>{
  const fx=fixture(),cookie=owner();
  const c=await command("p-alice","dismiss",cookie);
  const before=mutable(fx);
  assert.equal((await call("PATCH",c,cookie,{origin:"https://evil.test"})).status,403);
  assert.equal((await call("POST",c,cookie,{origin:"https://evil.test"})).status,403);
  assert.equal((await call("PATCH",c,cookie,{origin:null})).status,403);
  assert.equal((await call("PATCH",c,cookie,{protocol:null})).status,400);
  assert.equal((await call("POST",c,cookie,{protocol:null})).status,400);
  assert.equal((await call("PATCH",c,cookie,{query:"?x=1"})).status,400);
  assert.equal((await call("PATCH",{...c,actorUserId:"alice"},cookie)).status,400);
  assert.equal((await call("POST",{...c,actorUserId:"alice"},cookie)).status,400);
  const {timeZone,...missing}=c;
  assert.equal((await call("PATCH",missing,cookie)).status,400);
  assert.equal((await call("PATCH",{...c,timeZone:"Not/AZone"},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,occurrenceOn:"2026-02-29"},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,expectedAttentionEpoch:-1},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,action:"snooze"},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,commandId:"x".repeat(40*1024)},cookie)).status,413);
  assert.equal((await call("PATCH","{not json",cookie)).status,400);
  assert.equal((await call("PATCH",{...c,restoreGeneration:randomUUID()},cookie)).status,409);
  assert.equal((await call("PATCH",{...c,writeAreaId:"bob-private"},cookie)).status,404);
  assert.equal(mutable(fx),before,"no refusal mutates anything");
  // Task changed after the preview -> stale revision.
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET title='edited' WHERE id='p-alice'").run();db.close();
  assert.equal((await call("PATCH",c,cookie)).status,409);
  assert.equal(receiptCount(fx),0);
});

test("shared tasks require current assignment and editor ACL; another actor cannot act or read receipts",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  const c=await command("s-bob","dismiss",bob);
  assert.equal(c.writeAreaId,"family-area");
  assert.equal((await call("PATCH",c,carol)).status,404);
  assert.equal((await call("POST",c,carol)).status,404);
  assert.equal((await call("PATCH",c,owner())).status,404);
  assert.deepEqual(await (await call("PATCH",c,bob)).json(),{ok:true});
  assert.equal(state(fx,"bob","s-bob").state,"dismissed");
  assert.equal(state(fx,"alice","s-bob"),undefined,"only the actor's own row changes");
  assert.equal(epoch(fx,"alice"),0);
  assert.deepEqual(await (await call("POST",c,bob)).json(),{status:"committed"});
  assert.equal((await call("POST",c,carol)).status,404,"ACL before receipt lookup");
  // Another actor's receipt of the same command id is never visible.
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();db.close();
  assert.equal((await query("s-bob","deadline_overdue",OCC,bob)).status,404);
  assert.equal((await call("POST",c,bob)).status,404);
  assert.equal((await call("PATCH",c,bob)).status,404);
});

test("revoked durable session between preview and PATCH is refused and nothing is written",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const c=await command("s-bob","dismiss",bob);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  const before=mutable(fx);
  assert.equal((await call("PATCH",c,bob)).status,401);
  assert.equal((await call("POST",c,bob)).status,401);
  assert.equal((await query("s-bob","deadline_overdue",OCC,bob)).status,401);
  assert.equal(mutable(fx),before);
  assert.equal(state(fx,"bob","s-bob"),undefined);
});

test("receipt POST: committed, not_recorded, conflict; live guard goes stale after a lifecycle write",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const c=await command("s-bob","dismiss",bob);
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash};
  const snapshot=()=>readAttentionCommandReceiptSnapshotInChild(config,c);
  const beforeSnap=await snapshot();
  assert.equal(beforeSnap?.ok,true,JSON.stringify(beforeSnap));
  assert.deepEqual(beforeSnap.receipt,{ok:true,status:"not_recorded"});
  const request=new Request(base+"/receipt",{
    method:"POST",headers:{cookie:bob,origin},body:"{}",
  });
  const identity={kind:"session",tokenHash};
  const live=entry=>verifyAttentionCommandPreviewLive(
    request,identity,{...fx.store,ownerUserId:"alice"},entry.preview);
  assert.equal(live(beforeSnap),"ok");
  assert.deepEqual(await (await call("POST",c,bob)).json(),{status:"not_recorded"});
  assert.deepEqual(await (await call("PATCH",c,bob)).json(),{ok:true});
  assert.equal(live(beforeSnap),"stale","attention epoch moved by the commit");
  const committed=await snapshot();
  assert.deepEqual(committed.receipt,{ok:true,status:"committed"});
  assert.equal(live(committed),"ok");
  assert.deepEqual(await (await call("POST",c,bob)).json(),{status:"committed"});
  const conflictBody={...c,expectedStateRevision:7};
  assert.equal((await call("POST",conflictBody,bob)).status,409);
  assert.equal((await call("POST",{...c,restoreGeneration:randomUUID()},bob)).status,409);
  // An Area the actor can see but that does not own the task is a mismatch (409).
  assert.equal((await call("POST",{...c,writeAreaId:"bob-private"},bob)).status,409);
  assert.equal((await call("POST",{...c,taskId:"s-other"},bob)).status,404);
  assert.equal(receiptCount(fx),1);
  // A write under another actor's epoch does not stale this actor's guard.
  const alice=await command("p-alice","dismiss");
  assert.equal((await call("PATCH",alice)).status,200);
  assert.equal(live(committed),"ok");
});

test("preview child and DTO parsers reject injected data and invalid witnesses",async()=>{
  const fx=fixture();
  const sample=await readStagingAttentionCommandPreviewInChild(
    {...fx.store,ownerUserId:"alice"},"p-alice","deadline_overdue",OCC);
  assert.equal(sample?.ok,true,JSON.stringify(sample));
  assert.deepEqual(await readStagingAttentionCommandPreviewInChild(
    {...fx.store,ownerUserId:"alice"},"p-bob","deadline_overdue",OCC),
    {ok:false,reason:"inaccessible"});
  const base={ok:true,expectedRevision:"a".repeat(64),expectedAttentionEpoch:0,
    expectedStateRevision:null,lifecycle:"active",snoozedUntilMs:null,writeAreaId:"area",
    linearization:{actorUserId:"alice",areas:[{
      areaId:"area",areaKind:"private",access:"private-owner",policyRevision:0}]},
    guard:{taskId:"t",projectId:null,areaId:"area",taskRevision:0,parentRevision:null}};
  assert.equal(parseStagingAttentionCommandPreview(base,"t")?.ok,true);
  assert.equal(parseStagingAttentionCommandPreview(
    {...base,lifecycle:"dismissed",expectedStateRevision:0},"t")?.ok,true);
  assert.equal(parseStagingAttentionCommandPreview(
    {...base,lifecycle:"active",expectedStateRevision:2},"t")?.ok,true);
  for(const broken of [
    {...base,title:"secret"},
    {...base,actorUserId:"alice"},
    {...base,expectedAttentionEpoch:-1},
    {...base,lifecycle:"hidden"},
    {...base,lifecycle:"dismissed"},
    {...base,lifecycle:"snoozed",expectedStateRevision:0},
    {...base,lifecycle:"dismissed",expectedStateRevision:0,snoozedUntilMs:5},
    {...base,snoozedUntilMs:5},
    {...base,guard:{...base.guard,taskId:"foreign"}},
    {...base,linearization:{...base.linearization,areas:[{
      ...base.linearization.areas[0],access:"viewer"}]}},
  ])assert.equal(parseStagingAttentionCommandPreview(broken,"t"),null);
  assert.deepEqual(parseAttentionCommandWriteReply({ok:true}),{ok:true});
  assert.deepEqual(parseAttentionCommandWriteReply({ok:false,reason:"not_active"}),
    {ok:false,reason:"not_active"});
  assert.equal(parseAttentionCommandWriteReply({ok:true,taskId:"secret"}),null);
  assert.equal(parseAttentionCommandWriteReply({ok:false,reason:"unauthorized"}),null);
  assert.deepEqual(parseAttentionCommandReceiptReply({ok:true,status:"committed"}),
    {ok:true,status:"committed"});
  assert.equal(parseAttentionCommandReceiptReply({ok:true,status:"committed",actor:"a"}),null);
  const c=await command("p-alice","dismiss");
  const snap=await readAttentionCommandReceiptSnapshotInChild({...fx.store,ownerUserId:"alice"},c);
  assert.equal(snap?.ok,true,JSON.stringify(snap));
  for(const invalid of [
    {...snap,actor:"alice"},
    {...snap,receipt:{ok:true,status:"unknown"}},
    {...snap,preview:{...snap.preview,secret:1}},
    {...snap,preview:{...snap.preview,expectedAttentionEpoch:-1}},
    {ok:true,receipt:snap.receipt},
  ])assert.equal(parseAttentionCommandReceiptSnapshotReply(invalid,c.taskId),null);
});
