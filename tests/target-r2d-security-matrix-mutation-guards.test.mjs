// R2d.6 hardening: leak guards that the valid-data matrix cannot reach (staging, synthetic data only).
//
// Three of these guards need a state that the schema guard triggers make unreachable through valid writes:
//   * a foreign user's Attention lifecycle row on someone else's task (reconcile triggers delete it on reassignment),
//   * a task assigned to a VIEWER of a shared Area (the assignee trigger rejects it).
// Each is created in its OWN store by dropping exactly one guard trigger, inserting the row through a raw connection
// and re-creating the trigger from the SQL saved from sqlite_master (the schema DDL is asserted byte-identical
// before and after). Those stores intentionally fail the canonical preflight, so they are read through the
// db-level read models directly (the authority-level channels must then fail closed, which is asserted too).
// The third guard (push pre-send re-check) uses an ordinary valid store and a sender that changes the world
// between two device sends.
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";

const envNames=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED"];
const savedEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d6-guards-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true"});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {readAuthorizedAttentionCandidatePage}=await import("../lib/target-attention-read-model.ts");
const {readAuthorizedMyPlanDayTaskPage}=await import("../lib/target-my-plan-day-task-read-model.ts");
const {resolveAuthorizedTargetContextBundle}=await import("../lib/target-context-bundle.ts");

const [OWNER,EDITOR,VIEWER,STRANGER]=["usr_owner","usr_editor","usr_viewer","usr_stranger"];
const NOW=Date.UTC(2024,5,15,12,0,0);
const TZ="Europe/Prague";
const TODAY="2024-06-15",TOMORROW="2024-06-16",OVERDUE="2024-06-10",FRESH="2024-06-12",AHEAD="2024-06-22";
const sha=text=>createHash("sha256").update(text).digest("hex");
const fixtures=[];let serial=0;
process.on("exit",()=>{try{rmSync(root,{recursive:true,force:true});}catch{}});

/** Small canonical store: owner(admin)/editor/viewer in shared a_s1, each with a private Area; stranger only private. */
function store({users=[EDITOR,VIEWER]}={}){
  const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,"g-"+(++serial)),ownerUserId:OWNER});
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  const fx={stage,db,store:{stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration},tokens:{}};
  for(const u of users.concat(users.includes(STRANGER)?[]:[])){
    const s=u.slice(4,6);
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(u);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run("ws_pr_"+s,u);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run("a_pr_"+s,"private "+s,"ws_pr_"+s,u);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('ws_s1','shared',?)").run(OWNER);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('a_s1','shared a_s1','shared','ws_s1',?)").run(OWNER);
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('a_s1',?,'admin')").run(OWNER);
  if(users.includes(EDITOR))db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('a_s1',?,'editor')").run(EDITOR);
  if(users.includes(VIEWER))db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('a_s1',?,'viewer')").run(VIEWER);
  // R2d.4k: Attention/AI evaluate in the actor's server-side profile zone.
  db.prepare("UPDATE personal_notification_settings SET time_zone=?").run(TZ);
  fx.authority=new TargetStagingSessionAuthority(fx.store);
  fixtures.push(fx);
  return fx;
}
const privArea=(fx,u)=>u===OWNER?fx.stage.unassignedAreaId:"a_pr_"+u.slice(4,6);
const task=(fx,id,area,{assignee=null,due=null}={})=>
  fx.db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,NULL,?,?,?)")
    .run(id,area,"SNT task "+id,assignee,due);
const token=(fx,u)=>fx.tokens[u]??=fx.authority.issueWritable(u).sessionToken;
const ddl=fx=>JSON.stringify(fx.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
/** Run `body` with the named guard triggers dropped; re-create them from their saved SQL; DDL must be identical. */
function withoutTriggers(fx,names,body){
  const before=ddl(fx);
  const saved=names.map(n=>{
    const row=fx.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(n);
    assert.ok(row?.sql,"guard trigger exists: "+n);return {n,sql:row.sql};
  });
  for(const s of saved)fx.db.exec(`DROP TRIGGER "${s.n}"`);
  try{body();}finally{for(const s of saved)fx.db.exec(s.sql);}
  assert.equal(ddl(fx),before,"the schema DDL is byte-identical after the trigger-bypass fixture");
  for(const s of saved)assert.ok(fx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(s.n),"re-created "+s.n);
}
const ids=v=>[...new Set(JSON.stringify(v??null).match(/t_g_[a-z0-9_]+/g)??[])].sort();
const attention=(fx,u,filter,view)=>readAuthorizedAttentionCandidatePage(fx.db,{actorUserId:u,areaFilter:filter,view,
  evaluatedAtMs:NOW,timeZone:TZ,limit:100,offset:0,restoreGeneration:fx.stage.restoreGeneration});
const dayPages=(fx,u,filter)=>["today","upcoming"].map(window=>readAuthorizedMyPlanDayTaskPage(fx.db,{
  actorUserId:u,areaFilter:filter,window,evaluationDate:TODAY,throughDate:window==="today"?null:AHEAD,
  limit:100,offset:0,restoreGeneration:fx.stage.restoreGeneration}));
const bundle=(fx,u,purpose,scope)=>resolveAuthorizedTargetContextBundle(fx.db,{purpose,scope,
  query:purpose==="find"?"SNT":null,nowMs:NOW,maxItems:50,actorUserId:u,restoreGeneration:fx.stage.restoreGeneration});
const must=(v,label)=>{assert.ok(v,label+" returned null");return v;};

// ======= guard 1: the Attention lifecycle join is scoped to the ACTOR (foreign lifecycle rows never apply) =======
test("G1. a foreign user's lifecycle row on my task never reaches my Attention (lifecycle, snooze, revision, hidden view)",()=>{
  const fx=store();
  task(fx,"t_g_ow",fx.stage.unassignedAreaId,{due:OVERDUE});      // the owner's PRIVATE overdue task
  task(fx,"t_g_sh",  "a_s1",{assignee:OWNER,due:OVERDUE});       // shared overdue task assigned to the owner
  task(fx,"t_g_ed",  "a_s1",{assignee:EDITOR,due:OVERDUE});      // the editor's shared overdue task
  // legitimate lifecycle row (positive control): the owner snoozed their private task
  fx.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES (?,?,?,?,?,?)")
    .run(OWNER,"t_g_ow","deadline_overdue",OVERDUE,"snoozed",NOW+86_400_000);
  withoutTriggers(fx,["personal_attention_state_insert_guard"],()=>{
    const ins=fx.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms,revision) VALUES (?,?,?,?,?,?,?)");
    // foreign rows ON THE OWNER'S TASKS, written by other identities (valid data cannot produce them)
    ins.run(EDITOR,"t_g_sh","deadline_overdue",OVERDUE,"snoozed",NOW+7*86_400_000,7);
    ins.run(VIEWER,"t_g_sh","deadline_overdue",OVERDUE,"dismissed",null,5);
    // and a foreign row on the editor's task, written by the owner
    ins.run(OWNER,"t_g_ed","deadline_overdue",OVERDUE,"dismissed",null,3);
  });
  // canonical preflight rejects the corrupt rows: every authority-level read must fail closed, never answer
  for(const u of [OWNER,EDITOR])
    for(const view of ["active","hidden"])
      assert.equal(fx.authority.readAttentionCandidatePage(u,"all",view,NOW,100,0),null,`${u}/${view}: the authority fails closed on the corrupt store`);
  // db-level read model: the join is on the ACTOR's rows only
  const ownerActive=must(attention(fx,OWNER,"all","active"),"owner active"),ownerHidden=must(attention(fx,OWNER,"all","hidden"),"owner hidden");
  assert.deepEqual(ids(ownerActive),["t_g_sh"],"the owner's active list: the shared task (only a FOREIGN row exists) and not the snoozed private one");
  const shared=ownerActive.items.find(i=>i.taskId==="t_g_sh");
  assert.equal(shared.lifecycle,"active","a foreign snooze/dismiss must not change my lifecycle");
  assert.equal(shared.snoozedUntilMs,null,"a foreign snooze deadline must not become mine");
  assert.equal(shared.lifecycleRevision,null,"a foreign lifecycle revision must not become my CAS input");
  assert.deepEqual(ids(ownerHidden),["t_g_ow"],"the hidden view lists only what the owner hid himself");
  const own=ownerHidden.items[0];
  assert.deepEqual([own.lifecycle,own.snoozedUntilMs,own.lifecycleRevision],["snoozed",NOW+86_400_000,0],"my own row is applied exactly");
  // the editor: own task only, foreign (owner) dismissal on it is ignored; the owner's shared task is not theirs
  const edActive=must(attention(fx,EDITOR,"all","active"),"editor active"),edHidden=must(attention(fx,EDITOR,"all","hidden"),"editor hidden");
  assert.deepEqual(ids(edActive),["t_g_ed"]);
  assert.deepEqual([edActive.items[0].lifecycle,edActive.items[0].snoozedUntilMs,edActive.items[0].lifecycleRevision],["active",null,null]);
  assert.deepEqual(ids(edHidden),[],"the editor's hidden view is empty: the owner's dismissal is not theirs");
  // the viewer owns no work here: nothing from the other identities' rows
  for(const view of ["active","hidden"])
    assert.deepEqual(ids(must(attention(fx,VIEWER,"all",view),"viewer "+view)).filter(id=>id!=="t_g_vw"),[],"viewer/"+view);
  // no row is ever duplicated by a multi-match join
  for(const page of [ownerActive,ownerHidden,edActive])assert.equal(new Set(page.items.map(i=>i.attentionKey)).size,page.items.length);
});

// ======= guard 2: the push pass re-reads the world before EVERY device send =======
const settingsCommand=(fx,u,patch={})=>{
  const cur=fx.db.prepare("SELECT revision,time_zone,attention_push,quiet_start,quiet_end,daily_limit,paused FROM personal_notification_settings WHERE user_id=?").get(u);
  const epoch=fx.db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?").get(u).revision;
  return {commandId:randomUUID(),timeZone:cur.time_zone,attentionPush:cur.attention_push===1,quietStart:cur.quiet_start,
    quietEnd:cur.quiet_end,dailyLimit:cur.daily_limit,paused:cur.paused===1,...patch,expectedSettingsRevision:cur.revision,
    expectedNotificationEpoch:epoch,restoreGeneration:fx.stage.restoreGeneration};
};
const taskBase=(fx,by,taskId,area)=>{
  const pv=fx.authority.previewTaskTitleEdit(token(fx,by),{taskId});
  assert.equal(pv.ok,true,JSON.stringify(pv));
  return {commandId:randomUUID(),taskId,expectedRevision:pv.snapshotRevision,writeAreaId:area,restoreGeneration:fx.stage.restoreGeneration};
};
test("G2. a change during the pass (access lost, completed, dismissed, push disabled) stops the remaining device sends",async()=>{
  const fx=store({users:[EDITOR,VIEWER,STRANGER]});
  const A=fx.authority,users=[OWNER,EDITOR,VIEWER,STRANGER];
  // the stranger needs a private Area only; give every user two devices
  const devices={};
  for(const u of users){
    const res=A.changeNotificationSettings(token(fx,u),settingsCommand(fx,u,{attentionPush:true}));
    assert.equal(res.ok,true,JSON.stringify(res));
    devices[u]=[];
    for(const d of ["phone","laptop"]){
      const epoch=fx.db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?").get(u).revision;
      const reg=A.changePushTarget(token(fx,u),{commandId:randomUUID(),action:"register",endpointHash:sha(u+d),
        expectedNotificationEpoch:epoch,restoreGeneration:fx.stage.restoreGeneration});
      assert.equal(reg.ok,true,JSON.stringify(reg));devices[u].push(reg.targetId);
    }
  }
  const calls=[];
  const baseline={async sendTo(){calls.push("baseline");return "sent";}};
  await A.runAttentionPushPass(NOW,baseline);
  assert.deepEqual(calls,[],"the first pass only baselines");
  // fresh overdue work: one scenario task per user plus a control task for the editor
  task(fx,"t_g_scn_ow",privArea(fx,OWNER),{due:FRESH});                 // scenario B: completed mid-pass
  task(fx,"t_g_scn_ed","a_s1",{assignee:EDITOR,due:FRESH});             // scenario A: reassigned away mid-pass
  task(fx,"t_g_ctl_ed",privArea(fx,EDITOR),{due:FRESH});                // control: nothing happens, both devices are used
  task(fx,"t_g_scn_vw",privArea(fx,VIEWER),{due:FRESH});                // scenario C: dismissed mid-pass
  task(fx,"t_g_scn_st",privArea(fx,STRANGER),{due:FRESH});              // scenario D: push disabled mid-pass
  task(fx,"t_g_scn_s2",privArea(fx,STRANGER),{due:FRESH});              // D: a second task of the stranger (never sent either)
  const fired=new Set(),sent=[];
  const world={
    t_g_scn_ed:()=>fx.db.prepare("UPDATE tasks SET assignee_user_id=? WHERE id='t_g_scn_ed'").run(OWNER),
    t_g_scn_ow:()=>assert.equal(A.changeTemporalTaskStatus(token(fx,OWNER),{...taskBase(fx,OWNER,"t_g_scn_ow",privArea(fx,OWNER)),status:"completed"}).ok,true),
    t_g_scn_vw:()=>{
      const pv=A.previewAttentionCommand(VIEWER,"t_g_scn_vw","deadline_overdue",FRESH,NOW);
      assert.ok(pv,"preview for the dismissal");
      const res=A.changeAttentionLifecycle(token(fx,VIEWER),{...taskBase(fx,VIEWER,"t_g_scn_vw",privArea(fx,VIEWER)),
        ruleId:"deadline_overdue",occurrenceOn:FRESH,action:"dismiss",snoozedUntilMs:null,
        expectedAttentionEpoch:pv.expectedAttentionEpoch,expectedStateRevision:pv.expectedStateRevision});
      assert.equal(res.ok,true,JSON.stringify(res));
    },
    t_g_scn_st:()=>{
      const res=A.changeNotificationSettings(token(fx,STRANGER),settingsCommand(fx,STRANGER,{attentionPush:false}));
      assert.equal(res.ok,true,JSON.stringify(res));
    },
    t_g_scn_s2:()=>{
      const res=A.changeNotificationSettings(token(fx,STRANGER),settingsCommand(fx,STRANGER,{attentionPush:false}));
      assert.equal(res.ok,true,JSON.stringify(res));
    },
  };
  const sender={async sendTo(userId,targetId,payload){
    const taskId=payload.url.replace("/?task=","");
    sent.push({userId,targetId,taskId});
    // the FIRST send of a scenario task changes the world; the remaining device must not be served
    if(world[taskId]&&!fired.has(taskId)&&!(taskId==="t_g_scn_s2"&&fired.has("t_g_scn_st"))){
      fired.add(taskId);world[taskId]();
    }
    return "sent";
  }};
  const summary=await A.runAttentionPushPass(NOW,sender);
  assert.ok(summary.sent>0);
  const per=(u,t)=>sent.filter(c=>c.userId===u&&c.taskId===t);
  // control: an untouched item reaches BOTH devices of its owner (the second send is observable)
  assert.deepEqual(per(EDITOR,"t_g_ctl_ed").map(c=>c.targetId).sort(),[...devices[EDITOR]].sort(),"control: both devices are served");
  // scenario A..D: exactly the first device, then nothing
  assert.equal(per(EDITOR,"t_g_scn_ed").length,1,"A: access lost (reassigned) after the first device -> no second send");
  assert.equal(per(OWNER,"t_g_scn_ow").length,1,"B: task completed after the first device -> no second send");
  assert.equal(per(VIEWER,"t_g_scn_vw").length,1,"C: item dismissed after the first device -> no second send");
  assert.equal(sent.filter(c=>c.userId===STRANGER).length,1,"D: push disabled after the first send -> nothing more for ANY task of that user");
  for(const [u,t] of [[EDITOR,"t_g_scn_ed"],[OWNER,"t_g_scn_ow"],[VIEWER,"t_g_scn_vw"]])
    assert.equal(per(u,t)[0].targetId,devices[u][0],`${u}: the single send went to the user's own first device`);
  // nothing ever went to another identity's device
  for(const c of sent)assert.ok(devices[c.userId].includes(c.targetId),`${c.taskId} was sent to ${c.userId}'s own device only`);
});

// ======= guard 3: a VIEWER-assigned shared task (schema-unreachable) is never "mine" =======
test("G3. a task assigned to a shared-Area viewer is absent from My Plan, Attention, push and the AI my-plan purposes",async()=>{
  const fx=store();
  task(fx,"t_g_ow","a_s1",{assignee:OWNER,due:OVERDUE});                 // positive control: a real assignment
  task(fx,"t_g_pr_vw",privArea(fx,VIEWER),{due:OVERDUE});                // the viewer's own private overdue task
  withoutTriggers(fx,["task_assignee_insert","personal_task_plan_insert_guard","personal_attention_state_insert_guard"],()=>{
    task(fx,"t_g_vw","a_s1",{assignee:VIEWER,due:OVERDUE});              // viewer-assigned overdue shared task
    task(fx,"t_g_vw2","a_s1",{assignee:VIEWER,due:TOMORROW});            // viewer-assigned, upcoming
    fx.db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(VIEWER,"t_g_vw",TODAY);
    fx.db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(VIEWER,"t_g_vw2",TODAY);
  });
  assert.equal(fx.db.prepare("SELECT role FROM area_members WHERE area_id='a_s1' AND user_id=?").get(VIEWER).role,"viewer");
  const mine=/t_g_vw\d?\b/;
  // db-level selectors: the role filter lives in SQL; the viewer sees only his own private work
  for(const f of ["all","personal","shared"]){
    for(const page of dayPages(fx,VIEWER,f))
      assert.ok(!mine.test(JSON.stringify(must(page,"viewer day "+f))),`My Plan day (${f}) lists the viewer-assigned shared task`);
    for(const view of ["active","hidden"])
      assert.ok(!mine.test(JSON.stringify(must(attention(fx,VIEWER,f,view),"viewer attention "+f+view))),`Attention ${f}/${view} lists the viewer-assigned shared task`);
  }
  assert.ok(ids(dayPages(fx,VIEWER,"all")).includes("t_g_pr_vw"),"control: the viewer's own private task is listed");
  assert.ok(ids(attention(fx,VIEWER,"all","active")).includes("t_g_pr_vw"),"control: the viewer's private task is in Attention");
  assert.ok(ids(dayPages(fx,OWNER,"all")).includes("t_g_ow")&&ids(attention(fx,OWNER,"all","active")).includes("t_g_ow"),"control: a real assignee does see it");
  for(const [purpose,scope] of [["what_matters","my-plan"],["what_matters","personal"],["what_matters","shared"],
    ["plan_today","my-plan"],["plan_today","personal"],["plan_today","shared"]]){
    const b=must(bundle(fx,VIEWER,purpose,scope),`viewer ${purpose}/${scope}`);
    assert.ok(!mine.test(JSON.stringify(b.items)),`AI ${purpose}/${scope} contains the viewer-assigned task`);
  }
  assert.ok(ids(must(bundle(fx,OWNER,"what_matters","my-plan"),"owner AI").items).includes("t_g_ow"),"control: the real assignee's AI bundle has it");
  // authority level: the canonical preflight rejects the store (assignee_invalid) -> every personal channel fails closed
  const A=fx.authority;
  for(const out of [A.readScopedOffsetPage(VIEWER,"my-plan",100,0),A.readMyPlanDayTaskPage(VIEWER,"all","today",TODAY,null,100,0),
    A.readAttentionCandidatePage(VIEWER,"all","active",NOW,100,0),A.readMyPlanHomeSummary(VIEWER),
    A.resolveContextBundle(VIEWER,{purpose:"what_matters",scope:"my-plan",query:null,nowMs:NOW,maxItems:50}),
    A.resolveContextBundle(VIEWER,{purpose:"plan_today",scope:"my-plan",query:null,nowMs:NOW,maxItems:50})])
    assert.ok(out===null||!mine.test(JSON.stringify(out)),"an authority channel exposes the viewer-assigned task");
  // push: the corrupt store cannot even mint a writable token (settings cannot be enabled), and two passes send nothing
  assert.equal(A.issueWritable(VIEWER),null,"the corrupt store issues no writable session");
  const sender={calls:[],async sendTo(userId,targetId,payload){this.calls.push({userId,targetId,payload});return "sent";}};
  await A.runAttentionPushPass(NOW,sender);
  task(fx,"t_g_pr_fresh",privArea(fx,VIEWER),{due:FRESH});
  await A.runAttentionPushPass(NOW,sender);
  assert.ok(!sender.calls.some(c=>mine.test(JSON.stringify(c.payload))),"the viewer was pushed the viewer-assigned shared task");
});

test("legacy data directory untouched; guard stores closed",()=>{
  try{
    for(const fx of fixtures)assert.ok(fx.stage.directory.startsWith(root),"every guard store lives under the temp root");
  }finally{
    for(const fx of fixtures){try{fx.authority.close();}catch{}try{fx.db.close();}catch{}}
    for(const [k,v] of Object.entries(savedEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
});
