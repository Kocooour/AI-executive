/** Real pinned, actor-scoped SQLite + HTTP acceptance of the capture Area catalog. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const envNames=[
  "NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const previous=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-capture-areas-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"r3-capture-areas-test-owner-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"false",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED:"false",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED:"false",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {issueDurableTargetStagingSession,revokeDurableTargetStagingSession,
  TARGET_STAGING_SESSION_COOKIE}=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/notes/create-targets/route.ts");
const {POST}=await import("../app/api/target-staging/notes/route.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {parsePrivateNoteAreaTargets}=await import("../lib/target-staging-read-process.ts");
after(()=>{
  for(const [key,value] of Object.entries(previous))
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  try{
    db.exec("PRAGMA foreign_keys=ON");
    const space=db.prepare("SELECT workspace_id AS id FROM areas WHERE id=?")
      .get(stage.unassignedAreaId).id;
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,?,?,?)")
      .run("alice-family","Rodina","private",space,"alice");
    db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-space','personal','bob')").run();
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Secret','private','bob-space','bob','unassigned')").run();
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Shared','shared','team','alice')").run();
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  }finally{db.close();}
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const canonical=inspectIsolatedTargetStore({
    stagingDirectory:stage.directory,expectedOwnerUserId:"alice",
    expectedRestoreGeneration:stage.restoreGeneration,mode:"r2-model",
  });
  assert.equal(canonical.ok,true,JSON.stringify(canonical));
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return {stage,store};
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function cookie(fx,user){
  const issued=issueDurableTargetStagingSession(fx.store,user,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return {value:TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken,id:issued.sessionId};
}
const url="http://localhost:3001/api/target-staging/notes/create-targets";
function get(cookie="",target=url,extra={}){
  return GET(new Request(target,{headers:{
    ...(cookie?{cookie}:{}),"x-forwarded-for":"10.9.0.67",...extra,
  }}));
}
async function check(response,status){
  assert.equal(response.status,status,await response.clone().text());
  assert.equal(response.headers.get("cache-control"),"no-store");
  return await response.json();
}
test("real owner and durable actor see only their writable private Areas, never shared or foreign",async()=>{
  const fx=fixture();
  // Read-only chooser operates while all note-write and note-create HTTP flags are off.
  assert.equal(process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED,"false");
  assert.equal(process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED,"false");
  assert.equal(process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED,"false");
  const alice=await check(await get(owner()),200);
  const forbiddenWrite=await POST(new Request("http://localhost:3001/api/target-staging/notes",{
    method:"POST",headers:{cookie:owner(),"origin":"http://localhost:3001",
      "x-lumi-target-protocol":"1","content-type":"application/json"},
    body:JSON.stringify({noteId:randomUUID(),commandId:randomUUID(),
      areaId:fx.stage.unassignedAreaId,restoreGeneration:fx.stage.restoreGeneration,
      title:"Should never create",body:"No write"}),
  }));
  assert.equal(forbiddenWrite.status,404,"chooser flag must never enable notes POST");
  assert.deepEqual(Object.keys(alice),["areas"]);
  assert.ok(alice.areas.some(a=>a.id===fx.stage.unassignedAreaId));
  assert.ok(alice.areas.some(a=>a.id==="alice-family"&&a.title==="Rodina"));
  assert.equal(JSON.stringify(alice).includes("team-area"),false);
  assert.equal(JSON.stringify(alice).includes("bob-private"),false);
  const bob=cookie(fx,"bob");
  const data=await check(await get(bob.value),200);
  assert.deepEqual(data,{areas:[{id:"bob-private",title:"Secret"}]});
  assert.equal(JSON.stringify(data).includes("alice-family"),false);
  const db=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
  try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n,0);}
  finally{db.close();}
});
test("feature gate, login, malformed query and expired identity fail without Area disclosure",async()=>{
  const fx=fixture();
  assert.equal((await check(await get(),401)).error,"Authentication required");
  assert.equal((await check(await get(owner(),url+"?scope=shared"),400)).error,"Invalid request");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED="false";
  assert.equal((await check(await get(owner()),404)).error,"Not found");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED="true";
  const bob=cookie(fx,"bob");
  const revoked=revokeDurableTargetStagingSession(fx.store,bob.id);
  assert.equal(revoked.ok,true,JSON.stringify(revoked));
  assert.equal((await check(await get(bob.value),401)).code,"session_revoked");
  const good=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=randomUUID();
  assert.equal((await check(await get(owner()),503)).error,"Staging unavailable");
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=good;
});
test("strict child DTO refuses duplicate, extra, cross-scope or malformed Area witnesses",()=>{
  const witness={actorUserId:"alice",areas:[{areaId:"a",areaKind:"private",
    access:"private-owner",policyRevision:0}]};
  const ok={ok:true,areas:[{id:"a",title:"Personal"}],linearization:witness};
  assert.deepEqual(parsePrivateNoteAreaTargets(ok),{
    areas:ok.areas,linearization:witness,
  });
  for(const invalid of [
    {...ok,leak:"actor"},
    {...ok,areas:[{id:"a",title:"X",owner:"alice"}]},
    {...ok,areas:[{id:"a",title:"\0"}]},
    {...ok,areas:[{id:"a",title:"X"},{id:"a",title:"X"}]},
    {...ok,linearization:{...witness,areas:[{...witness.areas[0],access:"viewer"}]}},
    {...ok,linearization:{...witness,areas:[{...witness.areas[0],areaKind:"shared"}]}},
  ])assert.equal(parsePrivateNoteAreaTargets(invalid),null);
});
