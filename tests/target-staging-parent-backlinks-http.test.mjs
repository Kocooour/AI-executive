import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const keys = ["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const oldEnv = Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(),"lumi-backlink-r2d-"));
const legacy = path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"keep"),"untouched");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH =
  "scrypt:"+Buffer.alloc(16,1).toString("base64url")+":"+
  Buffer.alloc(64,2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-backlink-session-secret-20261103-long";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED = "true";
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/relations/backlinks/route.ts");
const { readStagingParentBacklinkInChild, parseStagingParentBacklink } =
  await import("../lib/target-staging-read-process.ts");
const { verifyStagingReadBeforeRelease } =
  await import("../lib/target-staging-http-identity.ts");

after(() => {
  for(const [k,v] of Object.entries(oldEnv)){
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"keep"),"utf8"),"untouched");
  rmSync(root,{recursive:true,force:true});
});
function fixture() {
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const id of ["bob","carol","dave"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run("personal-"+id,id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Private','private',?,?,'unassigned')")
      .run("private-"+id,"personal-"+id,id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for(const [id,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]]){
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(id,role);
  }
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p','team-area','Secret project')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('q','team-area','Other project')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('private-p',?,'Alice private')").run(stage.unassignedAreaId);
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('t1','p','Sensitive task')").run();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('standalone-task','team-area','Sensitive standalone')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('private-task','private-p','Private')").run();
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('n1','p','Private note','Sensitive note body')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('standalone-note','team-area','Standalone','Hidden data')").run();
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('private-note','private-p','Private','Hidden private')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID="alice";
  return {stage,store:{stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration}};
}
function login(fx,actor){
  const issued=durable.issueDurableTargetStagingSession(fx.store,actor,900);
  assert.equal(issued.ok,true);
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const owner=()=>sessionCookieName+"="+createSessionToken();
async function get(cookie,kind="task",id="t1",tail=""){
  const q="?kind="+encodeURIComponent(kind)+"&id="+encodeURIComponent(id)+tail;
  const r=await GET(new Request("http://localhost:3001/api/target-staging/relations/backlinks"+q,{
    headers:cookie?{cookie,"x-forwarded-for":"10.25.31.42"}:
      {"x-forwarded-for":"10.25.31.42"},
  }));
  assert.equal(r.headers.get("cache-control"),"no-store");
  return {status:r.status,body:await r.json()};
}
const link=(kind,id)=>[{predicate:"belongs_to_project",sourceKind:kind,sourceId:id,projectId:"p"}];

test("backlinks only disclose canonical readable parents for private/shared roles",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol"),dave=login(fx,"dave");
  assert.deepEqual(await get(bob),{status:200,body:{relations:link("task","t1")}});
  assert.deepEqual(await get(carol,"note","n1"),
    {status:200,body:{relations:link("note","n1")}});
  assert.deepEqual(await get(carol,"task","standalone-task"),
    {status:200,body:{relations:[]}});
  assert.deepEqual(await get(bob,"note","standalone-note"),
    {status:200,body:{relations:[]}});
  assert.deepEqual(await get(bob,"task","private-task"),
    {status:404,body:{error:"Not found"}});
  assert.deepEqual(await get(dave),{status:404,body:{error:"Not found"}});
  assert.deepEqual(await get(dave,"note","private-note"),
    {status:404,body:{error:"Not found"}});
  assert.deepEqual(await get(bob,"note","not-existent"),
    {status:404,body:{error:"Not found"}});
  assert.equal((await get(owner(),"task","private-task")).status,200);
  assert.equal((await get(owner(),"note","private-note")).status,200);
  const raw=JSON.stringify((await get(bob,"note","n1")).body);
  for(const hidden of ["Sensitive","Private","note body","title","areaId","policyRevision",
    "taskRevision","member","ownerUserId"]) assert.equal(raw.includes(hidden),false,hidden);
});

test("flags, real cookie and query allowlist reject forged inputs",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED="false";
  assert.equal((await get(bob)).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED="true";
  assert.equal((await get(null)).status,401);
  assert.equal((await get(bob,"person","t1")).status,400);
  assert.equal((await get(bob,"task","t1","&actorUserId=alice")).status,400);
  assert.equal((await get(bob,"task","t1","&id=t1")).status,400);
  assert.equal((await get(bob,"task","t1","&areaId=team-area")).status,400);
  assert.equal((await get(bob,"note","n1","&kind=task")).status,400);
  const revoked=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const info=durable.verifyDurableTargetStagingSessionLive(fx.store,revoked);
  assert.equal(info.ok,true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,info.sessionId).ok,true);
  assert.equal((await get(bob)).status,401);
});

test("live release rejects task reparent, note reparent, and permission changes",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash};
  const task=await readStagingParentBacklinkInChild(config,"task","t1");
  const note=await readStagingParentBacklinkInChild(config,"note","n1");
  assert.equal(task?.ok,true,JSON.stringify(task));
  assert.equal(note?.ok,true,JSON.stringify(note));
  const identity={kind:"session",tokenHash};
  const req=new Request("http://localhost:3001/api/target-staging/relations/backlinks",
    {headers:{cookie:bob}});
  const release=(item)=>verifyStagingReadBeforeRelease(req,identity,fx.store,"alice",
    item.result.linearization,undefined,undefined,
    item.result.noteGuard??undefined,undefined,item.result.taskGuard??undefined);
  assert.equal(release(task),"ok");
  assert.equal(release(note),"ok");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("UPDATE tasks SET project_id='q' WHERE id='t1'").run();
  assert.equal(release(task),"stale","task reparenting must invalidate pre-release proof");
  db.prepare("UPDATE notes SET project_id='q' WHERE id='n1'").run();
  assert.equal(release(note),"stale","note reparenting must invalidate pre-release proof");
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(release(task),"stale","Area revocation must invalidate backlink");
  db.close();
});

test("child DTO blocks forged parent, extra fields, mismatched guards",()=>{
  const observed={actorUserId:"alice",areas:[{
    areaId:"team-area",areaKind:"shared",policyRevision:0,access:"admin",
  }]};
  const t={ok:true,relations:link("task","t1"),linearization:observed,
    taskGuard:{taskId:"t1",projectId:"p",areaId:"team-area",taskRevision:1,parentRevision:0},
    noteGuard:null};
  assert.equal(parseStagingParentBacklink(t,"task","t1")?.ok,true);
  assert.equal(parseStagingParentBacklink({...t,secret:"hidden"},"task","t1"),null);
  assert.equal(parseStagingParentBacklink({...t,relations:link("note","t1")},"task","t1"),null);
  assert.equal(parseStagingParentBacklink({...t,taskGuard:{...t.taskGuard,projectId:"q"}},"task","t1"),null);
  assert.equal(parseStagingParentBacklink({...t,noteGuard:t.taskGuard},"task","t1"),null);
  assert.equal(parseStagingParentBacklink({...t,relations:[]},"task","t1"),null);
  const noParent={...t,relations:[],taskGuard:{...t.taskGuard,projectId:null,parentRevision:null}};
  assert.equal(parseStagingParentBacklink(noParent,"task","t1")?.ok,true);
  const n={ok:true,relations:link("note","n1"),linearization:observed,
    taskGuard:null,noteGuard:{noteId:"n1",projectId:"p",areaId:"team-area",
      noteRevision:0,parentRevision:0}};
  assert.equal(parseStagingParentBacklink(n,"note","n1")?.ok,true);
  assert.equal(parseStagingParentBacklink({...n,noteBody:"secret"},"note","n1"),null);
});
