import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5d2-notification-writer-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const oldData=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX:SETTINGS_PREFIX,
  TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX:TARGET_PREFIX,
  TARGET_STAGING_PUSH_BASELINE_PREFIX:BASELINE_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetStagingNotificationSettingsCommand,validTargetStagingPushTargetCommand,
  targetPushBaselineKey,targetPushBaselineValue}=
  await import("../lib/target-notification-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const all=[];
const sha=text=>createHash("sha256").update(text).digest("hex");
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const actor of ["bob"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(actor+"-ws",actor);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(actor+"-area",actor,actor+"-ws",actor);
  }
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  const fx={stage,db,authority,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};all.push(fx);return fx;
}
after(()=>{
  for(const fx of all){fx.authority.close();fx.db.close();}
  if(oldData===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=oldData;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const denied=reason=>({ok:false,reason});
const settingsRow=(fx,who)=>({...fx.db.prepare(
  "SELECT time_zone,attention_push,quiet_start,quiet_end,daily_limit,paused,revision FROM personal_notification_settings WHERE user_id=?").get(who)});
const epoch=(fx,who)=>fx.db.prepare(
  "SELECT revision FROM personal_notification_epochs WHERE user_id=?").get(who).revision;
const receipts=(fx,prefix)=>fx.db.prepare(
  "SELECT key,value FROM metadata WHERE key LIKE ?").all(prefix+"%");
const targets=(fx,who)=>fx.db.prepare(
  "SELECT target_id,endpoint_hash,revoked_at_ms FROM personal_push_targets WHERE user_id=? ORDER BY created_at_ms,target_id").all(who);
const settingsCommand=(fx,who,extra={})=>{
  const row=settingsRow(fx,who);
  return {commandId:randomUUID(),timeZone:"Europe/Prague",attentionPush:true,
    quietStart:"21:30",quietEnd:"07:15",dailyLimit:5,paused:false,
    expectedSettingsRevision:row.revision,expectedNotificationEpoch:epoch(fx,who),
    restoreGeneration:fx.stage.restoreGeneration,...extra};
};
const registerCommand=(fx,who,endpoint,extra={})=>({commandId:randomUUID(),action:"register",
  endpointHash:sha(endpoint),expectedNotificationEpoch:epoch(fx,who),
  restoreGeneration:fx.stage.restoreGeneration,...extra});
const revokeCommand=(fx,who,targetId,extra={})=>({commandId:randomUUID(),action:"revoke",
  targetId,expectedNotificationEpoch:epoch(fx,who),
  restoreGeneration:fx.stage.restoreGeneration,...extra});
const preflight=fx=>inspectIsolatedTargetStore({
  stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
  mode:"r2-model",
});
const journalRecords=fx=>readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8")
  .split("\n").filter(Boolean).map(JSON.parse).filter(r=>r.t==="intent"&&r.k==="personal_notification");
const settings=(fx,token,c,hash)=>fx.authority.changeNotificationSettings(token,c,hash);
const target=(fx,token,c,hash)=>fx.authority.changePushTarget(token,c,hash);

test("strict settings command: exact keys, zone, window, limit, types",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const c=settingsCommand(fx,"alice");
  assert.equal(validTargetStagingNotificationSettingsCommand(c),true);
  for(const bad of [{timeZone:"Mars/Olympus"},{timeZone:""},{attentionPush:1},{paused:"no"},
    {quietStart:"24:00"},{quietEnd:"7:00"},{dailyLimit:11},{dailyLimit:-1},{dailyLimit:1.5},
    {expectedSettingsRevision:-1},{expectedNotificationEpoch:"0"},{commandId:"x"},
    {restoreGeneration:"x"}])
    assert.equal(validTargetStagingNotificationSettingsCommand({...c,...bad}),false,JSON.stringify(bad));
  for(const extra of [{actorUserId:"alice"},{userId:"bob"}])
    assert.equal(validTargetStagingNotificationSettingsCommand({...c,...extra}),false);
  assert.deepEqual(settings(fx,token,{...c,timeZone:"Mars/Olympus"}),denied("invalid_request"));
  assert.deepEqual(settings(fx,token,{...c,actorUserId:"bob"}),denied("invalid_request"));
  assert.equal(settingsRow(fx,"alice").revision,0);
  assert.equal(receipts(fx,SETTINGS_PREFIX).length,0);
});

test("settings: only the actor's row changes, CAS, replay, conflict, unchanged",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const bobBefore=JSON.stringify([settingsRow(fx,"bob"),epoch(fx,"bob")]);
  const c=settingsCommand(fx,"alice");
  assert.deepEqual(settings(fx,token,c),{ok:true});
  assert.deepEqual(settingsRow(fx,"alice"),{time_zone:"Europe/Prague",attention_push:1,
    quiet_start:"21:30",quiet_end:"07:15",daily_limit:5,paused:0,revision:1});
  assert.equal(epoch(fx,"alice"),1);
  assert.equal(JSON.stringify([settingsRow(fx,"bob"),epoch(fx,"bob")]),bobBefore);
  // replay with the original (now stale) expectations answers from the receipt
  assert.deepEqual(settings(fx,token,c),{ok:true,replayed:true});
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(settings(fx,token,{...c,dailyLimit:6}),denied("idempotency_conflict"));
  assert.equal(settingsRow(fx,"alice").daily_limit,5);
  // identical values are unchanged and write nothing
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice")),denied("unchanged"));
  assert.equal(epoch(fx,"alice"),1);assert.equal(receipts(fx,SETTINGS_PREFIX).length,1);
  // stale CAS
  const stale=settingsCommand(fx,"alice",{dailyLimit:2});
  assert.deepEqual(settings(fx,token,{...stale,expectedSettingsRevision:0}),denied("stale_revision"));
  assert.deepEqual(settings(fx,token,{...stale,expectedNotificationEpoch:9}),denied("stale_revision"));
  assert.deepEqual(settings(fx,token,{...stale,restoreGeneration:randomUUID()}),denied("resync_required"));
  assert.equal(settingsRow(fx,"alice").daily_limit,5);
  assert.deepEqual(settings(fx,token,stale),{ok:true});
  assert.equal(settingsRow(fx,"alice").revision,2);assert.equal(epoch(fx,"alice"),2);
  // read credential / garbage token cannot write
  const reader=fx.authority.issue("alice").sessionToken;
  assert.deepEqual(settings(fx,reader,settingsCommand(fx,"alice",{dailyLimit:9})),denied("unauthorized"));
  assert.deepEqual(settings(fx,"garbage",settingsCommand(fx,"alice",{dailyLimit:9})),denied("unauthorized"));
  assert.equal(settingsRow(fx,"alice").daily_limit,2);
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
});

test("settings journal is content-free and receipts are hashes",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice")),{ok:true});
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice",{paused:true})),{ok:true});
  const records=journalRecords(fx);
  assert.equal(records.length,2);
  for(const r of records){
    assert.deepEqual(Object.keys(r.p).sort(),["epoch","op","receiptHash"]);
    assert.equal(r.p.op,0);assert.match(r.p.receiptHash,/^[a-f0-9]{64}$/);
  }
  assert.deepEqual(records.map(r=>r.p.epoch),[1,2]);
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  for(const secret of ["alice","Europe/Prague","21:30","07:15"])
    assert.equal(journal.includes(secret),false,secret);
  for(const row of receipts(fx,SETTINGS_PREFIX)){
    assert.match(row.key.slice(SETTINGS_PREFIX.length),/^[a-f0-9]{64}$/);
    assert.match(row.value,/^[a-f0-9]{64}$/);
  }
});

test("disabling push forgets the baseline marker; enabling stores nothing else",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice")),{ok:true});
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM personal_attention_deliveries").get().n,0);
  fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run(targetPushBaselineKey("alice"),targetPushBaselineValue("alice"));
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice",{paused:true})),{ok:true});
  assert.equal(receipts(fx,BASELINE_PREFIX).length,1,"pausing keeps the baseline");
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice",{attentionPush:false})),{ok:true});
  assert.equal(receipts(fx,BASELINE_PREFIX).length,0);
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
  // a baseline marker for an unknown identity or with a wrong value is rejected
  fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run(BASELINE_PREFIX+sha("nobody"),targetPushBaselineValue("nobody"));
  assert.equal(preflight(fx).ok,false);
});

test("durable session revoked: nothing written (settings and targets)",()=>{
  const fx=fixture(),writer=fx.authority.issueWritable("bob").sessionToken;
  const issued=durable.issueDurableTargetStagingSession(fx.store,"bob",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  assert.deepEqual(settings(fx,writer,settingsCommand(fx,"bob"),hash),{ok:true});
  const reg=target(fx,writer,registerCommand(fx,"bob","https://push.example/bob-1"),hash);
  assert.equal(reg.ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  const e=epoch(fx,"bob");
  assert.deepEqual(settings(fx,writer,settingsCommand(fx,"bob",{dailyLimit:1}),hash),denied("session_revoked"));
  assert.deepEqual(target(fx,writer,registerCommand(fx,"bob","https://push.example/bob-2"),hash),denied("session_revoked"));
  assert.deepEqual(target(fx,writer,revokeCommand(fx,"bob",reg.targetId),hash),denied("session_revoked"));
  assert.equal(epoch(fx,"bob"),e);assert.equal(settingsRow(fx,"bob").daily_limit,5);
  assert.equal(targets(fx,"bob").length,1);assert.equal(targets(fx,"bob")[0].revoked_at_ms,null);
  assert.equal(receipts(fx,SETTINGS_PREFIX).length,1);assert.equal(receipts(fx,TARGET_PREFIX).length,1);
});

test("settings rollback: a failure after the update leaves no change",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  // Receipt row for this exact command with a bad shape is not possible; instead force the
  // late failure with a poisoned receipt-cap: fill the namespace to the cap.
  const insert=fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  fx.db.exec("BEGIN");
  for(let i=0;i<4096;i++)insert.run(SETTINGS_PREFIX+sha("fill"+i),sha("v"+i));
  fx.db.exec("COMMIT");
  const before=JSON.stringify([settingsRow(fx,"alice"),epoch(fx,"alice")]);
  assert.deepEqual(settings(fx,token,settingsCommand(fx,"alice")),denied("write_failed"));
  assert.equal(JSON.stringify([settingsRow(fx,"alice"),epoch(fx,"alice")]),before);
});

test("register: server-generated opaque ID, hash only, replay, unchanged, own CAS",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const endpoint="https://push.example/very-secret-endpoint-alice";
  const c=registerCommand(fx,"alice",endpoint);
  assert.equal(validTargetStagingPushTargetCommand(c),true);
  for(const bad of [{endpointHash:endpoint},{endpointHash:"ab"},{endpointHash:sha(endpoint).toUpperCase()},
    {action:"remove"},{expectedNotificationEpoch:-1},{commandId:"x"},{restoreGeneration:"x"}])
    assert.equal(validTargetStagingPushTargetCommand({...c,...bad}),false,JSON.stringify(bad));
  for(const extra of [{userId:"bob"},{targetId:"pt_"+"a".repeat(32)},{endpoint}])
    assert.equal(validTargetStagingPushTargetCommand({...c,...extra}),false);
  assert.deepEqual(target(fx,token,{...c,endpoint}),denied("invalid_request"));
  const res=target(fx,token,c);
  assert.equal(res.ok,true);assert.match(res.targetId,/^pt_[0-9a-f]{32}$/);
  assert.deepEqual(targets(fx,"alice").map(t=>[t.target_id,t.endpoint_hash,t.revoked_at_ms]),
    [[res.targetId,sha(endpoint),null]]);
  assert.equal(epoch(fx,"alice"),1);
  // the raw endpoint is nowhere in the database or journal
  assert.equal(readFileSync(fx.stage.databasePath).includes(Buffer.from("very-secret-endpoint")),false);
  assert.equal(readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8").includes("secret"),false);
  assert.deepEqual(target(fx,token,c),{ok:true,replayed:true,targetId:res.targetId});
  assert.deepEqual(target(fx,token,{...c,endpointHash:sha("other")}),denied("idempotency_conflict"));
  assert.deepEqual(target(fx,token,registerCommand(fx,"alice",endpoint)),
    {ok:false,reason:"unchanged",targetId:res.targetId});
  assert.equal(epoch(fx,"alice"),1);assert.equal(targets(fx,"alice").length,1);
  assert.deepEqual(target(fx,token,registerCommand(fx,"alice","https://push.example/b",
    {expectedNotificationEpoch:7})),denied("stale_revision"));
  assert.deepEqual(target(fx,token,registerCommand(fx,"alice","https://push.example/b",
    {restoreGeneration:randomUUID()})),denied("resync_required"));
  assert.equal(targets(fx,"alice").length,1);
  const view=fx.authority.readNotificationSettings("alice");
  assert.deepEqual(view.targetIds,[res.targetId]);
  assert.equal(view.notificationEpoch,1);assert.equal(view.attentionPush,false);
  assert.equal(JSON.stringify(view).includes(sha(endpoint)),false);
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
});

test("endpoint of another user is unavailable and nothing is written or transferred",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const endpoint="https://push.example/shared-device";
  const mine=target(fx,alice,registerCommand(fx,"alice",endpoint));
  assert.equal(mine.ok,true);
  const e=epoch(fx,"bob"),r=receipts(fx,TARGET_PREFIX).length;
  assert.deepEqual(target(fx,bob,registerCommand(fx,"bob",endpoint)),denied("unavailable"));
  assert.equal(epoch(fx,"bob"),e);assert.equal(receipts(fx,TARGET_PREFIX).length,r);
  assert.equal(targets(fx,"bob").length,0);
  assert.equal(targets(fx,"alice")[0].target_id,mine.targetId);
  // even after alice revoked it, bob never inherits it
  assert.equal(target(fx,alice,revokeCommand(fx,"alice",mine.targetId)).ok,true);
  assert.deepEqual(target(fx,bob,registerCommand(fx,"bob",endpoint)),denied("unavailable"));
  assert.equal(targets(fx,"bob").length,0);
  // alice cannot re-register her own revoked endpoint either (schema: one row per endpoint)
  assert.deepEqual(target(fx,alice,registerCommand(fx,"alice",endpoint)),denied("unavailable"));
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
});

test("revoke: only own live target; replay; CAS; other users' targets untouched",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const a=target(fx,alice,registerCommand(fx,"alice","https://push.example/a"));
  const b=target(fx,bob,registerCommand(fx,"bob","https://push.example/b"));
  assert.deepEqual(target(fx,bob,revokeCommand(fx,"bob",a.targetId)),denied("unavailable"),"foreign target");
  assert.deepEqual(target(fx,alice,revokeCommand(fx,"alice","pt_"+"0".repeat(32))),denied("unavailable"));
  assert.deepEqual(target(fx,alice,revokeCommand(fx,"alice",a.targetId,{expectedNotificationEpoch:5})),denied("stale_revision"));
  assert.equal(targets(fx,"alice")[0].revoked_at_ms,null);
  const c=revokeCommand(fx,"alice",a.targetId);
  assert.deepEqual(target(fx,alice,c),{ok:true,targetId:a.targetId});
  assert.equal(typeof targets(fx,"alice")[0].revoked_at_ms,"number");
  assert.equal(epoch(fx,"alice"),2);
  assert.deepEqual(target(fx,alice,c),{ok:true,replayed:true,targetId:a.targetId});
  assert.deepEqual(target(fx,alice,revokeCommand(fx,"alice",a.targetId)),denied("unavailable"),"already revoked");
  assert.equal(targets(fx,"bob")[0].revoked_at_ms,null);assert.equal(targets(fx,"bob")[0].target_id,b.targetId);
  assert.deepEqual(fx.authority.readNotificationSettings("alice").targetIds,[]);
  const records=journalRecords(fx);
  assert.deepEqual(records.map(r=>r.p.op),[1,1,2]);
  for(const r of records)assert.deepEqual(Object.keys(r.p).sort(),["epoch","op","receiptHash"]);
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  for(const secret of [a.targetId,b.targetId,"alice","bob",sha("https://push.example/a")])
    assert.equal(journal.includes(secret),false);
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
});

test("per-user capacity fails closed without a partial write",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  for(let i=0;i<64;i++)
    assert.equal(target(fx,token,registerCommand(fx,"alice","https://push.example/cap"+i)).ok,true,String(i));
  const e=epoch(fx,"alice"),n=receipts(fx,TARGET_PREFIX).length;
  assert.deepEqual(target(fx,token,registerCommand(fx,"alice","https://push.example/over")),denied("write_failed"));
  assert.equal(epoch(fx,"alice"),e);assert.equal(receipts(fx,TARGET_PREFIX).length,n);
  assert.equal(targets(fx,"alice").length,64);
});

test("preflight detects malformed notification receipts and markers",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  assert.equal(target(fx,token,registerCommand(fx,"alice","https://push.example/x")).ok,true);
  assert.equal(preflight(fx).ok,true);
  fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(TARGET_PREFIX+"zz","bad");
  const res=preflight(fx);
  assert.equal(res.ok,false);assert.ok(res.issues.length>0);
  assert.equal(JSON.stringify(res).includes("alice"),false);
});
