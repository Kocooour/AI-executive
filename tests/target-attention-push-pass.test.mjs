import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5d2-push-pass-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const oldData=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STAGING_PUSH_BASELINE_PREFIX:BASELINE_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {targetAttentionDeliveryKey}=await import("../lib/target-attention-push-planner.ts");
const {runTargetAttentionPushPass}=await import("../lib/target-attention-push-pass.ts");
const {createHash}=await import("node:crypto");
const all=[];
const HOUR=3_600_000,DAY=24*HOUR;
// Q = 2026-11-05 21:00 UTC = 22:00 in Europe/Prague (quiet 22:00-08:00) but not in UTC.
// NOW is 12:00 UTC: not quiet anywhere used here.
const Q=Date.UTC(2026,10,5,21,0,0);
const NOW=Date.UTC(2026,10,5,12,0,0);
const sha=text=>createHash("sha256").update(text).digest("hex");
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const actor of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(actor+"-ws",actor);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(actor+"-area",actor,actor+"-ws",actor);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  const fx={stage,db,authority,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  },area:{alice:stage.unassignedAreaId,bob:"bob-area",carol:"carol-area"},
  tokens:{}};all.push(fx);return fx;
}
after(()=>{
  for(const fx of all){fx.authority.close();fx.db.close();}
  if(oldData===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=legacy;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const token=(fx,who)=>fx.tokens[who]??=fx.authority.issueWritable(who).sessionToken;
const settingsOf=(fx,who)=>fx.db.prepare(
  "SELECT revision FROM personal_notification_settings WHERE user_id=?").get(who).revision;
const epochOf=(fx,who)=>fx.db.prepare(
  "SELECT revision FROM personal_notification_epochs WHERE user_id=?").get(who).revision;
function configure(fx,who,patch={}){
  const cur=fx.db.prepare("SELECT time_zone,attention_push,quiet_start,quiet_end,daily_limit,paused FROM personal_notification_settings WHERE user_id=?").get(who);
  const res=fx.authority.changeNotificationSettings(token(fx,who),{
    commandId:randomUUID(),timeZone:cur.time_zone,attentionPush:cur.attention_push===1,
    quietStart:cur.quiet_start,quietEnd:cur.quiet_end,dailyLimit:cur.daily_limit,
    paused:cur.paused===1,...patch,expectedSettingsRevision:settingsOf(fx,who),
    expectedNotificationEpoch:epochOf(fx,who),restoreGeneration:fx.stage.restoreGeneration,
  });
  assert.equal(res.ok,true,JSON.stringify(res));
}
const enable=(fx,who,patch={})=>configure(fx,who,{attentionPush:true,...patch});
function register(fx,who,name){
  const res=fx.authority.changePushTarget(token(fx,who),{commandId:randomUUID(),
    action:"register",endpointHash:sha(who+":"+name),
    expectedNotificationEpoch:epochOf(fx,who),restoreGeneration:fx.stage.restoreGeneration});
  assert.equal(res.ok,true,JSON.stringify(res));
  return res.targetId;
}
let seq=0;
function task(fx,who,title,due="2026-11-01",extra={}){
  const id=extra.id??"t"+(++seq);
  fx.db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)")
    .run(id,extra.area??fx.area[who],null,title,extra.assignee??null,due);
  return id;
}
const rows=(fx,who)=>fx.db.prepare(
  "SELECT task_id,status,attempts,sent_at_ms FROM personal_attention_deliveries WHERE user_id=? ORDER BY task_id").all(who).map(r=>({...r}));
const devices=(fx,who)=>fx.db.prepare(
  "SELECT target_id,status,attempts FROM personal_attention_device_deliveries WHERE user_id=? ORDER BY target_id").all(who).map(r=>({...r}));
const preflight=fx=>inspectIsolatedTargetStore({
  stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
  mode:"r2-model",
});
function sender(behave=()=> "sent"){
  const calls=[];
  return {calls,async sendTo(userId,targetId,payload){
    calls.push({userId,targetId,payload});
    return behave(userId,targetId,payload,calls.length);
  }};
}
const run=(fx,s,nowMs=NOW,clock)=>fx.authority.runAttentionPushPass(nowMs,s,clock);
const ownerOfTarget=(fx,id)=>fx.db.prepare(
  "SELECT user_id FROM personal_push_targets WHERE target_id=?").get(id)?.user_id;
const ok=fx=>assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});

test("first enable baselines (no send); a later item is sent once per live device; dedup",async()=>{
  const fx=fixture();
  const old=task(fx,"alice","Old overdue");
  const d1=register(fx,"alice","d1"),d2=register(fx,"alice","d2");
  const s=sender();
  assert.deepEqual(await run(fx,s),{users:0,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:3}},"push is off by default");
  enable(fx,"alice");
  assert.deepEqual(await run(fx,s),{users:1,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:2}});
  assert.equal(s.calls.length,0);
  assert.deepEqual(rows(fx,"alice").map(r=>[r.task_id,r.status,r.attempts]),[[old,"baseline",0]]);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?").get(BASELINE_PREFIX+"%").n,1);
  assert.deepEqual(await run(fx,s),{users:1,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:2}});
  assert.equal(s.calls.length,0,"baselined item is never announced");
  const fresh=task(fx,"alice","Fresh overdue","2026-11-02");
  const summary=await run(fx,s);
  assert.deepEqual(summary,{users:1,sent:1,held:{quiet_hours:0,daily_limit:0,disabled:2}});
  assert.deepEqual(s.calls.map(c=>c.targetId).sort(),[d1,d2].sort());
  for(const c of s.calls){
    assert.equal(c.userId,"alice");assert.equal(ownerOfTarget(fx,c.targetId),"alice");
    assert.deepEqual(Object.keys(c.payload).sort(),["body","tag","title","url"]);
    assert.equal(c.payload.title,"Fresh overdue");assert.equal(c.payload.url,"/?task="+fresh);
  }
  const final=rows(fx,"alice").find(r=>r.task_id===fresh);
  assert.equal(final.status,"sent");assert.ok(final.sent_at_ms>=NOW&&final.sent_at_ms<NOW+60_000);
  assert.deepEqual(devices(fx,"alice").map(d=>d.status),["sent","sent"]);
  await run(fx,s);await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.length,2,"dedup: nothing is sent again");
  ok(fx);
  // journal stays content-free
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  for(const secret of ["Fresh overdue",fresh,d1,d2,"alice"])assert.equal(journal.includes(secret),false,secret);
  const kinds=journal.split("\n").filter(Boolean).map(JSON.parse).filter(r=>r.k==="personal_notification"&&r.p.op>=3);
  assert.ok(kinds.length>0);
  for(const r of kinds)assert.deepEqual(Object.keys(r.p).sort(),["epoch","n","op"]);
});

test("quiet hours use each user's stored zone at the same instant",async()=>{
  const fx=fixture();
  task(fx,"alice","A old");task(fx,"bob","B old");
  register(fx,"alice","d");register(fx,"bob","d");
  enable(fx,"alice");enable(fx,"bob",{timeZone:"Europe/Prague"});
  const s=sender();
  await run(fx,s,Q);assert.equal(s.calls.length,0);
  task(fx,"alice","A new","2026-11-02");const bn=task(fx,"bob","B new","2026-11-02");
  const summary=await run(fx,s,Q);
  assert.deepEqual(s.calls.map(c=>c.userId),["alice"]);
  assert.equal(summary.sent,1);assert.equal(summary.held.quiet_hours,1);
  assert.equal(rows(fx,"bob").find(r=>r.task_id===bn),undefined,"quiet user: nothing claimed");
  // still quiet at 23:00Z (00:00 Prague); allowed from 07:30Z (08:30 Prague)
  await run(fx,s,Q+2*HOUR);assert.equal(s.calls.length,1);
  const later=await run(fx,s,Date.UTC(2026,10,6,7,30));
  assert.deepEqual(s.calls.map(c=>c.userId),["alice","bob"]);
  assert.equal(later.sent,1);
  ok(fx);
});

test("daily limit 3 over a rolling 24 hours",async()=>{
  const fx=fixture();
  task(fx,"alice","old");register(fx,"alice","d");enable(fx,"alice");
  const s=sender();await run(fx,s);
  for(let i=0;i<5;i++)task(fx,"alice","new "+i,"2026-11-02");
  const first=await run(fx,s);
  assert.equal(first.sent,3);assert.equal(first.held.daily_limit,1);
  assert.equal(s.calls.length,3);
  const again=await run(fx,s,NOW+HOUR);
  assert.equal(again.sent,0);assert.equal(again.held.daily_limit,1);assert.equal(s.calls.length,3);
  const next=await run(fx,s,NOW+DAY+HOUR);
  assert.equal(next.sent,2);assert.equal(s.calls.length,5);
  assert.deepEqual(new Set(s.calls.map(c=>c.payload.title)).size,5);
  ok(fx);
});

test("dismissed and snoozed items are never sent",async()=>{
  const fx=fixture();
  task(fx,"alice","old");register(fx,"alice","d");enable(fx,"alice");
  const s=sender();await run(fx,s);
  const dismissed=task(fx,"alice","dismissed","2026-11-02");
  const snoozed=task(fx,"alice","snoozed","2026-11-02");
  const live=task(fx,"alice","live","2026-11-02");
  fx.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('alice',?,'deadline_overdue','2026-11-02','dismissed')").run(dismissed);
  fx.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES ('alice',?,'deadline_overdue','2026-11-02','snoozed',?)").run(snoozed,NOW+DAY);
  await run(fx,s);
  assert.deepEqual(s.calls.map(c=>c.payload.title),["live"]);
  assert.equal(rows(fx,"alice").some(r=>r.task_id===dismissed||r.task_id===snoozed),false);
  void live;ok(fx);
});

test("partial delivery retries only the failed device, never in quiet hours; attempts are capped",async()=>{
  const fx=fixture();
  task(fx,"alice","old");
  const d1=register(fx,"alice","d1"),d2=register(fx,"alice","d2");
  enable(fx,"alice",{timeZone:"Europe/Prague"});
  const before=Q-HOUR; // 21:00 Prague, not quiet
  const s=sender((u,t)=>t===d2?"failed":"sent");
  await run(fx,s,before);
  const id=task(fx,"alice","partial item","2026-11-02");
  await run(fx,s,before);
  const [first,second]=[d1,d2].sort();
  assert.equal(s.calls.length,2);
  let row=rows(fx,"alice").find(r=>r.task_id===id);
  assert.equal(row.status,"partial");assert.ok(row.sent_at_ms);
  assert.deepEqual(devices(fx,"alice").map(d=>[d.target_id,d.status,d.attempts]).sort(),
    [[d1,"sent",1],[d2,"failed",1]].sort());
  // quiet hours (22:00 Prague): no retry
  await run(fx,s,Q);assert.equal(s.calls.length,2);
  void first;void second;
  // morning: only the failed device is retried (fails again, attempt 2)
  const morning=Date.UTC(2026,10,6,7,30);
  await run(fx,s,morning);
  assert.deepEqual(s.calls.slice(2).map(c=>c.targetId),[d2]);
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"partial");
  await run(fx,s,morning+HOUR);
  assert.deepEqual(s.calls.slice(3).map(c=>c.targetId),[d2],"third and last attempt");
  row=rows(fx,"alice").find(r=>r.task_id===id);
  assert.equal(row.status,"sent","no retryable device left");
  await run(fx,s,morning+2*HOUR);assert.equal(s.calls.length,4);
  assert.equal(devices(fx,"alice").find(d=>d.target_id===d2).attempts,3);
  ok(fx);
});

test("a recovering device completes a partial delivery without re-notifying the other",async()=>{
  const fx=fixture();
  task(fx,"alice","old");
  const d1=register(fx,"alice","d1"),d2=register(fx,"alice","d2");
  enable(fx,"alice");
  let failD2=true;
  const s=sender((u,t)=>t===d2&&failD2?"failed":"sent");
  await run(fx,s);const id=task(fx,"alice","item","2026-11-02");
  await run(fx,s);
  failD2=false;await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.filter(c=>c.targetId===d1).length,1);
  assert.equal(s.calls.filter(c=>c.targetId===d2).length,2);
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"sent");
  ok(fx);
});

test("every device failing: failed with attempts, retried until the cap, then given up",async()=>{
  const fx=fixture();
  task(fx,"alice","old");const d1=register(fx,"alice","d1");enable(fx,"alice");
  const s=sender(()=>"failed");
  await run(fx,s);const id=task(fx,"alice","dead","2026-11-02");
  for(let i=0;i<5;i++)await run(fx,s,NOW+i*HOUR);
  assert.equal(s.calls.length,3,"3 attempts, then no more");
  const row=rows(fx,"alice").find(r=>r.task_id===id);
  assert.equal(row.status,"failed");assert.equal(row.sent_at_ms,null);
  assert.equal(row.attempts,3);
  void d1;ok(fx);
});

test("a gone target is revoked and never used again",async()=>{
  const fx=fixture();
  task(fx,"alice","old");
  const d1=register(fx,"alice","d1"),d2=register(fx,"alice","d2");enable(fx,"alice");
  const s=sender((u,t)=>t===d1?"gone":"sent");
  await run(fx,s);const id=task(fx,"alice","item","2026-11-02");
  const before=epochOf(fx,"alice");
  await run(fx,s);
  const t=fx.db.prepare("SELECT target_id,revoked_at_ms FROM personal_push_targets WHERE user_id='alice'").all();
  assert.equal(typeof t.find(x=>x.target_id===d1).revoked_at_ms,"number");
  assert.equal(t.find(x=>x.target_id===d2).revoked_at_ms,null);
  assert.ok(epochOf(fx,"alice")>before);
  assert.deepEqual(devices(fx,"alice").map(d=>[d.target_id,d.status]).sort(),
    [[d1,"gone"],[d2,"sent"]].sort());
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"sent");
  task(fx,"alice","second","2026-11-02");
  await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.filter(c=>c.targetId===d1).length,1);
  assert.equal(s.calls.filter(c=>c.targetId===d2).length,2);
  assert.deepEqual(fx.authority.readNotificationSettings("alice").targetIds,[d2]);
  ok(fx);
});

test("no live device: undelivered, and a device subscribing later gets no backlog",async()=>{
  const fx=fixture();
  task(fx,"alice","old");enable(fx,"alice");
  const s=sender();await run(fx,s);
  const id=task(fx,"alice","nobody listens","2026-11-02");
  await run(fx,s);
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"undelivered");
  register(fx,"alice","late");
  await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.length,0);
  ok(fx);
});

test("ACL: only the assigned editor/admin (and private owner) is notified; viewer, unassigned, other assignee never",async()=>{
  const fx=fixture();
  for(const who of ["alice","bob","carol"]){register(fx,who,"d");enable(fx,who);}
  task(fx,"alice","seed");await run(fx,sender());
  const forBob=task(fx,"alice","Family for Bob","2026-11-02",{area:"family-area",assignee:"bob"});
  task(fx,"alice","Family unassigned","2026-11-02",{area:"family-area"});
  task(fx,"alice","Alice private","2026-11-02");
  task(fx,"bob","Bob private","2026-11-02");
  task(fx,"carol","Carol private","2026-11-02");
  const s=sender();
  await run(fx,s);
  const by=Object.fromEntries(["alice","bob","carol"].map(u=>[u,s.calls.filter(c=>c.userId===u).map(c=>c.payload.title).sort()]));
  assert.deepEqual(by,{alice:["Alice private"],bob:["Bob private","Family for Bob"],carol:["Carol private"]});
  for(const c of s.calls){
    assert.equal(ownerOfTarget(fx,c.targetId),c.userId,"target belongs to the recipient");
    for(const other of ["alice","bob","carol"].filter(x=>x!==c.userId))
      assert.equal(JSON.stringify(c.payload).includes(other[0].toUpperCase()+other.slice(1)+" private"),false);
  }
  assert.equal(rows(fx,"carol").some(r=>r.task_id===forBob),false,"viewer has no delivery");
  assert.equal(rows(fx,"alice").some(r=>r.task_id===forBob),false,"admin who is not assignee has none");
  ok(fx);
});

test("member removed between claim and send gets no push to the next device",async()=>{
  const fx=fixture();
  task(fx,"alice","seed");
  const b1=register(fx,"bob","d1"),b2=register(fx,"bob","d2");enable(fx,"bob");
  await run(fx,sender());
  const shared=task(fx,"alice","Shared for Bob","2026-11-02",{area:"family-area",assignee:"bob"});
  let first=null;
  const s=sender((u,t)=>{
    if(first===null){
      first=t;
      // Access lost after the claim and after the first device was reached.
      fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id=?").run(shared);
    }
    return "sent";
  });
  await run(fx,s);
  assert.equal(s.calls.length,1,"second device is not notified");
  assert.deepEqual([b1,b2].includes(first),true);
  assert.equal(rows(fx,"bob").some(r=>r.task_id===shared),false,"reconcile removed the row");
  await run(fx,s,NOW+HOUR);assert.equal(s.calls.length,1);
  ok(fx);
});

test("membership downgrade, task completion and a new deadline between claim and send stop the push",async()=>{
  for(const [name,mutate] of [
    ["reassigned to another member",(fx,id)=>fx.db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id=?").run(id)],
    ["unassigned, then downgraded",(fx,id)=>{
      fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id=?").run(id);
      fx.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
    }],
    ["unassigned, then removed",(fx,id)=>{
      fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id=?").run(id);
      fx.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
    }],
    ["completed",(fx,id)=>fx.db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id=?").run(id)],
    ["new deadline",(fx,id)=>fx.db.prepare("UPDATE tasks SET due_on='2026-12-31' WHERE id=?").run(id)],
  ]){
    const fx=fixture();
    task(fx,"alice","seed");
    register(fx,"bob","d1");register(fx,"bob","d2");enable(fx,"bob");
    await run(fx,sender());
    const id=task(fx,"alice","Shared","2026-11-02",{area:"family-area",assignee:"bob"});
    let n=0;
    const s=sender(()=>{if(++n===1)mutate(fx,id);return "sent";});
    await run(fx,s);
    assert.equal(s.calls.length,1,name);
    assert.equal(rows(fx,"bob").some(r=>r.task_id===id),false,name);
    ok(fx);
  }
});

test("access lost while a previous user's pass runs: nothing for the affected member",async()=>{
  const fx=fixture();
  task(fx,"alice","seed");
  register(fx,"alice","d");register(fx,"bob","d");enable(fx,"alice");enable(fx,"bob");
  await run(fx,sender());
  task(fx,"alice","Alice item","2026-11-02");
  task(fx,"alice","Bob shared","2026-11-02",{area:"family-area",assignee:"bob"});
  const s=sender(u=>{
    if(u==="alice"){
      fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE title='Bob shared'").run();
      fx.db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='family-area' AND user_id='bob'").run();
    }
    return "sent";
  });
  await run(fx,s);
  assert.deepEqual(s.calls.map(c=>c.userId),["alice"]);
  ok(fx);
});

test("paused and off identities are skipped; their targets are never used",async()=>{
  const fx=fixture();
  for(const who of ["alice","bob","carol"]){task(fx,who,"old");register(fx,who,"d");}
  enable(fx,"alice");enable(fx,"bob");enable(fx,"carol");
  await run(fx,sender());
  for(const who of ["alice","bob","carol"])task(fx,who,who+" new","2026-11-02");
  configure(fx,"bob",{paused:true});configure(fx,"carol",{attentionPush:false});
  const s=sender();
  const summary=await run(fx,s);
  assert.deepEqual(s.calls.map(c=>c.userId),["alice"]);
  assert.equal(summary.users,1);assert.equal(summary.held.disabled,2);
  // unpausing keeps the baseline: only what happened while paused is "new" and announced
  configure(fx,"bob",{paused:false});
  await run(fx,s);
  assert.deepEqual(s.calls.map(c=>c.userId).sort(),["alice","bob"]);
  // switching push off and on again starts a fresh baseline (no backlog)
  await run(fx,s);
  configure(fx,"carol",{attentionPush:true});
  await run(fx,s);
  assert.equal(s.calls.some(c=>c.userId==="carol"),false);
  ok(fx);
});

test("restart safety: stale pending becomes undelivered and is not resent; a fresh pending stays in flight",async()=>{
  const fx=fixture();
  task(fx,"alice","seed");register(fx,"alice","d");enable(fx,"alice");
  await run(fx,sender());
  const stale=task(fx,"alice","stale","2026-11-02");
  const fresh=task(fx,"alice","fresh","2026-11-02");
  const put=(id,at)=>fx.db.prepare(`INSERT INTO personal_attention_deliveries
    (user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms)
    VALUES ('alice',?,?,'deadline_overdue','2026-11-02','pending',1,?)`)
    .run(targetAttentionDeliveryKey("deadline_overdue",id,"2026-11-02"),id,at);
  put(stale,NOW-16*60_000);put(fresh,NOW-5*60_000);
  const s=sender();
  await run(fx,s);
  assert.equal(s.calls.length,0);
  assert.equal(rows(fx,"alice").find(r=>r.task_id===stale).status,"undelivered");
  assert.equal(rows(fx,"alice").find(r=>r.task_id===fresh).status,"pending");
  await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.length,0,"never resent after an interrupted pass");
  assert.equal(rows(fx,"alice").find(r=>r.task_id===fresh).status,"undelivered");
  ok(fx);
});

test("another pass is refused while one runs (single flight)",async()=>{
  const fx=fixture();
  task(fx,"alice","seed");register(fx,"alice","d");enable(fx,"alice");
  await run(fx,sender());
  task(fx,"alice","slow","2026-11-02");
  let release;const gate=new Promise(r=>{release=r;});
  const slow=sender(async()=>{await gate;return "sent";});
  const first=run(fx,slow);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(slow.calls.length,1);
  const second=await run(fx,sender());
  assert.deepEqual(second,{users:0,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:0},busy:true});
  release();
  const done=await first;
  assert.equal(done.sent,1);
  assert.equal((await run(fx,sender())).busy,undefined,"flag released afterwards");
  ok(fx);
});

test("a throwing sender counts as failed and never aborts other identities",async()=>{
  const fx=fixture();
  for(const who of ["alice","bob"]){task(fx,who,"old");register(fx,who,"d");enable(fx,who);}
  await run(fx,sender());
  task(fx,"alice","A","2026-11-02");task(fx,"bob","B","2026-11-02");
  const s=sender(u=>{if(u==="alice")throw new Error("boom");return "sent";});
  const summary=await run(fx,s);
  assert.equal(summary.sent,1);
  assert.equal(rows(fx,"alice").find(r=>r.task_id!==undefined&&r.status==="failed")!==undefined,true);
  assert.equal(rows(fx,"bob").some(r=>r.status==="sent"),true);
  ok(fx);
});

test("invalid input or direct call without an authority-bound credential sends nothing",async()=>{
  const fx=fixture();
  task(fx,"alice","seed");register(fx,"alice","d");enable(fx,"alice");
  const s=sender();
  assert.equal((await run(fx,s,0)).users,0);
  assert.equal((await run(fx,s,1.5)).users,0);
  const direct=await runTargetAttentionPushPass(fx.store,{nowMs:NOW,sender:s,credentialFor:()=>null});
  assert.equal(direct.sent,0);assert.equal(s.calls.length,0);
  assert.equal(rows(fx,"alice").length,0,"no credential: nothing read or written");
  fx.authority.close();
  assert.deepEqual(await run(fx,s),{users:0,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:0}});
});

test("review fixes: dismiss/snooze during a send stops further devices",async()=>{
  for(const mode of ["dismissed","snoozed"]){
    const fx=fixture();
    register(fx,"alice","d1");register(fx,"alice","d2");
    enable(fx,"alice");await run(fx,sender());
    const id=task(fx,"alice","Hide me","2026-11-02");
    const s=sender((userId,targetId,payload,n)=>{
      if(n===1)fx.db.prepare(`INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms)
        VALUES ('alice',?,'deadline_overdue','2026-11-02',?,?)`).run(id,mode,mode==="snoozed"?NOW+DAY:null);
      return "sent";
    });
    await run(fx,s);
    assert.equal(s.calls.length,1,mode+": second device must not be reached");
    ok(fx);
  }
});

test("review fixes: a hung sender times out instead of wedging the pass",async(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fx=fixture();
  register(fx,"alice","d1");enable(fx,"alice");await run(fx,sender());
  task(fx,"alice","Hang","2026-11-02");
  const hung={calls:0,sendTo(){this.calls++;return new Promise(()=>{});}};
  const pending=run(fx,hung);
  // let the pass reach the send, then fire the timeout
  for(let i=0;i<50&&hung.calls===0;i++)await new Promise(r=>setImmediate(r));
  t.mock.timers.tick(30_000);
  const summary=await pending;
  assert.equal(summary.sent,0);
  assert.notEqual(summary.busy,true);
  assert.deepEqual(devices(fx,"alice").map(d=>d.status),["failed"]);
  assert.notEqual((await run(fx,sender(),NOW+1)).busy,true,"next pass is not blocked");
});

test("review fixes: identities beyond the per-pass cap rotate instead of starving",async()=>{
  const {TARGET_PUSH_PASS_MAX_USERS:CAP}=await import("../lib/target-attention-push-pass.ts");
  const fx=fixture();
  const ids=[];
  for(let i=0;i<CAP+1;i++){
    const who="u"+String(i).padStart(3,"0");ids.push(who);
    fx.db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    fx.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(who+"-ws",who);
    fx.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-area",who,who+"-ws",who);
    fx.db.prepare("UPDATE personal_notification_settings SET attention_push=1 WHERE user_id=?").run(who);
  }
  const first=await run(fx,sender(),NOW);
  assert.equal(first.deferred,ids.length-CAP,"one enabled identity deferred");
  // Across consecutive minutes every identity gets a turn.
  const served=new Set();
  const key=who=>fx.db.prepare("SELECT 1 FROM metadata WHERE key LIKE ? AND value=?")
    .get(BASELINE_PREFIX+"%",sha(JSON.stringify(["push-baseline-v1",who])));
  await run(fx,sender(),NOW+60_000);
  for(const who of ids)if(key(who))served.add(who);
  assert.equal(served.size,ids.length,"after two rotated passes all identities were baselined");
});

test("issue #326: recovering a committed sent device preserves the 24-hour limit",async()=>{
  const fx=fixture();
  task(fx,"alice","baseline");const target=register(fx,"alice","d");
  enable(fx,"alice",{dailyLimit:1});await run(fx,sender());
  const interrupted=task(fx,"alice","crashed delivery","2026-11-02");
  const key=targetAttentionDeliveryKey("deadline_overdue",interrupted,"2026-11-02");
  const attempted=NOW-19*60_000;
  fx.db.prepare(`INSERT INTO personal_attention_deliveries
    (user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms)
    VALUES ('alice',?,?,'deadline_overdue','2026-11-02','pending',1,?)`)
    .run(key,interrupted,NOW-20*60_000);
  fx.db.prepare(`INSERT INTO personal_attention_device_deliveries
    (user_id,delivery_key,target_id,status,attempts,last_attempt_at_ms)
    VALUES ('alice',?,?,'sent',1,?)`).run(key,target,attempted);
  task(fx,"alice","fresh but capped","2026-11-02");
  const s=sender();const result=await run(fx,s);
  assert.equal(s.calls.length,0,"already delivered notification consumes daily limit");
  assert.equal(result.held.daily_limit,1);
  const recovered=rows(fx,"alice").find(r=>r.task_id===interrupted);
  assert.equal(recovered.status,"sent");
  assert.equal(recovered.sent_at_ms,attempted,"use durable send time, not recovery time");
  await run(fx,s,NOW+HOUR);
  assert.equal(s.calls.length,0,"recovery must not duplicate the successful device");
  ok(fx);
});

test("issue #326: quiet-hour boundary defers remaining device without re-sending first",async()=>{
  const fx=fixture();
  task(fx,"alice","baseline");
  const d1=register(fx,"alice","d1"),d2=register(fx,"alice","d2");
  enable(fx,"alice",{timeZone:"Europe/Prague"});
  const justBefore=Q-2_000;
  await run(fx,sender(),justBefore);
  const id=task(fx,"alice","split delivery","2026-11-02");
  let current=justBefore;
  const first=sender(()=>{current=Q+1_000;return "sent";});
  await run(fx,first,justBefore,()=>current);
  assert.equal(first.calls.length,1,"second device cannot start inside quiet hours");
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"partial");
  const firstTarget=first.calls[0].targetId;
  const morning=Date.UTC(2026,10,6,7,30);
  const retry=sender();await run(fx,retry,morning,()=>morning);
  assert.deepEqual(retry.calls.map(c=>c.targetId),
    [[d1,d2].find(d=>d!==firstTarget)],"only the missed device is retried");
  assert.equal(rows(fx,"alice").find(r=>r.task_id===id).status,"sent");
  assert.deepEqual(devices(fx,"alice").map(r=>r.status),["sent","sent"]);
  ok(fx);
});

test("issue #326: snoozing after claim but before first send releases the occurrence",async()=>{
  const fx=fixture();
  task(fx,"alice","baseline");register(fx,"alice","d");enable(fx,"alice");
  await run(fx,sender());
  task(fx,"alice","first","2026-11-01");
  const snoozed=task(fx,"alice","snoozed before send","2026-11-02");
  const s=sender((user,target,payload,n)=>{
    if(n===1)fx.db.prepare(`INSERT INTO personal_attention_states
      (user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms)
      VALUES ('alice',?,'deadline_overdue','2026-11-02','snoozed',?)`)
      .run(snoozed,NOW+HOUR);
    return "sent";
  });
  await run(fx,s);
  assert.equal(s.calls.length,1,"no push during snooze");
  assert.equal(rows(fx,"alice").some(r=>r.task_id===snoozed),false,
    "unsent claim is released instead of becoming permanently undelivered");
  const after=sender();await run(fx,after,NOW+2*HOUR);
  assert.deepEqual(after.calls.map(c=>c.payload.title),["snoozed before send"]);
  assert.equal(rows(fx,"alice").find(r=>r.task_id===snoozed).status,"sent");
  assert.equal(s.calls.length,1,"previously sent occurrence is not duplicated");
  ok(fx);
});
