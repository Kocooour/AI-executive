// R2d.6 consolidated security matrix: actor x Area x channel (staging, synthetic data only).
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";

const envNames=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY","AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const savedEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d6-matrix-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-r2d6-matrix-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const durable=await import("../lib/target-staging-durable-session.ts");

const ACTORS=["usr_owner","usr_editor","usr_viewer","usr_stranger"];
const [OWNER,EDITOR,VIEWER,STRANGER]=ACTORS;
const NOW=Date.UTC(2024,5,15,12,0,0);
const TZ="Europe/Prague";
const TODAY="2024-06-15",TOMORROW="2024-06-16",OVERDUE="2024-06-10",FRESH="2024-06-12";
const SECRET="matrix-note-sync-secret-of-sufficient-length-0123456789";

const fixtures=[];let serial=0;
process.on("exit",()=>{try{rmSync(root,{recursive:true,force:true});}catch{}});

// ---------------------------------------------------------------------------
// Canonical synthetic fixture. Every entity id is a fixed-width token that never
// prefixes another one, so a plain substring scan of any serialized channel output
// reliably tells which entities that channel exposed.
// ---------------------------------------------------------------------------
const SHORT={[OWNER]:"ow",[EDITOR]:"ed",[VIEWER]:"vw",[STRANGER]:"st"};
const SHARED={ // area id -> {workspace owner, members}
  a_s1:{owner:OWNER,members:{[OWNER]:"admin",[EDITOR]:"editor",[VIEWER]:"viewer"}},
  a_s2:{owner:OWNER,members:{[OWNER]:"admin"}},
  a_s3:{owner:STRANGER,members:{[STRANGER]:"admin"}},
};
const privAreaId=(fx,u)=>u===OWNER?fx.stage.unassignedAreaId:"a_pr_"+SHORT[u];
function buildSpec(fx){
  const tasks=[],projects=[],notes=[],plans=[];
  const T=(id,area,o={})=>tasks.push({id,area,project:null,assignee:null,due:null,done:false,...o});
  const P=(id,area)=>projects.push({id,area});
  const N=(id,area,project=null)=>notes.push({id,area,project});
  for(const u of ACTORS){
    const s=SHORT[u],a=privAreaId(fx,u);
    T(`t_pr_${s}_01`,a,{due:OVERDUE});
    T(`t_pr_${s}_02`,a);plans.push([u,`t_pr_${s}_02`,TODAY]);
    T(`t_pr_${s}_03`,a,{due:TODAY});
    T(`t_pr_${s}_04`,a,{due:OVERDUE,done:true});
    T(`t_pr_${s}_05`,a,{due:TOMORROW});
    P(`p_pr_${s}_01`,a);T(`t_pr_${s}_06`,a,{project:`p_pr_${s}_01`,area:null,due:OVERDUE});
    N(`n_pr_${s}_01`,a);N(`n_pr_${s}_02`,null,`p_pr_${s}_01`);
  }
  // S1: shared by owner(admin) / editor / viewer
  T("t_s1_01","a_s1",{assignee:EDITOR,due:OVERDUE});
  T("t_s1_02","a_s1",{assignee:OWNER,due:OVERDUE});
  T("t_s1_03","a_s1",{due:OVERDUE});
  T("t_s1_04","a_s1",{assignee:EDITOR,due:TODAY});
  T("t_s1_05","a_s1",{assignee:EDITOR,due:OVERDUE,done:true});
  T("t_s1_06","a_s1",{assignee:OWNER,due:TOMORROW});
  P("p_s1_01","a_s1");   // project with an editor assignee
  T("t_s1_07",null,{project:"p_s1_01",assignee:EDITOR,due:OVERDUE});
  T("t_s1_08",null,{project:"p_s1_01",due:OVERDUE});
  P("p_s1_02","a_s1");   // shared project WITHOUT the editor's assignment
  T("t_s1_09",null,{project:"p_s1_02",assignee:OWNER,due:OVERDUE});
  T("t_s1_10",null,{project:"p_s1_02",due:OVERDUE});
  N("n_s1_01","a_s1");N("n_s1_02",null,"p_s1_01");
  plans.push([OWNER,"t_s1_02","2024-06-13"]);plans.push([OWNER,"t_s2_01","2024-06-14"]);
  // S2: owner only; S3: stranger's own shared Area
  T("t_s2_01","a_s2",{assignee:OWNER,due:OVERDUE});T("t_s2_02","a_s2",{due:OVERDUE});
  P("p_s2_01","a_s2");T("t_s2_03",null,{project:"p_s2_01",assignee:OWNER,due:OVERDUE});
  N("n_s2_01","a_s2");N("n_s2_02",null,"p_s2_01");
  T("t_s3_01","a_s3",{assignee:STRANGER,due:OVERDUE});T("t_s3_02","a_s3",{due:OVERDUE});
  P("p_s3_01","a_s3");T("t_s3_03",null,{project:"p_s3_01",assignee:STRANGER,due:OVERDUE});
  N("n_s3_01","a_s3");N("n_s3_02",null,"p_s3_01");
  return {tasks,projects,notes,plans};
}

function fixture({push=false}={}){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:OWNER,
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const fx={stage,db,store:{stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration},tokens:{}};
  for(const u of ACTORS.filter(x=>x!==OWNER)){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(u);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run("ws_pr_"+SHORT[u],u);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run("a_pr_"+SHORT[u],"private "+SHORT[u],"ws_pr_"+SHORT[u],u);
  }
  for(const [area,def] of Object.entries(SHARED)){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)").run("ws"+area.slice(1),def.owner);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(area,"shared "+area,"ws"+area.slice(1),def.owner);
    for(const [u,role] of Object.entries(def.members))
      db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(area,u,role);
  }
  const spec=buildSpec(fx);fx.spec=spec;
  const pi=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const p of spec.projects)pi.run(p.id,p.area,"SNT project "+p.id);
  const ti=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const t of spec.tasks)ti.run(t.id,t.area,t.project,"SNT task "+t.id,t.assignee,t.due);
  for(const t of spec.tasks.filter(x=>x.done))
    db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id=?").run(t.id);
  const ni=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const n of spec.notes)ni.run(n.id,n.area,n.project,"SNT note "+n.id,"BODY-SENTINEL "+n.id);
  for(const [u,t,w] of spec.plans)
    db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(u,t,w);
  // Lifecycle states: editor dismissed a shared overdue, owner snoozed a private overdue,
  // viewer dismissed a private overdue.
  const ls=db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES (?,?,?,?,?,?)");
  ls.run(EDITOR,"t_s1_01","deadline_overdue",OVERDUE,"dismissed",null);
  ls.run(OWNER,"t_pr_ow_01","deadline_overdue",OVERDUE,"snoozed",NOW+24*3_600_000);
  ls.run(VIEWER,"t_pr_vw_01","deadline_overdue",OVERDUE,"dismissed",null);
  fx.authority=new TargetStagingSessionAuthority(fx.store);
  fx.reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  fixtures.push(fx);
  return fx;
}
const token=(fx,u)=>fx.tokens[u]??=fx.authority.issueWritable(u).sessionToken;

// ------------------------------- authorization model (oracle) ----------------------------
// The expected visibility is derived from the CURRENT membership / assignment rows (never from
// the code under test), so the model follows every transition applied to the fixture.
function current(fx){
  const roles=new Map();
  for(const r of fx.db.prepare("SELECT area_id,user_id,role FROM area_members").all())
    roles.set(r.area_id+"|"+r.user_id,r.role);
  const kinds=new Map(fx.db.prepare("SELECT id,kind,owner_user_id FROM areas").all().map(r=>[r.id,r]));
  const roleIn=(u,a)=>kinds.get(a)?.kind==="private"?(kinds.get(a).owner_user_id===u?"owner":null):(roles.get(a+"|"+u)??null);
  const tasks=fx.db.prepare(`SELECT t.id,COALESCE(t.area_id,p.area_id) AS area,t.assignee_user_id AS assignee,
    t.status,t.project_id AS project FROM tasks t LEFT JOIN projects p ON p.id=t.project_id ORDER BY t.id`).all()
    .map(x=>({kind:"task",...x}));
  const notes=fx.db.prepare(`SELECT n.id,COALESCE(n.area_id,p.area_id) AS area,n.project_id AS project
    FROM notes n LEFT JOIN projects p ON p.id=n.project_id ORDER BY n.id`).all().map(x=>({kind:"note",...x}));
  const projects=fx.db.prepare("SELECT id,area_id AS area FROM projects ORDER BY id").all().map(x=>({kind:"project",...x}));
  const all=[...tasks,...notes,...projects];
  const readable=u=>all.filter(e=>roleIn(u,e.area)!==null);
  const mine=u=>tasks.filter(t=>kinds.get(t.area).kind==="private"?roleIn(u,t.area)!==null
    :t.assignee===u&&["admin","editor"].includes(roleIn(u,t.area)));
  return {roleIn,tasks,notes,projects,all,readable,mine,kinds};
}
const rid=e=>e.id;
/** Tokens an actor MAY see in serialized output. */
function allowedTokens(fx,u){
  const m=current(fx),ok=new Set(m.readable(u).map(rid));
  for(const a of m.kinds.keys())if(m.roleIn(u,a)!==null)ok.add(a);
  ok.add(u);
  return ok;
}
/** Every scannable token that ever existed in the fixture (deleted entities stay scannable). */
function universeTokens(fx){
  const all=new Set([...fx.spec.tasks,...fx.spec.projects,...fx.spec.notes].map(e=>e.id));
  for(const n of fx.extraTokens??[])all.add(n);
  for(const a of Object.keys(SHARED))all.add(a),all.add("ws"+a.slice(1));
  for(const u of ACTORS){all.add(privAreaId(fx,u));all.add(u);all.add("ws_pr_"+SHORT[u]);}
  return [...all];
}
const foundTokens=(fx,json)=>universeTokens(fx).filter(t=>json.includes(t));
const TASK_RE=/t_(?:pr_(?:ow|ed|vw|st)|s[123])_\d\d/g,NOTE_RE=/n_(?:pr_(?:ow|ed|vw|st)|s[123])_\d\d/g;
const taskIdsIn=json=>[...new Set(json.match(TASK_RE)??[])].sort();
const noteIdsIn=json=>[...new Set(json.match(NOTE_RE)??[])].sort();
const idsOf=v=>taskIdsIn(JSON.stringify(v??null));
const specEntities=fx=>[...fx.spec.tasks.map(t=>({kind:"task",id:t.id})),
  ...fx.spec.projects.map(p=>({kind:"project",id:p.id})),...fx.spec.notes.map(n=>({kind:"note",id:n.id}))];

// ------------------------------------ channel registry ------------------------------------
const {serializeTargetContextBundleForProvider}=await import("../lib/target-context-bundle.ts");
const DAYS_AHEAD="2024-06-22";
const ALL_SCOPES=["all","personal","shared"];
const entityIds=(fx,kind)=>specEntities(fx).filter(e=>e.kind===kind).map(e=>e.id);
const areaIds=fx=>[...Object.keys(SHARED),...ACTORS.map(u=>privAreaId(fx,u))];
/** Probe tasks: every S1 task (assigned / foreign / unassigned / project), plus the first and the
 * project task of every other Area. Area ACL is per Area, so this covers every decision class. */
const PROBE_TASKS=["t_s1_01","t_s1_02","t_s1_03","t_s1_05","t_s1_09","t_s2_01","t_s3_01",
  "t_pr_ow_01","t_pr_ow_06","t_pr_ed_01","t_pr_st_01"];
const PROBE_NOTES=["n_s1_01","n_s1_02","n_s2_01","n_s3_01","n_pr_ow_01","n_pr_vw_01","n_pr_st_02"];
const PROBE_PROJECTS=["p_s1_01","p_s1_02","p_s2_01","p_s3_01","p_pr_ow_01","p_pr_ed_01"];
const probeTasks=()=>PROBE_TASKS;
const FULL=fx=>({scopes:ALL_SCOPES,tasks:probeTasks(fx),projects:PROBE_PROJECTS,
  notes:PROBE_NOTES,areas:areaIds(fx),queries:["SNT","SNT task","t_s1_0"],
  mpFilters:ALL_SCOPES,
  bundles:[["what_matters","my-plan"],["what_matters","personal"],["what_matters","shared"],
    ["plan_today","my-plan"],["plan_today","personal"],["plan_today","shared"],
    ["find","all"],["find","personal"],["find","shared"]],
  temporal:true});
const LITE=(fx,extra={})=>({scopes:["all"],tasks:extra.tasks??[],projects:extra.projects??[],
  notes:extra.notes??[],areas:extra.areas??["a_s1"],queries:["SNT"],mpFilters:["all"],
  bundles:[["what_matters","my-plan"],["find","all"],["find","shared"]],temporal:true});
const bundleReq=(purpose,scope)=>({purpose,scope,query:purpose==="find"?"SNT":null,
  nowMs:NOW,timeZone:TZ,maxItems:50});
/** Loop over probe ids; the id itself must not leak into the output, so keep only the results. */
const probe=(list,fn)=>list.map(fn).filter(x=>x!==null&&x!==undefined);
const keyed=(list,fn)=>Object.fromEntries(list.map((k,i)=>[i,fn(k)]));
/** The (actor, channel) being captured: lets a null page name the broken invariant instead of a bare TypeError. */
const CUR={u:"?",ch:"?"};
/** Page-like reads must ALWAYS answer for a legitimate identity (empty is fine, null is a defect or a harness bug). */
const must=(v,what="")=>{
  assert.ok(v!==null&&v!==undefined,`${CUR.u} x ${CUR.ch}${what?" / "+what:""} returned null (the channel refused a legitimate identity)`);
  return v;
};
/** channel -> (fx, actor, ctx) => JSON-serializable value. null/undefined = refused (probe channels only). */
const CHANNELS={
  "personal/task-page":(fx,u)=>must(fx.authority.readPersonalOffsetPage(u,100,0)),
  "personal/task-detail":(fx,u,c)=>probe(c.tasks,id=>fx.authority.readPersonalTaskDetail(u,id)),
  "personal/project-page":(fx,u)=>must(fx.authority.readPrivateProjectOffsetPage(u,100,0)),
  "personal/project-detail":(fx,u,c)=>probe(c.projects,id=>fx.authority.readPrivateProjectDetail(u,id)),
  "scoped/shared+my-plan":(fx,u)=>({shared:must(fx.authority.readScopedOffsetPage(u,"shared",100,0),"shared"),
    myPlan:must(fx.authority.readScopedOffsetPage(u,"my-plan",100,0),"my-plan")}),
  "temporal/status":(fx,u,c)=>!c.temporal?null:Object.fromEntries(["personal","shared","my-plan"].flatMap(s=>
    ["all","open","completed"].map(st=>[s+"/"+st,must(fx.authority.readTemporalTaskPage(u,s,st,100,0),s+"/"+st)]))),
  "temporal/due-window":(fx,u,c)=>!c.temporal?null:Object.fromEntries(["personal","shared","my-plan"].flatMap(s=>
    ["overdue","due-today","upcoming"].map(w=>[s+"/"+w,
      must(fx.authority.readTemporalDueWindowPage(u,s,w,TODAY,w==="upcoming"?DAYS_AHEAD:null,100,0),s+"/"+w)]))),
  "temporal/task-detail":(fx,u,c)=>probe(c.tasks,id=>fx.authority.readTemporalTaskDetail(u,id)),
  "shared/task-detail":(fx,u,c)=>probe(c.tasks,id=>fx.authority.readSharedTaskDetail(u,id)),
  "personal-when":(fx,u)=>({all:must(fx.authority.readPersonalWhenPage(u,"all",null,null,100,0),"all"),
    day:must(fx.authority.readPersonalWhenPage(u,"on-day",TODAY,null,100,0),"on-day"),
    upcoming:must(fx.authority.readPersonalWhenPage(u,"upcoming",TODAY,DAYS_AHEAD,100,0),"upcoming")}),
  "project/index":(fx,u)=>Object.fromEntries(["personal","shared","my-plan"].map(s=>
    [s,must(fx.authority.readAuthorizedProjectIndex(u,s,100,0),s)])),
  "project/detail+tasks":(fx,u,c)=>probe(c.projects,id=>fx.authority.readAuthorizedProjectTasks(u,id,100,0)),
  "relations/project":(fx,u,c)=>probe(c.projects,id=>fx.authority.readAuthorizedProjectStructuralRelations(u,id,50,0)),
  "relations/backlinks":(fx,u,c)=>[
    ...probe(c.tasks,id=>fx.authority.readAuthorizedTargetParentBacklink(u,"task",id)),
    ...probe(c.notes,id=>fx.authority.readAuthorizedTargetParentBacklink(u,"note",id))],
  "note/read":(fx,u,c)=>probe(c.notes,id=>fx.authority.readAuthorizedNote(u,id)),
  "note-sync/bootstrap":(fx,u,c)=>probe(c.areas,a=>fx.authority.readAuthorizedNoteSync(u,
    {areaId:a,limit:100,secret:SECRET})),
  "global/task":(fx,u,c)=>keyed(c.scopes,s=>must(fx.authority.readGlobalTaskPage(u,s,100,0),s)),
  "global/project":(fx,u,c)=>keyed(c.scopes,s=>must(fx.authority.readGlobalProjectPage(u,s,100,0),s)),
  "global/note":(fx,u,c)=>keyed(c.scopes,s=>must(fx.authority.readGlobalNotePage(u,s,100,0),s)),
  "global/combined":(fx,u,c)=>keyed(c.scopes,s=>
    must(fx.authority.readGlobalCombinedPage(u,s,100,{projects:0,tasks:0,notes:0}),s)),
  "search/title":(fx,u,c)=>c.scopes.flatMap(s=>c.queries.map(q=>must(fx.authority.readAuthorizedTitleSearchPage(u,s,q,50,0),s+"/"+q))),
  "my-plan/day":(fx,u,c)=>c.mpFilters.flatMap(f=>[
    must(fx.authority.readMyPlanDayTaskPage(u,f,"today",TODAY,null,100,0),f+"/today"),
    must(fx.authority.readMyPlanDayTaskPage(u,f,"upcoming",TODAY,DAYS_AHEAD,100,0),f+"/upcoming"),
    must(fx.authority.readMyPlanTwoDayTaskPage(u,f,TODAY,TOMORROW,100,0,0),f+"/two-day")]),
  "home/summaries":(fx,u,c)=>({myPlan:must(fx.authority.readMyPlanHomeSummary(u),"my-plan"),
    ...(c.temporal?{personal:must(fx.authority.readScopedHomeSummary(u,"personal"),"personal"),
      shared:must(fx.authority.readScopedHomeSummary(u,"shared"),"shared"),
      scopedMyPlan:must(fx.authority.readScopedHomeSummary(u,"my-plan"),"scoped my-plan")}:{})}),
  "attention/list":(fx,u,c)=>c.mpFilters.flatMap(f=>["active","hidden"].map(v=>
    must(fx.authority.readAttentionCandidatePage(u,f,v,NOW,TZ,100,0),f+"/"+v))),
  "attention/command-preview":(fx,u,c)=>probe(c.tasks,id=>
    fx.authority.previewAttentionCommand(u,id,"deadline_overdue",OVERDUE,NOW)),
  "notifications/settings":(fx,u)=>must(fx.authority.readNotificationSettings(u)),
  "ai/context-bundle":(fx,u,c)=>c.bundles.map(([p,s])=>{
    const b=must(fx.authority.resolveContextBundle(u,bundleReq(p,s)),p+"/"+s);
    return {provider:JSON.parse(serializeTargetContextBundleForProvider(b)),revision:b.revision};
  }),
};
const CHANNEL_NAMES=Object.keys(CHANNELS);
// Sealed note-sync cursors carry a random nonce; they are the only intentionally non-deterministic bytes.
const mask=json=>json.replace(/"cursor":"[A-Za-z0-9_-]{100,}"/g,'"cursor":"<sealed>"');
/** One serialized snapshot of the chosen channels for one actor. */
function capture(fx,u,ctx,only=CHANNEL_NAMES){
  const out={};
  for(const name of only){
    let value;CUR.u=u;CUR.ch=name;
    try{value=CHANNELS[name](fx,u,ctx);}catch(error){value={THROWN:String(error)};}
    out[name]=mask(JSON.stringify(value??null));
  }
  return out;
}


// ------------------------------- notification / push arming -------------------------------
const sha=text=>createHash("sha256").update(text).digest("hex");
const epochOf=(fx,u)=>fx.db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?").get(u).revision;
function settingsCommand(fx,u,patch={}){
  const cur=fx.db.prepare("SELECT revision,time_zone,attention_push,quiet_start,quiet_end,daily_limit,paused FROM personal_notification_settings WHERE user_id=?").get(u);
  return {commandId:randomUUID(),timeZone:cur.time_zone,attentionPush:cur.attention_push===1,
    quietStart:cur.quiet_start,quietEnd:cur.quiet_end,dailyLimit:cur.daily_limit,
    paused:cur.paused===1,...patch,expectedSettingsRevision:cur.revision,
    expectedNotificationEpoch:epochOf(fx,u),restoreGeneration:fx.stage.restoreGeneration};
}
const recordingSender=()=>{
  const calls=[];
  return {calls,async sendTo(userId,targetId,payload){calls.push({userId,targetId,payload});return "sent";}};
};
const pushedTasks=sender=>{
  const by={};
  for(const c of sender.calls)(by[c.userId]??=new Set()).add(c.payload.url.replace("/?task=",""));
  return Object.fromEntries(Object.entries(by).map(([u,set])=>[u,[...set].sort()]));
};
function addTask(fx,t){
  const task={project:null,assignee:null,due:null,done:false,...t};
  fx.db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)")
    .run(task.id,task.area,task.project,"SNT task "+task.id,task.assignee,task.due);
  fx.spec.tasks.push(task);
}
/** Enable push + register one device per identity, baseline, then add FRESH overdue work in
 * every Area. The fresh items are announced by the next pass (never before). */
async function armPush(fx){
  fx.devices={};
  for(const u of ACTORS){
    const res=fx.authority.changeNotificationSettings(token(fx,u),settingsCommand(fx,u,{attentionPush:true}));
    assert.equal(res.ok,true,JSON.stringify(res));
    const reg=fx.authority.changePushTarget(token(fx,u),{commandId:randomUUID(),action:"register",
      endpointHash:sha(u+":device"),expectedNotificationEpoch:epochOf(fx,u),
      restoreGeneration:fx.stage.restoreGeneration});
    assert.equal(reg.ok,true,JSON.stringify(reg));
    fx.devices[u]=reg.targetId;
  }
  const baseline=recordingSender();
  await fx.authority.runAttentionPushPass(NOW,baseline);
  assert.equal(baseline.calls.length,0,"the first pass only baselines existing work");
  for(const u of ACTORS)addTask(fx,{id:`t_pr_${SHORT[u]}_90`,area:privAreaId(fx,u),due:FRESH});
  addTask(fx,{id:"t_s1_91",area:"a_s1",assignee:EDITOR,due:FRESH});
  addTask(fx,{id:"t_s1_92",area:"a_s1",assignee:OWNER,due:FRESH});
  addTask(fx,{id:"t_s1_93",area:"a_s1",due:FRESH});
  addTask(fx,{id:"t_s2_91",area:"a_s2",assignee:OWNER,due:FRESH});
  addTask(fx,{id:"t_s3_91",area:"a_s3",assignee:STRANGER,due:FRESH});
}


// ------------------------------------ shared base fixture ------------------------------------
let basePromise;
/** One canonical fixture: push armed, one delivery pass executed, FULL capture of every actor. */
function getBase(){
  return basePromise??=(async()=>{
    const fx=fixture();
    await armPush(fx);
    fx.sender=recordingSender();
    fx.pass=await fx.authority.runAttentionPushPass(NOW,fx.sender);
    fx.ctx=FULL(fx);
    fx.caps={};
    for(const u of ACTORS)fx.caps[u]=capture(fx,u,fx.ctx);
    return fx;
  })();
}
const table=(rows,fn)=>{for(const [actor,channel] of rows)fn(actor,channel);};
const matrix=()=>ACTORS.flatMap(a=>CHANNEL_NAMES.map(c=>[a,c]));

// =========================== Invariant 1: no foreign private data ===========================
test("1. no foreign private data in any channel for any actor (actor x channel table)",async()=>{
  const fx=await getBase();
  const m=current(fx);
  table(matrix(),(u,ch)=>{
    const json=fx.caps[u][ch],allowed=allowedTokens(fx,u);
    assert.ok(!json.includes("THROWN"),`${u} x ${ch} threw: ${json.slice(0,200)}`);
    const leaked=foundTokens(fx,json).filter(t=>!allowed.has(t));
    assert.deepEqual(leaked,[],`${u} x ${ch} exposes entities outside its authorization`);
    // Note bodies are released only by the authorized note read and the AI find bundle (R2d.4j), to the notes' readers only.
    if(ch!=="note/read"&&ch!=="ai/context-bundle")assert.ok(!json.includes("BODY-SENTINEL"),`${u} x ${ch} releases a note body`);
    else for(const n of noteIdsIn(json.replaceAll(/BODY-SENTINEL (n_\w+)/g,"$1")))
      assert.ok(allowed.has(n),`${u} x ${ch} releases the body of ${n}`);
  });
  // personal state of other identities: plan dates, lifecycle rows and device ids never cross identities
  const ownerPlans=["2024-06-13","2024-06-14"];
  for(const u of [EDITOR,VIEWER,STRANGER])table(CHANNEL_NAMES.map(c=>[u,c]),(a,ch)=>
    ownerPlans.forEach(d=>assert.ok(!fx.caps[a][ch].includes(d),`${a} x ${ch} shows the owner's private plan date ${d}`)));
  for(const [u,word] of [[OWNER,"dismissed"],[STRANGER,"dismissed"],[EDITOR,"snoozed"],[VIEWER,"snoozed"],[STRANGER,"snoozed"]])
    table(CHANNEL_NAMES.map(c=>[u,c]),(a,ch)=>
      assert.ok(!fx.caps[a][ch].includes(`"${word}"`),`${a} x ${ch} shows another identity's ${word} lifecycle`));
  for(const u of ACTORS)table(CHANNEL_NAMES.map(c=>[u,c]),(a,ch)=>
    ACTORS.filter(o=>o!==a&&fx.devices[o]).forEach(o=>
      assert.ok(!fx.caps[a][ch].includes(fx.devices[o]),`${a} x ${ch} shows ${o}'s push device id`)));
  // Probes that are positive controls: authorized probes are really answered (no fail-everything pass).
  for(const u of ACTORS){
    const readable=new Set(m.readable(u).map(rid));
    const expected=(kind,filter=()=>true)=>specEntities(fx).filter(e=>e.kind===kind&&readable.has(e.id)&&filter(e)).map(e=>e.id).sort();
    const found=(ch,re)=>[...new Set(fx.caps[u][ch].match(re)??[])].sort();
    assert.deepEqual(found("note/read",NOTE_RE),expected("note",e=>PROBE_NOTES.includes(e.id)),`${u} x note/read answers exactly its readable notes`);
    assert.deepEqual(found("temporal/task-detail",TASK_RE).filter(t=>fx.ctx.tasks.includes(t)),
      expected("task",e=>fx.ctx.tasks.includes(e.id)),`${u} x temporal/task-detail answers exactly its readable tasks`);
  }
  // Pushes: every delivery went to the recipient's own device, for the recipient's own work only.
  assert.ok(fx.sender.calls.length>0);
  for(const c of fx.sender.calls){
    const t=c.payload.url.replace("/?task=","");
    assert.equal(c.targetId,fx.devices[c.userId],`push for ${t} went to a device of ${c.userId}`);
    assert.ok(allowedTokens(fx,c.userId).has(t),`push to ${c.userId} names a task it cannot read: ${t}`);
    assert.deepEqual(foundTokens(fx,JSON.stringify(c.payload)).filter(x=>!allowedTokens(fx,c.userId).has(x)),[]);
  }
});

// ============================ Invariant 7: Area S1 vs S3 isolation ============================
test("7. the stranger's own shared Area S3 never reaches S1/S2 members and vice versa",async()=>{
  const fx=await getBase();
  const S3=/(?:t|p|n)_s3_\d\d|a_s3|ws_s3/,FOREIGN_TO_STRANGER=/(?:t|p|n)_s[12]_\d\d|a_s[12]|ws_s[12]|area:unassigned:usr_owner|usr_owner|usr_editor|usr_viewer/;
  table([OWNER,EDITOR,VIEWER].flatMap(u=>CHANNEL_NAMES.map(c=>[u,c])),(u,ch)=>
    assert.ok(!S3.test(fx.caps[u][ch]),`${u} x ${ch} sees the stranger's shared Area S3`));
  table(CHANNEL_NAMES.map(c=>[STRANGER,c]),(u,ch)=>
    assert.ok(!FOREIGN_TO_STRANGER.test(fx.caps[u][ch]),`${u} x ${ch} sees S1/S2 or their members`));
  // The stranger really has S3 content (positive control) and it is the stranger's alone.
  assert.ok(/t_s3_01/.test(fx.caps[STRANGER]["global/task"])&&/n_s3_01/.test(fx.caps[STRANGER]["note/read"]));
  // Their push deliveries are only S3/private work.
  assert.deepEqual(pushedTasks(fx.sender)[STRANGER],["t_pr_st_90","t_s3_91"]);
});

// ======================= Invariant 3: My Plan / Vše / Sdílené membership =======================
/** Membership semantics of every personal / global scope for one actor, derived from live DB rows. */
function checkMembership(fx,u){
  const m=current(fx),A=fx.authority;
  const mineAll=m.mine(u).map(rid).sort(),mineOpen=m.mine(u).filter(t=>t.status==="open").map(rid).sort();
  const readableTasks=m.readable(u).filter(e=>e.kind==="task");
  const isPrivate=e=>m.kinds.get(e.area).kind==="private";
  const sharedReadable=readableTasks.filter(t=>!isPrivate(t)).map(rid).sort();
  const privateReadable=readableTasks.filter(isPrivate).map(rid).sort();
  // My Plan (scoped list): exactly my private work plus work assigned to me (editor/admin)
  assert.deepEqual(idsOf(A.readScopedOffsetPage(u,"my-plan",100,0)),mineAll,`${u}: My Plan list`);
  const today=idsOf(A.readMyPlanDayTaskPage(u,"all","today",TODAY,null,100,0));
  const upcoming=idsOf(A.readMyPlanDayTaskPage(u,"all","upcoming",TODAY,DAYS_AHEAD,100,0));
  for(const id of [...today,...upcoming,...idsOf(A.readMyPlanTwoDayTaskPage(u,"all",TODAY,TOMORROW,100,0,0))])
    assert.ok(mineOpen.includes(id),`${u}: My Plan day view contains ${id}, which is not my open work`);
  assert.equal(new Set([...today,...upcoming]).size,[...today,...upcoming].length,`${u}: a task is in two day buckets`);
  for(const f of ["personal","shared"])
    for(const id of idsOf(A.readMyPlanDayTaskPage(u,f,"today",TODAY,null,100,0)))
      assert.ok(mineOpen.includes(id),`${u}: My Plan(${f}) contains ${id}`);
  // Vše = every authorized task (incl. unassigned / other-assigned shared); Osobní = private; Sdílené = shared only
  assert.deepEqual(idsOf(A.readGlobalTaskPage(u,"all",100,0)),[...privateReadable,...sharedReadable].sort(),`${u}: Vše`);
  assert.deepEqual(idsOf(A.readGlobalTaskPage(u,"personal",100,0)),privateReadable,`${u}: Osobní`);
  assert.deepEqual(idsOf(A.readGlobalTaskPage(u,"shared",100,0)),sharedReadable,`${u}: Sdílené`);
  assert.deepEqual(idsOf(A.readScopedOffsetPage(u,"shared",100,0)),sharedReadable,`${u}: shared scoped list`);
  assert.ok(!idsOf(A.readGlobalTaskPage(u,"shared",100,0)).some(id=>/^t_pr_/.test(id)),`${u}: Sdílené contains private work`);
  return {mineOpen,mineAll,sharedReadable,privateReadable};
}
test("3. My Plan = own private + assigned-to-me shared (editor/admin); Vše = everything authorized; Sdílené has no private",async()=>{
  const fx=await getBase(),A=fx.authority;
  for(const u of ACTORS)checkMembership(fx,u);
  // Pinned role semantics from the canonical data
  const mine=u=>idsOf(A.readScopedOffsetPage(u,"my-plan",100,0));
  assert.ok(mine(EDITOR).includes("t_s1_01")&&mine(EDITOR).includes("t_s1_07"),"editor's assigned S1 tasks (direct and via project) are in My Plan");
  for(const id of ["t_s1_02","t_s1_03","t_s1_08","t_s1_09","t_s1_10"])
    assert.ok(!mine(EDITOR).includes(id),`${id}: other-assigned / unassigned / project-without-my-assignee never reaches the editor's My Plan`);
  assert.ok(idsOf(A.readGlobalTaskPage(EDITOR,"all",100,0)).includes("t_s1_03"),"Vše includes the unassigned shared task");
  assert.deepEqual(mine(VIEWER).filter(id=>!id.startsWith("t_pr_vw")),[],"a viewer has no shared work in My Plan");
  assert.deepEqual(mine(OWNER).filter(id=>id.startsWith("t_s")),
    ["t_s1_02","t_s1_06","t_s1_09","t_s1_92","t_s2_01","t_s2_03","t_s2_91"],"admin sees exactly the work assigned to the admin");
  assert.deepEqual(mine(STRANGER).filter(id=>id.startsWith("t_s")),["t_s3_01","t_s3_03","t_s3_91"]);
});

// ===================== Invariant 4: cross-channel consistency, paging, no duplicates =====================
const PROJ_RE=/p_(?:pr_(?:ow|ed|vw|st)|s[123])_\d\d/g;
const projectIdsIn=json=>[...new Set(json.match(PROJ_RE)??[])].sort();
/** Every array of rows must be duplicate-free (also across nested pages). A row WITHOUT an identity is itself a
 * failure (it would otherwise silently escape the duplicate check). Plain scalar arrays are compared as values. */
function duplicates(value,at="$",out=[]){
  if(Array.isArray(value)){
    const keys=value.map(v=>{
      if(v===null||typeof v!=="object")return typeof v==="string"||typeof v==="number"?String(v):null;
      const k=v.kind&&v.item?v.kind+":"+v.item.id:(v.taskId??v.id??v.attentionKey??v.areaId??v.targetId??null);
      return typeof k==="string"?k:null;
    });
    const seen=new Set();
    keys.forEach((k,i)=>{
      if(k===null){out.push(at+"["+i+"] row without an identity");return;}
      if(seen.has(k))out.push(at+" "+k);seen.add(k);
    });
    value.forEach((v,i)=>duplicates(v,at+"["+i+"]",out));
  }else if(value&&typeof value==="object")for(const [k,v] of Object.entries(value))duplicates(v,at+"."+k,out);
  return out;
}
/** Walk a paged read to exhaustion with a tiny page size. */
function walk(read,rows,limit){
  const seen=[];
  for(let offset=0,guard=0;guard<80;guard++){
    const page=read(limit,offset);
    assert.ok(page,"paged read refused mid-walk");
    seen.push(...rows(page));
    if(!page.hasMore)return seen;
    offset+=limit;
  }
  throw new Error("paging did not terminate");
}
test("4. cross-channel consistency per actor: Vše = search = combined, My Plan >= Attention >= push, AI within its sources; paging stable, no duplicates",async()=>{
  const fx=await getBase(),m=current(fx),A=fx.authority;
  for(const u of ACTORS){
    const readable=m.readable(u),G=readable.filter(e=>e.kind==="task").map(rid).sort();
    const GP=readable.filter(e=>e.kind==="project").map(rid).sort(),GN=readable.filter(e=>e.kind==="note").map(rid).sort();
    const mineOpen=m.mine(u).filter(t=>t.status==="open").map(rid);
    // global index families agree with each other and with the independently derived authorization
    for(const scope of ALL_SCOPES){
      const kind=a=>scope==="all"||m.kinds.get(a).kind===(scope==="personal"?"private":"shared");
      const t=readable.filter(e=>e.kind==="task"&&kind(e.area)).map(rid).sort();
      const p=readable.filter(e=>e.kind==="project"&&kind(e.area)).map(rid).sort();
      const n=readable.filter(e=>e.kind==="note"&&kind(e.area)).map(rid).sort();
      const comb=JSON.stringify(must(A.readGlobalCombinedPage(u,scope,100,{projects:0,tasks:0,notes:0}),`${u}/${scope} combined`).items);
      assert.deepEqual(idsOf(A.readGlobalTaskPage(u,scope,100,0)),t,`${u}/${scope}: global tasks`);
      assert.deepEqual(projectIdsIn(JSON.stringify(A.readGlobalProjectPage(u,scope,100,0))),p,`${u}/${scope}: global projects`);
      assert.deepEqual(noteIdsIn(JSON.stringify(A.readGlobalNotePage(u,scope,100,0))),n,`${u}/${scope}: global notes`);
      assert.deepEqual([taskIdsIn(comb),projectIdsIn(comb),noteIdsIn(comb)],[t,p,n],`${u}/${scope}: combined = task+project+note indexes`);
      const found=JSON.stringify(must(A.readAuthorizedTitleSearchPage(u,scope,"SNT",50,0),`${u}/${scope} search`).items);
      assert.deepEqual([taskIdsIn(found),projectIdsIn(found),noteIdsIn(found)],[t,p,n],`${u}/${scope}: title search "SNT" = Vše/Osobní/Sdílené`);
      assert.deepEqual(idsOf(must(A.readAuthorizedTitleSearchPage(u,scope,"SNT task",50,0),`${u}/${scope} narrow search`).items),t,`${u}/${scope}: narrower query`);
      for(const part of [A.readGlobalTaskPage(u,scope,100,0),A.readGlobalCombinedPage(u,scope,100,{projects:0,tasks:0,notes:0}),
        A.readAuthorizedTitleSearchPage(u,scope,"SNT",50,0)])
        assert.deepEqual(duplicates(part),[],`${u}/${scope}: duplicate rows`);
    }
    // counts agree with the lists they summarize
    const home=must(A.readMyPlanHomeSummary(u),`${u} my-plan home`).counts,shared=must(A.readScopedHomeSummary(u,"shared"),`${u} shared home`).counts,pers=must(A.readScopedHomeSummary(u,"personal"),`${u} personal home`).counts;
    const priv=e=>m.kinds.get(e.area).kind==="private";
    assert.deepEqual([home.privateTasks,home.assignedSharedTasks],
      [m.mine(u).filter(priv).length,m.mine(u).filter(t=>!priv(t)).length],`${u}: My Plan home counts`);
    assert.deepEqual([shared.tasks,shared.projects,pers.tasks,pers.projects],
      [readable.filter(e=>e.kind==="task"&&!priv(e)).length,readable.filter(e=>e.kind==="project"&&!priv(e)).length,
       readable.filter(e=>e.kind==="task"&&priv(e)).length,readable.filter(e=>e.kind==="project"&&priv(e)).length],`${u}: scoped home counts`);
    // paging with a tiny page yields exactly the single-page result (counts/hasMore consistent)
    { // tiny-page walks for ALL four identities
      assert.deepEqual(walk((l,o)=>A.readGlobalTaskPage(u,"all",l,o),pg=>pg.tasks.map(rid),3),
        idsOfOrdered(must(A.readGlobalTaskPage(u,"all",100,0),`${u} global tasks`).tasks),`${u}: global task paging`);
      assert.deepEqual(walk((l,o)=>A.readAuthorizedTitleSearchPage(u,"all","SNT",l,o),pg=>pg.items.map(x=>x.kind+":"+x.id),7),
        must(A.readAuthorizedTitleSearchPage(u,"all","SNT",50,0),`${u} search`).items.map(x=>x.kind+":"+x.id),`${u}: search paging`);
      assert.deepEqual(walk((l,o)=>A.readAttentionCandidatePage(u,"all","active",NOW,TZ,l,o),pg=>pg.items.map(x=>x.attentionKey),2),
        must(A.readAttentionCandidatePage(u,"all","active",NOW,TZ,100,0),`${u} attention`).items.map(x=>x.attentionKey),`${u}: attention paging`);
      {
        const seen=[];let pos={projects:0,tasks:0,notes:0};
        for(let g=0;g<80;g++){
          const pg=must(A.readGlobalCombinedPage(u,"all",5,pos),`${u} combined paging`);
          seen.push(...pg.items.map(x=>x.kind+":"+x.item.id));
          if(!pg.hasMore)break;pos=pg.nextPositions;
        }
        assert.deepEqual(seen,must(A.readGlobalCombinedPage(u,"all",100,{projects:0,tasks:0,notes:0}),`${u} combined`).items.map(x=>x.kind+":"+x.item.id),`${u}: combined paging`);
      }
    }
    // My Plan >= Attention (active+hidden) >= push recipients
    const attActive=idsOf(A.readAttentionCandidatePage(u,"all","active",NOW,TZ,100,0));
    const attHidden=idsOf(A.readAttentionCandidatePage(u,"all","hidden",NOW,TZ,100,0));
    const today=idsOf(A.readMyPlanDayTaskPage(u,"all","today",TODAY,null,100,0)),upcoming=idsOf(A.readMyPlanDayTaskPage(u,"all","upcoming",TODAY,DAYS_AHEAD,100,0));
    for(const id of [...attActive,...attHidden])assert.ok(mineOpen.includes(id),`${u}: Attention item ${id} is not my open work`);
    for(const id of attActive)assert.ok([...today,...upcoming].includes(id),`${u}: Attention item ${id} is missing from My Plan`);
    assert.deepEqual(attActive.filter(id=>attHidden.includes(id)),[],`${u}: an item is both active and hidden`);
    for(const id of pushedTasks(fx.sender)[u]??[]){
      assert.ok(attActive.includes(id),`${u}: pushed ${id} is not an active Attention item`);
      assert.ok(id.endsWith("90")||/_9[1-3]$/.test(id),`${u}: push for baselined work ${id}`);
    }
    // AI bundle: only items present in its source channels
    const b=(p,s)=>idsOf(A.resolveContextBundle(u,bundleReq(p,s)));
    const twoDay=idsOf(A.readMyPlanTwoDayTaskPage(u,"all",TODAY,TOMORROW,100,0,0));
    for(const id of b("what_matters","my-plan"))assert.ok([...attActive,...today].includes(id),`${u}: what_matters ${id} outside attention+today`);
    for(const id of b("plan_today","my-plan"))assert.ok([...today,...twoDay,...attActive].includes(id),`${u}: plan_today ${id} outside its sources`);
    for(const s of ALL_SCOPES)assert.deepEqual(b("find",s),idsOf(A.readAuthorizedTitleSearchPage(u,s,"SNT",50,0).items),`${u}: AI find/${s} = title search`);
    for(const s of ["personal","shared"]){
      const allowedForScope=new Set(m.mine(u).map(rid));
      for(const id of b("what_matters",s))assert.ok(allowedForScope.has(id),`${u}: what_matters/${s} contains ${id}, not my work`);
      // plan_today/personal|shared is a subset of my work of exactly that kind (no private in shared, no shared in personal)
      const planned=must(A.resolveContextBundle(u,bundleReq("plan_today",s)),`${u} plan_today/${s}`);
      for(const item of planned.items){
        assert.ok(allowedForScope.has(item.id),`${u}: plan_today/${s} contains ${item.id}, not my work`);
        assert.equal(item.areaKind,s==="personal"?"private":"shared",`${u}: plan_today/${s} item ${item.id} has the wrong area kind`);
      }
      const myPlanPlanned=new Set(idsOf(must(A.resolveContextBundle(u,bundleReq("plan_today","my-plan")),`${u} plan_today/my-plan`)));
      for(const item of planned.items)assert.ok(myPlanPlanned.has(item.id),`${u}: plan_today/${s} item ${item.id} is missing from plan_today/my-plan`);
    }
    for(const part of [A.readAttentionCandidatePage(u,"all","active",NOW,TZ,100,0),A.readMyPlanDayTaskPage(u,"all","today",TODAY,null,100,0),
      A.resolveContextBundle(u,bundleReq("what_matters","my-plan")),A.resolveContextBundle(u,bundleReq("plan_today","my-plan"))])
      assert.deepEqual(duplicates(part),[],`${u}: duplicate rows in My Plan/Attention/AI`);
  }
});
const idsOfOrdered=rows=>rows.map(rid);

// ============================ AI bundle contract: purposes, scopes, provider key set ============================
const VALID_BUNDLES=[["what_matters","my-plan"],["what_matters","personal"],["what_matters","shared"],
  ["plan_today","my-plan"],["plan_today","personal"],["plan_today","shared"],
  ["find","all"],["find","personal"],["find","shared"]];
const INVALID_BUNDLES=[["what_matters","all"],["plan_today","all"],["find","my-plan"],
  ["what_matters","bogus"],["bogus","all"]];
const PROVIDER_TOP_KEYS=["bundleVersion","evaluationDate","generatedAtMs","items","purpose","revision","scope","timeZone","truncated"];
const PROVIDER_ITEM_KEYS=["areaKind","assignedToMe","attention","body","bodyTruncated","dueOn","id","kind","provenance","title","whenOn"];
const PROVIDER_ATTENTION_KEYS=["lifecycle","relevantOn","ruleId","severity"];
const PROVIDER_PROVENANCE_KEYS=["revision","source"];
const FORBIDDEN_PROVIDER_KEYS=["witness","linearization","areaEpochs","noteAreaEpochs","areaId","projectId","parentId",
  "assignee","assigneeUserId","userId","actorUserId","ownerUserId","noteGuards","snoozedUntilMs","lifecycleRevision","attentionKey"];
const keysOf=(value,out=new Set())=>{
  if(Array.isArray(value))value.forEach(v=>keysOf(v,out));
  else if(value&&typeof value==="object")for(const [k,v] of Object.entries(value)){out.add(k);keysOf(v,out);}
  return out;
};
test("9. AI bundle: every valid purpose x scope answers, invalid combinations are refused, and the provider payload has an exact key set",async()=>{
  const fx=await getBase(),A=fx.authority;
  let sawAttention=false,sawAssigned=false,sawWhen=false,sawBody=false,rawBundles=0;
  for(const u of ACTORS){
    for(const [p,sc] of VALID_BUNDLES){
      const bundle=A.resolveContextBundle(u,bundleReq(p,sc));
      assert.ok(bundle,`${u} x ${p}/${sc} returned null (a valid purpose x scope combination was refused)`);
      assert.ok(bundle.witness&&typeof bundle.witness==="object","the internal bundle keeps its witness (positive control for the strip)");
      const json=serializeTargetContextBundleForProvider(bundle);
      assert.ok(json,`${u} x ${p}/${sc}: the provider serialization returned null`);
      const parsed=JSON.parse(json);
      assert.deepEqual(Object.keys(parsed).sort(),PROVIDER_TOP_KEYS,`${u} x ${p}/${sc}: provider payload top-level keys`);
      for(const item of parsed.items){
        const extra=Object.keys(item).filter(k=>!PROVIDER_ITEM_KEYS.includes(k));
        assert.deepEqual(extra,[],`${u} x ${p}/${sc}: provider item ${item.id} carries keys outside the allowed set`);
        for(const k of ["areaKind","id","kind","provenance","title"])assert.ok(k in item,`${u} x ${p}/${sc}: item ${item.id} lacks ${k}`);
        assert.deepEqual(Object.keys(item.provenance).sort(),PROVIDER_PROVENANCE_KEYS);
        if(item.attention){sawAttention=true;assert.deepEqual(Object.keys(item.attention).sort(),PROVIDER_ATTENTION_KEYS);}
        if(item.assignedToMe!==undefined){sawAssigned=true;assert.equal(item.assignedToMe,true);}
        if(item.whenOn!==undefined)sawWhen=true;
      }
      const present=keysOf(parsed);
      assert.deepEqual(FORBIDDEN_PROVIDER_KEYS.filter(k=>present.has(k)),[],`${u} x ${p}/${sc}: forbidden key reaches the provider`);
      for(const word of ["witness","linearization","areaEpochs","noteAreaEpochs"])
        assert.ok(!json.includes(word),`${u} x ${p}/${sc}: "${word}" appears in the provider JSON`);
      // R2d.4j: bodies only for note items of find, each one the actor can read via the authorized note read
      if(p!=="find")assert.ok(!json.includes("BODY-SENTINEL"),`${u} x ${p}/${sc}: task-only purpose carries a body`);
      for(const item of parsed.items){
        if(item.kind!=="note")assert.ok(!("body" in item)&&!("bodyTruncated" in item),`${u} x ${p}/${sc}: non-note ${item.id} carries a body`);
        else{
          const r=A.readAuthorizedNote(u,item.id);
          assert.ok(r,`${u} x ${p}/${sc}: bundle lists note ${item.id} the actor cannot read`);
          assert.equal(item.body,r.note?.body??r.body,`${u} x ${p}/${sc}: body of ${item.id} differs from the authorized read`);
        }
      }
      for(const n of noteIdsIn(json.replaceAll(/BODY-SENTINEL (n_\w+)/g,"$1")))
        assert.ok(A.readAuthorizedNote(u,n),`${u} x ${p}/${sc}: payload mentions unreadable note ${n}`);
      if(p==="find")sawBody||=json.includes("BODY-SENTINEL");
      rawBundles++;
    }
    for(const [p,sc] of INVALID_BUNDLES)
      assert.equal(A.resolveContextBundle(u,bundleReq(p,sc)),null,`${u} x ${p}/${sc}: an invalid purpose x scope combination was answered`);
    // malformed requests are refused as well: unknown key, missing query for find, query on a non-find purpose, maxItems range
    for(const bad of [{...bundleReq("find","all"),query:null},{...bundleReq("what_matters","my-plan"),query:"SNT"},
      {...bundleReq("find","all"),maxItems:0},{...bundleReq("find","all"),maxItems:51},{...bundleReq("find","all"),extra:1},
      {...bundleReq("find","all"),timeZone:"Not/AZone"}])
      assert.equal(A.resolveContextBundle(u,bad),null,`${u}: malformed bundle request ${JSON.stringify(bad)} was answered`);
  }
  assert.equal(rawBundles,ACTORS.length*VALID_BUNDLES.length);
  assert.ok(sawBody,"find bundles really carried authorized note bodies");
  assert.ok(sawAttention&&sawAssigned&&sawWhen,"the key-set check really exercised attention, assignedToMe and whenOn items");
});

// ------------------------------------- write helpers -------------------------------------
const {previewTargetNoteWrite}=await import("../lib/target-note-write-contract.ts");
const gen=fx=>fx.stage.restoreGeneration;
const areaOfTask=(fx,id)=>fx.db.prepare("SELECT COALESCE(t.area_id,p.area_id) AS a FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(id)?.a;
const areaOfNote=(fx,id)=>fx.db.prepare("SELECT COALESCE(n.area_id,p.area_id) AS a FROM notes n LEFT JOIN projects p ON p.id=n.project_id WHERE n.id=?").get(id)?.a;
const planEpoch=(fx,u)=>fx.db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id=?").get(u)?.revision??0;
const attEpoch=(fx,u)=>fx.db.prepare("SELECT revision FROM personal_attention_epochs WHERE user_id=?").get(u)?.revision??0;
const planRev=(fx,u,t)=>fx.db.prepare("SELECT revision FROM personal_task_plans WHERE user_id=? AND task_id=?").get(u,t)?.revision??null;
const stateRev=(fx,u,t,rule,on)=>fx.db.prepare("SELECT revision FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?").get(u,t,rule,on)?.revision??null;
/** Writer-capable member of an Area, used only to mint a VALID command that an attacker then replays. */
function writerFor(fx,area){
  const m=current(fx);
  const w=ACTORS.find(u=>["owner","admin","editor"].includes(m.roleIn(u,area)));
  assert.ok(w,`no legitimate writer for ${area}`);return w;
}
function taskBase(fx,previewer,taskId){
  const pv=fx.authority.previewTaskTitleEdit(token(fx,previewer),{taskId});
  assert.equal(pv.ok,true,`${previewer} preview of ${taskId}: ${JSON.stringify(pv)}`);
  return {commandId:randomUUID(),taskId,expectedRevision:pv.snapshotRevision,
    writeAreaId:areaOfTask(fx,taskId),restoreGeneration:gen(fx)};
}
/** All writers as thunks: `by` submits, `previewer` mints a valid CAS input. */
function writerSet(fx,by,previewer,victim){
  const A=fx.authority,tok=token(fx,by);
  const b=()=>taskBase(fx,previewer,victim.taskId);
  const note=()=>{const p=previewTargetNoteWrite(fx.db,previewer,victim.noteId);
    assert.equal(p.ok,true,`${previewer} note preview ${victim.noteId}`);const {ok:_o,...f}=p;return f;};
  return {
    title:()=>A.updateTaskTitle(tok,{...b(),title:"HACKED"}),
    status:()=>A.changeTemporalTaskStatus(tok,{...b(),status:"completed"}),
    dueOn:()=>A.changeTemporalDueOn(tok,{...b(),dueOn:"2024-12-31"}),
    whenOn:()=>A.changePersonalWhen(tok,{...b(),whenOn:"2024-12-30",expectedPrivateEpoch:planEpoch(fx,by),
      expectedPlanRevision:planRev(fx,by,victim.taskId)}),
    attention:()=>A.changeAttentionLifecycle(tok,{...b(),ruleId:"deadline_overdue",occurrenceOn:OVERDUE,
      action:"dismiss",snoozedUntilMs:null,expectedAttentionEpoch:attEpoch(fx,by),
      expectedStateRevision:stateRev(fx,by,victim.taskId,"deadline_overdue",OVERDUE),timeZone:TZ}),
    taskDelete:()=>A.deleteTask(tok,b()),
    noteEdit:()=>A.updateNote(tok,{...note(),noteId:victim.noteId,title:"HACKED",body:"HACKED",commandId:randomUUID()}),
    noteDelete:()=>A.deleteNote(tok,{...note(),noteId:victim.noteId,commandId:randomUUID()}),
    noteCreate:()=>A.changeNoteLifecycle(tok,{kind:"create",noteId:"n_zz_"+randomUUID().slice(0,8),commandId:randomUUID(),
      restoreGeneration:gen(fx),areaId:victim.area,projectId:null,title:"HACKED",body:"HACKED"}),
    membership:()=>A.applyMembershipCommand(tok,{action:"set_role",role:"admin",targetUserId:by,areaId:victim.area,
      writeAreaId:victim.area,commandId:randomUUID(),restoreGeneration:gen(fx),
      expectedPolicyRevision:fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id=?").get(victim.area).r}),
  };
}
/** Order-stable fingerprint of EVERY table of the store, discovered from sqlite_master (so a table added by a
 * later schema version is covered automatically): all domain tables, identities/workspaces, epochs, audits,
 * receipts, delivery tables, tombstones/journals and all metadata (receipt) rows. Nothing is excluded: no
 * table has a volatile session-touch column (staging_sessions only carries created/expires/revoked), and the
 * in-memory authority tokens never touch the file. Rows are sorted in JS because most tables are WITHOUT ROWID
 * (the previous `ORDER BY rowid` threw on them and silently compared the constant "missing"). */
const FINGERPRINT_EXCLUDED=Object.freeze([]);
function fingerprint(fx){
  const h=createHash("sha256");
  const names=fx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(r=>r.name).filter(n=>!FINGERPRINT_EXCLUDED.includes(n));
  assert.ok(names.length>=30,"fingerprint must see the whole schema, saw "+names.length);
  for(const t of names){
    const rows=fx.db.prepare(`SELECT * FROM "${t}"`).all().map(r=>JSON.stringify(r)).sort();
    h.update(t+"\0"+rows.length+"\0"+rows.join("\n"));
  }
  return h.digest("hex");
}

// ================ Invariant 2: viewer reads shared, is never "mine", and can never write ================
test("2a. viewer reads shared content but is absent from My Plan, Attention, push and the AI my-plan purposes",async()=>{
  const fx=await getBase(),A=fx.authority;
  const S1T=["t_s1_01","t_s1_02","t_s1_03","t_s1_04","t_s1_05","t_s1_06","t_s1_07","t_s1_08","t_s1_09","t_s1_10","t_s1_91","t_s1_92","t_s1_93"];
  // reads: every shared surface
  assert.deepEqual(idsOf(A.readGlobalTaskPage(VIEWER,"shared",100,0)),S1T);
  assert.deepEqual(projectIdsIn(JSON.stringify(A.readGlobalProjectPage(VIEWER,"shared",100,0))),["p_s1_01","p_s1_02"]);
  assert.deepEqual(noteIdsIn(JSON.stringify(A.readGlobalNotePage(VIEWER,"shared",100,0))),["n_s1_01","n_s1_02"]);
  assert.ok(A.readAuthorizedNote(VIEWER,"n_s1_01"),"viewer reads a shared note");
  assert.ok(A.readAuthorizedProjectTasks(VIEWER,"p_s1_01",100,0));
  assert.deepEqual(idsOf(A.resolveContextBundle(VIEWER,bundleReq("find","shared"))),S1T);
  assert.deepEqual(idsOf(A.readAuthorizedTitleSearchPage(VIEWER,"shared","SNT",50,0).items),S1T);
  // never "mine": shared work is absent from every personal channel
  const s1=/t_s1_/;
  assert.ok(!s1.test(JSON.stringify(A.readScopedOffsetPage(VIEWER,"my-plan",100,0))));
  for(const f of ALL_SCOPES)for(const v of ["active","hidden"])
    assert.deepEqual(idsOf(A.readAttentionCandidatePage(VIEWER,f,v,NOW,TZ,100,0)).filter(id=>s1.test(id)),[],`attention ${f}/${v}`);
  for(const [p,s] of [["what_matters","my-plan"],["what_matters","personal"],["what_matters","shared"],
    ["plan_today","my-plan"],["plan_today","personal"],["plan_today","shared"]])
    assert.deepEqual(idsOf(A.resolveContextBundle(VIEWER,bundleReq(p,s))).filter(id=>s1.test(id)),[],`AI ${p}/${s}`);
  assert.equal(A.readMyPlanHomeSummary(VIEWER).counts.assignedSharedTasks,0);
  assert.deepEqual(pushedTasks(fx.sender)[VIEWER],["t_pr_vw_90"],"the viewer is pushed only its own private work");
  // The attention preview of a shared task is refused for a viewer (no lifecycle control on others' work)
  assert.equal(A.previewAttentionCommand(VIEWER,"t_s1_03","deadline_overdue",OVERDUE,NOW),null);
  assert.deepEqual(A.previewPersonalWhen(VIEWER,"t_s1_03"),null,"a viewer gets no planned-date CAS input for shared work");
});

test("2b. every writer refuses the viewer and every cross-Area attacker; legitimate writers still succeed (controls)",async()=>{
  const fx=fixture(),A=fx.authority;
  fx.extraTokens=[];
  // ---- controls: a legitimate editor/admin succeeds with the very same command shapes ----
  {
    const w=writerSet(fx,EDITOR,EDITOR,{taskId:"t_s1_07",noteId:"n_s1_02",area:"a_s1"});
    const w2=writerSet(fx,EDITOR,EDITOR,{taskId:"t_s1_04",noteId:"n_s1_02",area:"a_s1"});
    for(const [name,run] of [["title",w.title],["whenOn",w.whenOn],["attention",w.attention],["dueOn",w2.dueOn],
      ["status",w2.status],["noteEdit",w.noteEdit],["noteCreate",w.noteCreate]]){
      const res=run();assert.equal(res.ok,true,`control ${name}: ${JSON.stringify(res)}`);
    }
    const bt=writerSet(fx,EDITOR,EDITOR,{taskId:"t_s1_01",noteId:"n_s1_01",area:"a_s1"});
    assert.equal(bt.taskDelete().ok,true,"control taskDelete");
    assert.equal(bt.noteDelete().ok,true,"control noteDelete");
    const own=A.changeNotificationSettings(token(fx,VIEWER),settingsCommand(fx,VIEWER,{attentionPush:true}));
    assert.equal(own.ok,true,"a viewer may change their OWN settings: "+JSON.stringify(own));
  }
  // ---- attacks ----
  const cases=[
    [VIEWER,"t_s1_03","n_s1_02","a_s1"],[VIEWER,"t_s1_02","n_s1_02","a_s1"],[VIEWER,"t_s1_08","n_s1_02","a_s1"],
    [VIEWER,"t_pr_ed_01","n_pr_ed_01","a_pr_ed"],[VIEWER,"t_s3_01","n_s3_01","a_s3"],
    [EDITOR,"t_s2_01","n_s2_01","a_s2"],[EDITOR,"t_pr_ow_01","n_pr_ow_01",privAreaId(fx,OWNER)],
    [EDITOR,"t_s3_01","n_s3_01","a_s3"],
    [STRANGER,"t_s1_03","n_s1_02","a_s1"],[STRANGER,"t_s2_01","n_s2_01","a_s2"],
    [OWNER,"t_s3_01","n_s3_01","a_s3"],[OWNER,"t_pr_ed_01","n_pr_ed_01","a_pr_ed"],
  ];
  const before=fingerprint(fx);
  const ownerSettings=JSON.stringify(A.readNotificationSettings(OWNER));
  const outcomes=[];
  for(const [by,taskId,noteId,area] of cases){
    const w=writerSet(fx,by,writerFor(fx,area),{taskId,noteId,area});
    for(const [name,run] of Object.entries(w)){
      const res=run();
      outcomes.push([by,area,name,res]);
      assert.equal(res.ok,false,`${by} x ${name} on ${taskId}/${noteId} (${area}) was NOT refused: ${JSON.stringify(res)}`);
    }
  }
  assert.equal(fingerprint(fx),before,"refused writes changed the store");
  // A member WITHOUT the assignment: the personal-per-assignee writers (Attention lifecycle, planned date) refuse
  // an editor on work assigned to the admin (t_s1_02) and on unassigned / project work, although the editor
  // legitimately edits such titles. The shape is the one the legitimate assignee uses (CAS minted by the admin).
  for(const [taskId,assignee] of [["t_s1_02",OWNER],["t_s1_03",null],["t_s1_08",null],["t_s1_09",OWNER]]){
    const w=writerSet(fx,EDITOR,assignee??OWNER,{taskId,noteId:"n_s1_02",area:"a_s1"});
    for(const name of ["attention","whenOn"]){
      const res=w[name]();
      assert.equal(res.ok,false,`member-non-assignee EDITOR x ${name} on ${taskId} (assignee ${assignee}) was NOT refused: ${JSON.stringify(res)}`);
    }
  }
  assert.equal(fingerprint(fx),before,"member-non-assignee lifecycle attempts changed the store");
  // settings / push targets of ANOTHER identity: the commands carry no target identity at all
  const forged=[{...settingsCommand(fx,OWNER),actorUserId:OWNER},{...settingsCommand(fx,OWNER),userId:OWNER},
    {...settingsCommand(fx,OWNER),targetUserId:OWNER}];
  for(const c of forged)assert.deepEqual(A.changeNotificationSettings(token(fx,VIEWER),c),{ok:false,reason:"invalid_request"});
  assert.deepEqual(A.changePushTarget(token(fx,VIEWER),{commandId:randomUUID(),action:"register",userId:OWNER,
    endpointHash:sha("x"),expectedNotificationEpoch:0,restoreGeneration:gen(fx)}),{ok:false,reason:"invalid_request"});
  assert.equal(JSON.stringify(A.readNotificationSettings(OWNER)),ownerSettings,"the owner's settings moved");
  // read-only and revoked tokens cannot write either
  const ro=A.issue(EDITOR).sessionToken;
  const roCmd=taskBase(fx,EDITOR,"t_s1_04");
  assert.equal(A.updateTaskTitle(ro,{...roCmd,title:"HACKED"}).ok,false);
  const rev=A.issueWritable(EDITOR).sessionToken;A.revoke(rev);
  assert.equal(A.updateTaskTitle(rev,{...taskBase(fx,EDITOR,"t_s1_04"),title:"HACKED"}).ok,false);
  assert.equal(A.revokeActor(EDITOR)>=0,true);
  assert.deepEqual(A.updateTaskTitle(token(fx,EDITOR),{...roCmd,title:"HACKED"}).ok,false,"revokeActor killed the cached editor token");
  assert.equal(fingerprint(fx),before);
  // no existence oracle in the writers: a foreign EXISTING task and a NONEXISTENT one are refused identically
  const probeWrite=(taskId)=>{
    const c={commandId:randomUUID(),taskId,expectedRevision:"a".repeat(64),writeAreaId:"a_s1",restoreGeneration:gen(fx)};
    const t=token(fx,STRANGER);
    return [A.updateTaskTitle(t,{...c,title:"x"}),A.changeTemporalTaskStatus(t,{...c,status:"completed"}),
      A.changeTemporalDueOn(t,{...c,dueOn:"2024-12-31"}),A.deleteTask(t,c)];
  };
  assert.deepEqual(probeWrite("t_s1_03"),probeWrite("t_zz_nonexistent"),"writer refusal differs for existing foreign vs nonexistent task");
});

// =========================== Invariant 5: no existence / count oracle ===========================
const FLOODS={
  m1:[{area:"a_s2",user:OWNER,tag:"m1a"},{area:"OWNER_PRIVATE",user:OWNER,tag:"m1b"}],
  m2:[{area:"a_s3",user:STRANGER,tag:"m2a"},{area:"a_pr_st",user:STRANGER,tag:"m2b"}],
  m3:[{area:"a_s1",user:EDITOR,tag:"m3a"},{area:"a_pr_ed",user:EDITOR,tag:"m3b"},{area:"a_pr_vw",user:VIEWER,tag:"m3c"}],
};
const floodIds=tag=>({tasks:[1,2,3,4,5,6].map(n=>`t_zz_${tag}_0${n}`),projects:[1,2].map(n=>`p_zz_${tag}_0${n}`),
  notes:[1,2,3,4].map(n=>`n_zz_${tag}_0${n}`)});
const allFloodTags=Object.values(FLOODS).flat().map(f=>f.tag);
/** N rows (tasks of every kind, projects, notes, personal plans, lifecycle rows) plus real writer
 * traffic (note edit/delete, status change, settings, extra device) in an Area FOREIGN to the actor under test. */
function flood(fx,{area,user,tag}){
  const A=fx.authority,a=area==="OWNER_PRIVATE"?privAreaId(fx,OWNER):area,shared=a in SHARED;
  const {tasks,projects,notes}=floodIds(tag);
  const pi=fx.db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const p of projects)pi.run(p,a,"SNT project "+p);
  const ti=fx.db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  ti.run(tasks[0],a,null,"SNT task "+tasks[0],shared?user:null,OVERDUE);
  ti.run(tasks[1],a,null,"SNT task "+tasks[1],null,OVERDUE);
  ti.run(tasks[2],a,null,"SNT task "+tasks[2],shared?user:null,TODAY);
  ti.run(tasks[3],a,null,"SNT task "+tasks[3],null,OVERDUE);
  ti.run(tasks[4],null,projects[0],"SNT task "+tasks[4],shared?user:null,OVERDUE);
  ti.run(tasks[5],a,null,"SNT task "+tasks[5],null,TOMORROW);
  fx.db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1718000000000 WHERE id=?").run(tasks[3]);
  const ni=fx.db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  ni.run(notes[0],a,null,"SNT note "+notes[0],"BODY-SENTINEL "+notes[0]);
  ni.run(notes[1],null,projects[0],"SNT note "+notes[1],"BODY-SENTINEL "+notes[1]);
  ni.run(notes[2],a,null,"SNT note "+notes[2],"BODY-SENTINEL "+notes[2]);
  ni.run(notes[3],a,null,"SNT note "+notes[3],"BODY-SENTINEL "+notes[3]);
  fx.db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)").run(user,shared?tasks[0]:tasks[1],"2024-06-14");
  fx.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES (?,?,?,?,'snoozed',?)")
    .run(user,tasks[0],"deadline_overdue",OVERDUE,NOW+86_400_000);
  // real writers on the same foreign data
  const note=previewTargetNoteWrite(fx.db,user,notes[0]);assert.equal(note.ok,true);
  assert.equal(A.updateNote(token(fx,user),{expectedRevision:note.expectedRevision,writeAreaId:note.writeAreaId,
    restoreGeneration:note.restoreGeneration,noteId:notes[0],title:"SNT note "+notes[0],body:"BODY-SENTINEL edited "+notes[0],
    commandId:randomUUID()}).ok,true);
  const del=previewTargetNoteWrite(fx.db,user,notes[2]);assert.equal(del.ok,true);
  assert.equal(A.deleteNote(token(fx,user),{expectedRevision:del.expectedRevision,writeAreaId:del.writeAreaId,
    restoreGeneration:del.restoreGeneration,noteId:notes[2],commandId:randomUUID()}).ok,true);
  if(shared)assert.equal(A.changeTemporalTaskStatus(token(fx,user),{...taskBase(fx,user,tasks[2]),status:"completed"}).ok,true);
  const limit=fx.db.prepare("SELECT daily_limit AS n FROM personal_notification_settings WHERE user_id=?").get(user).n;
  const set=A.changeNotificationSettings(token(fx,user),settingsCommand(fx,user,{dailyLimit:(limit+1)%11}));
  assert.equal(set.ok,true,JSON.stringify(set));
  const reg=A.changePushTarget(token(fx,user),{commandId:randomUUID(),action:"register",endpointHash:sha(tag+user),
    expectedNotificationEpoch:epochOf(fx,user),restoreGeneration:gen(fx)});
  assert.equal(reg.ok,true,JSON.stringify(reg));
}
/** Probe the not-yet-existing (then existing) foreign ids of the phase being applied. */
const ORACLE=(fx,tags)=>{
  const f=tags.map(floodIds);
  return {scopes:ALL_SCOPES,tasks:["t_s2_01",...f.map(x=>x.tasks[0])],
    projects:f.map(x=>x.projects[0]),
    notes:["n_s2_01",...f.map(x=>x.notes[0])],areas:areaIds(fx),
    queries:["SNT"],mpFilters:["all"],temporal:true,
    bundles:[["what_matters","my-plan"],["plan_today","my-plan"],["find","all"]]};
};
/** Documented channel revisions that legitimately move with FOREIGN activity (none expected; see docs). */
const REVISION_MOVES_WITH_FOREIGN_ACTIVITY=new Set([]);
function identical(fx,actor,before,after,label){
  const moved=CHANNEL_NAMES.filter(ch=>before[ch]!==after[ch]&&!REVISION_MOVES_WITH_FOREIGN_ACTIVITY.has(ch));
  assert.deepEqual(moved,[],`${label}: ${actor} outputs changed after rows foreign to ${actor} were added (existence/count/revision oracle)`);
  const allowed=allowedTokens(fx,actor);
  table(CHANNEL_NAMES.map(c=>[actor,c]),(u,ch)=>assert.deepEqual(foundTokens(fx,after[ch]).filter(t=>!allowed.has(t)),[],
    `${label}: ${u} x ${ch} exposes new foreign rows`));
}
test("5. adding foreign rows leaves every other actor's outputs byte-identical across all channels",async()=>{
  const fx=await getBase();
  fx.extraTokens=allFloodTags.flatMap(t=>Object.values(floodIds(t)).flat());
  const phase=(floods,actors,label)=>{
    const ctx=ORACLE(fx,floods.map(f=>f.tag));
    const pre=Object.fromEntries(actors.map(u=>[u,capture(fx,u,ctx)]));
    floods.forEach(f=>flood(fx,f));
    for(const u of actors)identical(fx,u,pre[u],capture(fx,u,ctx),label);
  };
  phase(FLOODS.m1,[EDITOR,STRANGER],"M1 (S2 + owner private)");
  phase(FLOODS.m2,[OWNER,VIEWER],"M2 (S3 + stranger private)");
  phase(FLOODS.m3,[STRANGER],"M3 (S1 + editor/viewer private)");
  // positive control: the rows really exist for those who may read them
  assert.ok(JSON.stringify(fx.authority.readGlobalTaskPage(OWNER,"all",100,0)).includes("t_zz_m1a_01"));
  assert.ok(JSON.stringify(fx.authority.readGlobalTaskPage(VIEWER,"shared",100,0)).includes("t_zz_m3a_01"));
  assert.ok(!JSON.stringify(fx.authority.readGlobalTaskPage(VIEWER,"all",100,0)).includes("t_zz_m1a_01"));
});

// ============================ Invariant 6: revocation transitions ============================
const policyRev=(fx,area)=>fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id=?").get(area).r;
const membership=(fx,by,action,target,role)=>fx.authority.applyMembershipCommand(token(fx,by),{
  action,targetUserId:target,...(action==="remove"?{}:{role}),areaId:"a_s1",writeAreaId:"a_s1",
  commandId:randomUUID(),restoreGeneration:gen(fx),expectedPolicyRevision:policyRev(fx,"a_s1")});
/** After a transition: re-check the affected actors' channels against the CURRENT rows. */
function recheck(fx,label,actors,gone={}){
  for(const u of actors){
    const ctx=LITE(fx,{tasks:gone.tasks??[],notes:gone.notes??[],projects:gone.projects??[]});
    const cap=capture(fx,u,ctx),allowed=allowedTokens(fx,u);
    for(const ch of CHANNEL_NAMES){
      assert.ok(!cap[ch].includes("THROWN"),`[${label}] ${u} x ${ch} threw`);
      assert.deepEqual(foundTokens(fx,cap[ch]).filter(t=>!allowed.has(t)),[],`[${label}] ${u} x ${ch} still exposes revoked/foreign content`);
      assert.ok(!cap[ch].includes("BODY-SENTINEL")||ch==="note/read"||ch==="ai/context-bundle",`[${label}] ${u} x ${ch} releases a body`);
    }
    for(const t of gone.tasks??[])if(!allowed.has(t))for(const ch of CHANNEL_NAMES)
      assert.ok(!cap[ch].includes(t),`[${label}] ${u} x ${ch} still shows ${t}`);
    checkMembership(fx,u);
  }
}
async function deliver(fx,label){
  const sender=recordingSender();
  await fx.authority.runAttentionPushPass(NOW,sender);
  const m=current(fx);
  for(const c of sender.calls){
    const t=c.payload.url.replace("/?task=","");
    assert.ok(m.mine(c.userId).some(x=>x.id===t&&x.status==="open"),`[${label}] push of ${t} to ${c.userId}, who no longer has it as open work`);
    assert.equal(c.targetId,fx.devices[c.userId]);
  }
  return pushedTasks(sender);
}
test("6. revocation transitions in sequence: every channel is re-checked after each step",async()=>{
  const fx=fixture(),A=fx.authority;
  await armPush(fx);
  fx.extraTokens=["n_zz_x"];
  // Pending (unannounced) work assigned to the editor, one item per step.
  const pending=(id,extra={})=>addTask(fx,{id,area:"a_s1",assignee:EDITOR,due:FRESH,...extra});
  pending("t_s1_94");pending("t_s1_95");pending("t_s1_96");pending("t_s1_97");
  const sync=(u,cursor)=>A.readAuthorizedNoteSync(u,{areaId:"a_s1",limit:100,secret:SECRET,...(cursor?{cursor}:{})});
  const cursors={[EDITOR]:sync(EDITOR).page.cursor,[VIEWER]:sync(VIEWER).page.cursor};
  assert.deepEqual(idsOf(A.readScopedOffsetPage(EDITOR,"my-plan",100,0)).filter(id=>id.startsWith("t_s1")).sort(),
    ["t_s1_01","t_s1_04","t_s1_05","t_s1_07","t_s1_91","t_s1_94","t_s1_95","t_s1_96","t_s1_97"],"precondition: editor holds S1 work");
  recheck(fx,"initial",[EDITOR,VIEWER]);

  // --- step 1: reassign a pending task away from the editor ---
  // Raw SQL on purpose: there is no assignee-change command in the target model yet (the only production writer of
  // assignee_user_id is the membership writer, exercised in steps 4/5); the BEFORE UPDATE trigger still guards it.
  fx.db.prepare("UPDATE tasks SET assignee_user_id=? WHERE id='t_s1_91'").run(OWNER);
  recheck(fx,"reassigned away",[EDITOR],{tasks:["t_s1_91"]});
  for(const f of ALL_SCOPES)for(const v of ["active","hidden"]){
    assert.ok(!idsOf(must(A.readAttentionCandidatePage(EDITOR,f,v,NOW,TZ,100,0),`editor attention ${f}/${v}`)).includes("t_s1_91"),`reassigned task still in the former assignee's Attention ${f}/${v}`);
  }
  assert.ok(idsOf(must(A.readAttentionCandidatePage(OWNER,"all","active",NOW,TZ,100,0),"owner attention")).includes("t_s1_91"),"the new assignee's Attention gains the task");
  assert.ok(A.readAuthorizedNote(EDITOR,"n_s1_02"),"note detail still readable after the reassignment (membership unchanged)");
  assert.ok(A.readAuthorizedProjectTasks(EDITOR,"p_s1_01",100,0)?.ok!==false,"project detail still readable after the reassignment");
  assert.equal(A.previewAttentionCommand(EDITOR,"t_s1_91","deadline_overdue",FRESH,NOW),null,"no Attention CAS input for work reassigned away");
  assert.ok(!idsOf(A.readScopedOffsetPage(EDITOR,"my-plan",100,0)).includes("t_s1_91"));
  assert.ok(idsOf(A.readGlobalTaskPage(EDITOR,"shared",100,0)).includes("t_s1_91"),"still readable in Sdílené (membership unchanged)");
  assert.ok(!idsOf(A.resolveContextBundle(EDITOR,bundleReq("what_matters","my-plan"))).includes("t_s1_91"));
  let pushed=await deliver(fx,"reassigned away");
  assert.ok(!(pushed[EDITOR]??[]).includes("t_s1_91"),"reassigned work was announced to its former assignee");
  assert.ok(!(pushed[VIEWER]??[]).some(t=>t.startsWith("t_s1")));

  // --- step 2: the editor completes a pending task ---
  assert.equal(A.changeTemporalTaskStatus(token(fx,EDITOR),{...taskBase(fx,EDITOR,"t_s1_94"),status:"completed"}).ok,true);
  recheck(fx,"completed",[EDITOR]);
  assert.ok(!idsOf(A.readMyPlanDayTaskPage(EDITOR,"all","today",TODAY,null,100,0)).includes("t_s1_94"));
  assert.ok(!idsOf(A.readAttentionCandidatePage(EDITOR,"all","active",NOW,TZ,100,0)).includes("t_s1_94"));
  pushed=await deliver(fx,"completed");
  assert.ok(!(pushed[EDITOR]??[]).includes("t_s1_94"),"completed work was announced");

  // --- step 3: a shared note is deleted ---
  const del=previewTargetNoteWrite(fx.db,OWNER,"n_s1_01");assert.equal(del.ok,true);
  assert.equal(A.deleteNote(token(fx,OWNER),{expectedRevision:del.expectedRevision,writeAreaId:del.writeAreaId,
    restoreGeneration:del.restoreGeneration,noteId:"n_s1_01",commandId:randomUUID()}).ok,true);
  recheck(fx,"note deleted",[EDITOR,VIEWER],{notes:["n_s1_01"]});
  for(const u of [OWNER,EDITOR,VIEWER]){
    assert.equal(A.readAuthorizedNote(u,"n_s1_01"),null);
    assert.ok(!JSON.stringify(A.readGlobalNotePage(u,"all",100,0)).includes("n_s1_01"));
    assert.ok(!JSON.stringify(A.readAuthorizedTitleSearchPage(u,"all","SNT",50,0)).includes("n_s1_01"));
    assert.ok(!JSON.stringify(A.readAuthorizedProjectStructuralRelations(u,"p_s1_01",50,0)).includes("n_s1_01"));
  }
  // the still-authorized viewer's old cursor yields a content-free tombstone, never a body or title
  const viewerSync=sync(VIEWER,cursors[VIEWER]);
  assert.equal(viewerSync.ok,true,JSON.stringify(viewerSync).slice(0,200));
  assert.ok(viewerSync.page.changes.some(c=>c.kind==="delete"&&c.noteId==="n_s1_01"),"deletion reaches the feed");
  assert.ok(!JSON.stringify(viewerSync.page).includes("BODY-SENTINEL"));
  assert.ok(!JSON.stringify(viewerSync.page).includes("SNT note n_s1_01"),"a tombstone must not carry the deleted note's title");
  const tomb=viewerSync.page.changes.find(c=>c.kind==="delete"&&c.noteId==="n_s1_01");
  assert.deepEqual(Object.keys(tomb).filter(k=>/title|body|text|content/i.test(k)),[],"tombstone has no title/body field");
  cursors[VIEWER]=viewerSync.page.cursor;

  // --- step 4: downgrade editor -> viewer (the writer unassigns their work) ---
  const heldByEditor=fx.db.prepare(`SELECT id,status FROM tasks WHERE assignee_user_id=? ORDER BY id`).all(EDITOR);
  // Documented writer behaviour (lib/target-staging-membership-command.ts header): EVERY task assigned to the demoted
  // user in the Area is unassigned, completed ones included (completion attribution is deferred).
  const openHeld=heldByEditor.map(t=>t.id);
  assert.deepEqual(openHeld,["t_s1_01","t_s1_04","t_s1_05","t_s1_07","t_s1_94","t_s1_95","t_s1_96","t_s1_97"],"precondition: the editor's S1 assignments (open and completed)");
  assert.deepEqual(heldByEditor.filter(t=>t.status==="completed").map(t=>t.id),["t_s1_05","t_s1_94"]);
  const downgrade=membership(fx,OWNER,"set_role",EDITOR,"viewer");
  assert.equal(downgrade.ok,true,JSON.stringify(downgrade));
  assert.equal(downgrade.unassignedTasks,openHeld.length,"the membership writer unassigns exactly the demoted editor's assignments");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee_user_id=?").get(EDITOR).n,0);
  assert.deepEqual(fx.db.prepare(`SELECT id FROM tasks WHERE id IN (${openHeld.map(()=>"?").join(",")}) AND assignee_user_id IS NULL ORDER BY id`).all(...openHeld).map(r=>r.id),openHeld,
    "every unassigned task becomes Nepřiděleno (not reassigned to somebody else)");
  recheck(fx,"downgraded",[EDITOR],{tasks:["t_s1_95","t_s1_96"]});
  assert.deepEqual(idsOf(A.readScopedOffsetPage(EDITOR,"my-plan",100,0)).filter(id=>id.startsWith("t_s1")),[]);
  assert.ok(idsOf(A.readGlobalTaskPage(EDITOR,"shared",100,0)).includes("t_s1_03"),"a viewer still reads shared work");
  for(const f of ALL_SCOPES)for(const v of ["active","hidden"])
    assert.deepEqual(idsOf(must(A.readAttentionCandidatePage(EDITOR,f,v,NOW,TZ,100,0),`downgraded attention ${f}/${v}`)).filter(id=>id.startsWith("t_s1")),[],`downgraded editor keeps S1 work in Attention ${f}/${v}`);
  for(const [p,sc] of VALID_BUNDLES.filter(([p])=>p!=="find"))
    assert.deepEqual(idsOf(must(A.resolveContextBundle(EDITOR,bundleReq(p,sc)),`downgraded AI ${p}/${sc}`)).filter(id=>id.startsWith("t_s1")),[],`downgraded editor keeps S1 work in AI ${p}/${sc}`);
  // detail channels follow the NEW (read-only) role: the viewer still reads the note, the project and its tasks
  assert.ok(A.readAuthorizedNote(EDITOR,"n_s1_02"),"downgraded member still reads the shared note");
  assert.ok(A.readAuthorizedProjectTasks(EDITOR,"p_s1_01",100,0)?.ok!==false,"downgraded member still reads the shared project");
  assert.equal(A.previewAttentionCommand(EDITOR,"t_s1_07","deadline_overdue",OVERDUE,NOW),null,"no Attention CAS input after the downgrade");
  const asViewer=writerSet(fx,EDITOR,OWNER,{taskId:"t_s1_03",noteId:"n_s1_02",area:"a_s1"});
  for(const [name,run] of Object.entries(asViewer))assert.equal(run().ok,false,`downgraded editor still performs ${name}`);
  pushed=await deliver(fx,"downgraded");
  assert.deepEqual((pushed[EDITOR]??[]).filter(t=>t.startsWith("t_s1")),[],"downgraded editor is still announced S1 work");

  // --- step 5: remove the member entirely ---
  assert.deepEqual(sync(EDITOR,cursors[EDITOR]),{ok:false,reason:"resync_required"},"the cursor is bound to the old role: a downgrade forces a resync");
  const reboot=sync(EDITOR);
  assert.equal(reboot.ok,true,"a downgraded member may bootstrap again as a viewer");
  cursors[EDITOR]=reboot.page.cursor;
  assert.equal(sync(EDITOR,cursors[EDITOR]).ok,true);
  assert.equal(membership(fx,OWNER,"remove",EDITOR).ok,true);
  recheck(fx,"member removed",[EDITOR],{tasks:["t_s1_01","t_s1_03","t_s1_95","t_s1_96","t_s1_97"],notes:["n_s1_02"],projects:["p_s1_01"]});
  const after5=CHANNEL_NAMES.map(ch=>capture(fx,EDITOR,LITE(fx,{tasks:["t_s1_03"],notes:["n_s1_02"],projects:["p_s1_01"]}),[ch])[ch]);
  assert.ok(after5.every(j=>!/(?:t|p|n)_s1_\d\d|a_s1/.test(j)),"S1 left in some channel after removal");
  assert.deepEqual(sync(EDITOR,cursors[EDITOR]),{ok:false,reason:"inaccessible"},"old note-sync cursor of a removed member");
  assert.deepEqual(sync(EDITOR),{ok:false,reason:"inaccessible"});
  const asRemoved=writerSet(fx,EDITOR,OWNER,{taskId:"t_s1_03",noteId:"n_s1_02",area:"a_s1"});
  for(const [name,run] of Object.entries(asRemoved))assert.equal(run().ok,false,`removed member still performs ${name}`);
  assert.deepEqual(A.readAuthorizedProjectTasks(EDITOR,"p_s1_01",100,0)?.ok??null,false);
  assert.equal(A.readAuthorizedNote(EDITOR,"n_s1_02"),null,"removed member reads no note");
  assert.deepEqual(A.readSharedTaskDetail(EDITOR,"t_s1_03"),{ok:false,reason:"unavailable"},"removed member reads no shared task");
  for(const f of ALL_SCOPES)for(const v of ["active","hidden"])
    assert.deepEqual(idsOf(must(A.readAttentionCandidatePage(EDITOR,f,v,NOW,TZ,100,0),`removed attention ${f}/${v}`)).filter(id=>id.startsWith("t_s1")),[],`removed member keeps S1 work in Attention ${f}/${v}`);
  pushed=await deliver(fx,"member removed");
  assert.deepEqual((pushed[EDITOR]??[]).filter(t=>t.startsWith("t_s1")),[]);

  // --- step 6: defense in depth - a STALE assignee row of a removed member grants nothing ---
  assert.throws(()=>fx.db.prepare("UPDATE tasks SET assignee_user_id=? WHERE id='t_s1_97'").run(EDITOR),/assignee must be a shared-area editor or admin/);

  // --- step 7: durable sign-out everywhere ---
  cursors[VIEWER]=sync(VIEWER).page.cursor;
  assert.equal(sync(VIEWER,cursors[VIEWER]).ok,true,"precondition: the viewer's cursor works before sign-out");
  const stale=A.issueWritable(VIEWER).sessionToken;
  const issued=durable.issueDurableTargetStagingSession(fx.store,VIEWER,900);
  assert.equal(issued.ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,VIEWER).ok,true);
  assert.deepEqual(sync(VIEWER,cursors[VIEWER]),{ok:false,reason:"resync_required"},"a sign-out invalidates the note-sync cursor");
  const fresh=sync(VIEWER);
  assert.equal(fresh.ok,true,"a new bootstrap needs no cursor");
  assert.equal(A.revoke(stale),true);
  assert.equal(A.updateTaskTitle(stale,{...taskBase(fx,OWNER,"t_s1_03"),title:"HACKED"}).ok,false,"a revoked authority token cannot write");
  assert.equal(A.revokeActor(VIEWER)>=0,true);
  assert.equal(A.updateTaskTitle(token(fx,VIEWER),{...taskBase(fx,OWNER,"t_s1_03"),title:"HACKED"}).ok,false);
});

// ================== HTTP spot checks: route-level parity behind default-off flags ==================
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET:GLOBAL_INDEX}=await import("../app/api/target-staging/global-index/route.ts");
const {GET:ATTENTION}=await import("../app/api/target-staging/attention/route.ts");
const {GET:ATTENTION_PREVIEW}=await import("../app/api/target-staging/attention/command/route.ts");
const {GET:NOTIFICATIONS}=await import("../app/api/target-staging/notifications/settings/route.ts");
const {GET:NOTE_SYNC}=await import("../app/api/target-staging/note-sync/route.ts");
const origin="http://localhost:3001";
let ipSerial=0;
const nextIp=()=>{ipSerial++;return `10.66.${ipSerial>>8&255}.${ipSerial&255}`;};
function useStore(fx){
  Object.assign(process.env,{AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:fx.stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:fx.stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:OWNER});
}
function session(fx,u){
  if(u===OWNER)return {cookie:sessionCookieName+"="+createSessionToken()};
  const s=durable.issueDurableTargetStagingSession(fx.store,u,900);
  assert.equal(s.ok,true,JSON.stringify(s));
  return {cookie:durable.TARGET_STAGING_SESSION_COOKIE+"="+s.sessionToken,sessionId:s.sessionId};
}
const http=async(handler,pathAndQuery,cookie)=>{
  const response=await handler(new Request(origin+pathAndQuery,{headers:{cookie,"x-forwarded-for":nextIp()}}));
  const text=await response.text();
  return {status:response.status,cache:response.headers.get("cache-control"),text,body:(()=>{try{return JSON.parse(text);}catch{return null;}})()};
};
const HTTP="AI_EXECUTIVE_TARGET_STAGING_HTTP_";
const HTTP_FAMILIES=[[GLOBAL_INDEX,"/api/target-staging/global-index?scope=all"],
  [ATTENTION,"/api/target-staging/attention?timeZone=UTC"],[NOTIFICATIONS,"/api/target-staging/notifications/settings"],
  [NOTE_SYNC,"/api/target-staging/note-sync?areaId=a_s1&limit=100"],
  [ATTENTION_PREVIEW,"/api/target-staging/attention/command?taskId=t_s1_07&ruleId=deadline_overdue&occurrenceOn="+OVERDUE]];
const FLAG_FAMILIES=[
  [GLOBAL_INDEX,HTTP_FAMILIES[0][1],[HTTP+"ENABLED",HTTP+"GLOBAL_COMBINED_ENABLED"]],
  [ATTENTION,HTTP_FAMILIES[1][1],[HTTP+"ENABLED",HTTP+"ATTENTION_ENABLED"]],
  [NOTIFICATIONS,HTTP_FAMILIES[2][1],[HTTP+"ENABLED",HTTP+"NOTIFICATIONS_ENABLED"]],
  [NOTE_SYNC,HTTP_FAMILIES[3][1],[HTTP+"ENABLED",HTTP+"NOTES_ENABLED",HTTP+"NOTE_SYNC_ENABLED"]],
  [ATTENTION_PREVIEW,HTTP_FAMILIES[4][1],[HTTP+"ENABLED",HTTP+"WRITE_ENABLED",HTTP+"ATTENTION_ENABLED",HTTP+"ATTENTION_WRITE_ENABLED"]]];
test("8. HTTP spot checks: global index, attention, command preview, notifications and note-sync agree with the internal channels",async()=>{
  const fx=fixture();await armPush(fx);useStore(fx);
  const A=fx.authority,sessions=Object.fromEntries(ACTORS.map(u=>[u,session(fx,u)]));
  const m=current(fx);
  for(const u of ACTORS){
    const allowed=allowedTokens(fx,u);
    // --- global index (Vše) ---
    const gi=await http(GLOBAL_INDEX,"/api/target-staging/global-index?scope=all&limit=100",sessions[u].cookie);
    assert.equal(gi.status,200,`${u}: global-index ${gi.text.slice(0,120)}`);
    assert.equal(gi.cache,"no-store");
    assert.deepEqual(gi.body.items.map(x=>x.kind+":"+x.item.id),
      A.readGlobalCombinedPage(u,"all",100,{projects:0,tasks:0,notes:0}).items.map(x=>x.kind+":"+x.item.id),`${u}: HTTP Vše != internal Vše`);
    assert.deepEqual(foundTokens(fx,gi.text).filter(t=>!allowed.has(t)),[],`${u}: HTTP global-index leaks`);
    assert.ok(!gi.text.includes("BODY-SENTINEL"));
    // --- attention list ---
    const at=await http(ATTENTION,"/api/target-staging/attention?timeZone="+encodeURIComponent(TZ),sessions[u].cookie);
    assert.equal(at.status,200,`${u}: attention ${at.text.slice(0,120)}`);
    const internal=A.readAttentionCandidatePage(u,"all","active",at.body.evaluatedAtMs,TZ,100,0);
    assert.deepEqual(at.body.items.map(x=>x.taskId),internal.items.map(x=>x.taskId),`${u}: HTTP attention != internal attention`);
    assert.deepEqual(foundTokens(fx,at.text).filter(t=>!allowed.has(t)),[],`${u}: HTTP attention leaks`);
    assert.ok(at.body.items.every(x=>m.mine(u).some(t=>t.id===x.taskId)),`${u}: HTTP attention has work that is not mine`);
  }
  // --- notification settings: own settings and own device ids only ---
  for(const u of [VIEWER,STRANGER]){
    const ns=await http(NOTIFICATIONS,"/api/target-staging/notifications/settings",sessions[u].cookie);
    assert.equal(ns.status,200,`${u}: notifications ${ns.text.slice(0,120)}`);
    assert.ok(ns.text.includes(fx.devices[u]),`${u}: own device missing`);
    for(const o of ACTORS.filter(x=>x!==u))assert.ok(!ns.text.includes(fx.devices[o])&&!ns.text.includes(o),`${u}: ${o} leaks into notification settings`);
  }
  // --- note-sync: manifest of readable Areas, one identical 404 for foreign and nonexistent ones ---
  for(const [u,areas] of [[VIEWER,["a_s1","a_s2","a_s3","a_pr_ed"]],[STRANGER,["a_s1","a_s3"]],[EDITOR,["a_s1"]]]){
    const refusals=new Set();
    for(const area of areas){
      const r=await http(NOTE_SYNC,"/api/target-staging/note-sync?areaId="+area+"&limit=100",sessions[u].cookie);
      if(m.roleIn(u,area)!==null){
        assert.equal(r.status,200,`${u}: note-sync ${area} ${r.text.slice(0,100)}`);
        const internalIds=A.readAuthorizedNoteSync(u,{areaId:area,limit:100,secret:process.env.AI_EXECUTIVE_SESSION_SECRET}).page.entries.map(e=>e.id);
        assert.deepEqual(r.body.entries.map(e=>e.id),internalIds,`${u}: HTTP note-sync ${area}`);
        assert.ok(!r.text.includes("BODY-SENTINEL"));
      }else{assert.equal(r.status,404,`${u}: note-sync of foreign ${area}`);refusals.add(r.text);}
    }
    if(refusals.size){
      const missing=await http(NOTE_SYNC,"/api/target-staging/note-sync?areaId=a_does_not_exist&limit=100",sessions[u].cookie);
      assert.equal(missing.status,404);
      assert.deepEqual([...refusals],[missing.text],`${u}: a foreign Area is distinguishable from a nonexistent one`);
    }
  }
  // --- attention command preview: only the assignee-writer gets CAS inputs; everyone else an identical 404 ---
  const preview=(u,task,rule="deadline_overdue",on=OVERDUE)=>http(ATTENTION_PREVIEW,
    `/api/target-staging/attention/command?taskId=${task}&ruleId=${rule}&occurrenceOn=${on}`,sessions[u].cookie);
  const ok=await preview(EDITOR,"t_s1_07");
  assert.equal(ok.status,200,ok.text.slice(0,200));
  assert.deepEqual(Object.keys(ok.body).sort(),["expectedAttentionEpoch","expectedRevision","expectedStateRevision","lifecycle","restoreGeneration","snoozedUntilMs","writeAreaId"]);
  const denied=[await preview(VIEWER,"t_s1_07"),await preview(STRANGER,"t_s1_07"),await preview(EDITOR,"t_s2_01"),
    await preview(EDITOR,"t_s1_03"),await preview(EDITOR,"t_zz_nonexistent"),await preview(VIEWER,"t_pr_ed_01")];
  for(const d of denied)assert.equal(d.status,404,d.text.slice(0,120));
  assert.equal(new Set(denied.map(d=>d.text)).size,1,"preview refusals are distinguishable");
  // --- revoked durable session: every family answers 401 and no content ---
  const viewer=sessions[VIEWER];
  assert.equal((await http(GLOBAL_INDEX,"/api/target-staging/global-index?scope=all",viewer.cookie)).status,200);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,viewer.sessionId).ok,true);
  for(const [handler,url] of [[GLOBAL_INDEX,"/api/target-staging/global-index?scope=all"],
    [ATTENTION,"/api/target-staging/attention?timeZone=UTC"],[NOTIFICATIONS,"/api/target-staging/notifications/settings"],
    [NOTE_SYNC,"/api/target-staging/note-sync?areaId=a_s1&limit=100"],
    [ATTENTION_PREVIEW,"/api/target-staging/attention/command?taskId=t_pr_vw_01&ruleId=deadline_overdue&occurrenceOn="+OVERDUE]]){
    const r=await http(handler,url,viewer.cookie);
    assert.equal(r.status,401,`${url}: revoked session still answered ${r.status}`);
    assert.deepEqual(foundTokens(fx,r.text),[],`${url}: revoked session response carries content`);
  }
  // --- a missing / forged cookie and a disabled flag answer nothing either ---
  assert.equal((await http(GLOBAL_INDEX,"/api/target-staging/global-index?scope=all","session=forged")).status,401);
  // the REAL cookie names, pinned as literals: renaming a cookie must not silently turn this into a no-cookie test
  assert.equal(sessionCookieName,"ai_executive_session");
  assert.equal(durable.TARGET_STAGING_SESSION_COOKIE,"lumi_target_staging_session");
  const goodDurable=sessions[EDITOR].cookie.split("=")[1];
  const forgedValues=["forged","x".repeat(64),"A".repeat(43),goodDurable.slice(0,-3)+"AAA","Zm9yZ2Vk.Zm9yZ2Vk",""];
  for(const cookieName of ["ai_executive_session","lumi_target_staging_session"])
    for(const value of forgedValues)
      for(const [handler,url] of HTTP_FAMILIES){
        const r=await http(handler,url,cookieName+"="+value);
        assert.equal(r.status,401,`forged ${cookieName}=${value.slice(0,12)}... on ${url} answered ${r.status}`);
        assert.deepEqual(foundTokens(fx,r.text),[],`forged cookie on ${url} carries content`);
      }
  // a durable cookie value presented under the OTHER cookie name authenticates nothing either
  for(const [handler,url] of HTTP_FAMILIES)
    assert.equal((await http(handler,url,"ai_executive_session="+goodDurable)).status,401,`durable token under the owner cookie name on ${url}`);
  // every family answers one uniform 404 per flag that gates it (the master HTTP flag included), with a VALID session
  for(const [handler,url,flags] of FLAG_FAMILIES)
    for(const flag of flags){
      const saved=process.env[flag];process.env[flag]="false";
      try{
        const r=await http(handler,url,sessions[EDITOR].cookie);
        assert.equal(r.status,404,`${url}: flag ${flag}=false still answered ${r.status}`);
        assert.deepEqual(foundTokens(fx,r.text),[],`${url}: disabled family carries content`);
      }finally{process.env[flag]=saved;}
    }
  for(const [handler,url] of HTTP_FAMILIES)
    assert.equal((await http(handler,url,sessions[EDITOR].cookie)).status,200,`${url}: flags restored, the family answers again`);
});

// ------------------------------------------ cleanup ------------------------------------------
test("legacy data directory untouched; isolated fixtures closed",()=>{
  try{
    assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
    for(const fx of fixtures)assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:fx.stage.directory,
      expectedRestoreGeneration:fx.stage.restoreGeneration,mode:"r2-model"}),{ok:true,mode:"r2-model",issues:[]},
      "every matrix store still passes the r2-model preflight after all writes");
  }finally{
    for(const fx of fixtures){try{fx.authority.close();}catch{}try{fx.reader.close();}catch{}try{fx.db.close();}catch{}}
    for(const [k,v] of Object.entries(savedEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
});
