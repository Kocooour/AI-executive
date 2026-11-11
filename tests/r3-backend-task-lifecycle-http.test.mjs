/**
 * R3-BE task lifecycle acceptance: one real chain of Next HTTP handlers +
 * pinned staging SQLite writes (not separate unit mocks). All identities and
 * content are synthetic. No production mutation or legacy data access.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const previous=Object.fromEntries(vars.map(x=>[x,process.env[x]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r3-task-http-lifecycle-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"legacy fixture unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"r3-be-task-http-lifecycle-20261111-at-least-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {writeFields,PROTOCOL}=await import("./support/target-write-contract.mjs");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {GET:DETAIL}=await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const {GET:LIST}=await import("../app/api/target-staging/tasks/route.ts");
const {GET:TITLE_PREVIEW,PATCH:TITLE_WRITE}=
  await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const {POST:TITLE_STATUS}=await import(
  "../app/api/target-staging/tasks/[taskId]/title/status/route.ts");
const {POST:DELETE_TASK}=await import(
  "../app/api/target-staging/tasks/[taskId]/delete/route.ts");
const {POST:DELETE_STATUS}=await import(
  "../app/api/target-staging/tasks/[taskId]/delete/status/route.ts");

const stage=bootstrapIsolatedTargetStore({
  stagingDirectory:path.join(root,"stage"),ownerUserId:"alice",
});
Object.assign(process.env,{
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
  AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
  AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
});
const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
const db=new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
for(const user of ["bob","carol"]) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
    .run(user+"-personal",user);
  db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?,'Private','private',?,?,'unassigned')`)
    .run(user+"-private",user+"-personal",user);
}
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
for(const [user,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)")
    .run(user,role);
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('alice-lifecycle',?,'Original')")
  .run(stage.unassignedAreaId);
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('bob-foreign','bob-private','Private Bob')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('team-lifecycle','team-area','Team original')").run();

let nextIp=0;
const ip=()=>`10.19.1.${++nextIp}`;
const ownerCookie=`${sessionCookieName}=${createSessionToken()}`;
const bob=durable.issueDurableTargetStagingSession(store,"bob",900);
const carol=durable.issueDurableTargetStagingSession(store,"carol",900);
assert.equal(bob.ok,true);
assert.equal(carol.ok,true);
const bobCookie=`${durable.TARGET_STAGING_SESSION_COOKIE}=${bob.sessionToken}`;
const carolCookie=`${durable.TARGET_STAGING_SESSION_COOKIE}=${carol.sessionToken}`;
const url="http://localhost:3001/api/target-staging/tasks";
const ctx=taskId=>({params:Promise.resolve({taskId})});
const headers=(cookie,write=false)=>({
  ...(cookie?{cookie}:{}),
  "x-forwarded-for":ip(),
  ...(write?{"content-type":"application/json",origin:"http://localhost:3001",...PROTOCOL}:{}),
});
const detail=(id,cookie=ownerCookie)=>DETAIL(new Request(url+"/"+id,{
  headers:headers(cookie),
}),ctx(id));
const listing=(cookie=ownerCookie,scope="personal")=>LIST(new Request(
  url+"?scope="+scope+"&limit=100",{headers:headers(cookie)}));
const preview=(id,cookie=ownerCookie)=>TITLE_PREVIEW(new Request(
  url+"/"+id+"/title",{headers:headers(cookie)}),ctx(id));
const command=(id,payload)=>({...writeFields(db,id,stage.restoreGeneration),...payload});
const send=(fn,id,pathSuffix,payload,cookie=ownerCookie,method="POST")=>
  fn(new Request(url+"/"+id+"/"+pathSuffix,{
    method,headers:headers(cookie,true),
    body:JSON.stringify(command(id,payload)),
  }),ctx(id));
const title=(id,payload,cookie=ownerCookie)=>send(
  TITLE_WRITE,id,"title",payload,cookie,"PATCH");
const titleStatus=(id,payload,cookie=ownerCookie)=>send(
  TITLE_STATUS,id,"title/status",payload,cookie);
const del=(id,payload,cookie=ownerCookie)=>send(
  DELETE_TASK,id,"delete",payload,cookie);
const delStatus=(id,payload,cookie=ownerCookie)=>send(
  DELETE_STATUS,id,"delete/status",payload,cookie);
const count=table=>db.prepare("SELECT COUNT(*) AS n FROM "+table).get().n;
const verifyStore=()=>{
  const report=inspectIsolatedTargetStore({stagingDirectory:stage.directory,mode:"r2-model"});
  assert.deepEqual(report.issues,[]);
};
after(()=>{
  db.close();
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"legacy fixture unchanged");
  rmSync(root,{recursive:true,force:true});
});

test("owner real HTTP detail → CAS title → same-command receipt → delete tombstone → read denial",async()=>{
  const id="alice-lifecycle";
  const beforeAudit=count("task_title_audit");
  const beforeDelete=count("task_delete_audit");
  const beforeTombs=count("task_tombstones");
  const beforeEvents=count("change_log");
  const head=await detail(id);
  assert.equal(head.status,200);
  assert.equal(head.headers.get("cache-control"),"no-store");
  assert.equal((await head.json()).task.title,"Original");
  const pre=await preview(id);
  assert.equal(pre.status,200);
  const firstRev=(await pre.json()).snapshotRevision;
  assert.match(firstRev,/^[a-f0-9]{64}$/);
  const rename={commandId:randomUUID(),title:"Changed in R3",expectedRevision:firstRev};
  assert.equal((await titleStatus(id,rename)).status,200);
  assert.deepEqual(await (await titleStatus(id,rename)).json(),{status:"not_recorded"});
  assert.equal((await title(id,rename)).status,200);
  assert.deepEqual(await (await titleStatus(id,rename)).json(),{status:"committed"});
  const replay=await title(id,rename);
  assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),{ok:true,replayed:true});
  assert.equal(count("task_title_audit"),beforeAudit+1);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(id).title,"Changed in R3");
  assert.equal((await title(id,{...rename,commandId:randomUUID()})).status,409,
    "the prior CAS cannot be reused after a committed rename");

  const fresh=(await (await detail(id)).json()).snapshotRevision;
  assert.match(fresh,/^[a-f0-9]{64}$/);
  assert.notEqual(fresh,firstRev);
  const removal={commandId:randomUUID(),expectedRevision:fresh};
  assert.deepEqual(await (await delStatus(id,removal)).json(),{status:"not_recorded"});
  const dropped=await del(id,removal);
  assert.equal(dropped.status,200);
  assert.deepEqual(await dropped.json(),{ok:true});
  assert.equal((await detail(id)).status,404);
  assert.deepEqual(await (await delStatus(id,removal)).json(),{status:"committed"});
  const deleteReplay=await del(id,removal);
  assert.equal(deleteReplay.status,200);
  assert.deepEqual(await deleteReplay.json(),{ok:true,replayed:true});
  assert.equal(count("task_delete_audit"),beforeDelete+1);
  assert.equal(count("task_tombstones"),beforeTombs+1);
  assert.equal(count("task_title_audit"),beforeAudit+1);
  assert.equal(count("change_log"),beforeEvents+2,
    "exactly one edit + one tombstone change");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id=?").get(id).n,0);
  const tomb=db.prepare("SELECT area_id FROM task_tombstones WHERE id=?").get(id);
  assert.equal(tomb.area_id,stage.unassignedAreaId);
  const personal=await listing();
  assert.equal(personal.status,200);
  assert.equal((await personal.json()).tasks.some(x=>x.id===id),false);
  verifyStore();
});

test("shared editor has a live right, viewer/foreign task cannot infer content; revoke hides receipts",async()=>{
  const id="team-lifecycle";
  const previousTitle=db.prepare("SELECT title FROM tasks WHERE id=?").get(id).title;
  assert.equal((await detail("bob-foreign",ownerCookie)).status,404);
  assert.equal((await detail(id,carolCookie)).status,200);
  assert.equal((await preview(id,carolCookie)).status,404);
  const canWrite=(await preview(id,bobCookie));
  assert.equal(canWrite.status,200);
  const rev=(await canWrite.json()).snapshotRevision;
  const input={commandId:randomUUID(),expectedRevision:rev,title:"Edited by Bob"};
  assert.equal((await title(id,input,carolCookie)).status,404);
  assert.equal((await title(id,input,ownerCookie)).status,200);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(id).title,"Edited by Bob");
  assert.equal((await titleStatus(id,input,carolCookie)).status,404);
  assert.deepEqual(await (await titleStatus(id,input,ownerCookie)).json(),
    {status:"committed"});
  // Reuse a new revision with Bob's distinct command so a durable session is
  // exercised in a successful write followed by immediate revocation.
  const bobRev=(await (await preview(id,bobCookie)).json()).snapshotRevision;
  const bobCommand={commandId:randomUUID(),expectedRevision:bobRev,title:"Bob's own update"};
  assert.equal((await title(id,bobCommand,bobCookie)).status,200);
  assert.deepEqual(await (await titleStatus(id,bobCommand,bobCookie)).json(),
    {status:"committed"});
  const earlierCount=count("task_title_audit");
  const stop=durable.revokeDurableTargetStagingSession(store,bob.sessionId);
  assert.equal(stop.ok,true);
  const deniedRead=await detail(id,bobCookie);
  assert.equal(deniedRead.status,401);
  const deniedStatus=await titleStatus(id,bobCommand,bobCookie);
  assert.equal(deniedStatus.status,401);
  const deniedMutation=await title(id,{
    commandId:randomUUID(),expectedRevision:bobRev,title:"Must not write",
  },bobCookie);
  assert.equal(deniedMutation.status,401);
  const deniedDelete=await del(id,{
    commandId:randomUUID(),expectedRevision:bobRev,
  },bobCookie);
  assert.equal(deniedDelete.status,401);
  assert.equal(count("task_title_audit"),earlierCount);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(id).title,"Bob's own update");
  assert.notEqual(previousTitle,"Bob's own update");
  verifyStore();
});
