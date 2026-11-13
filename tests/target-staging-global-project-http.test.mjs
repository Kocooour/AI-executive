import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const env=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const previous=Object.fromEntries(env.map(key=>[key,process.env[key]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m4-project-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"untouched");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"isolated-global-project-http-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/project-index/global/route.ts");
const {readStagingGlobalProjectPageInChild,parseStagingGlobalProjectPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=await import("../lib/target-staging-http-identity.ts");

let seq=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"untouched");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++seq)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [ws,who] of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(ws,who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,who);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
  const insert=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"Alice secret"],
    ["b-bob","bob-private","Bob private"],
    ["c-carol","carol-private","Carol private"],
    ["e-erin","erin-private","Erin secret"],
    ["s-empty","family-area","Empty viewer-visible shared"],
    ["s-family","family-area","Shared without assignments"],
    ["s-hidden","hidden-area","Erin shared secret"],
  ])insert.run(...row);
  const store={
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  };
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const value={stage,store,db};fixtures.push(value);return value;
}
const base="http://localhost:3001/api/target-staging/project-index/global";
const owner=()=>sessionCookieName+"="+createSessionToken();
const req=(query="",cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.78.3"},
});
const get=(query="",cookie=owner())=>GET(req(query,cookie));
function login(f,user){
  const result=durable.issueDurableTargetStagingSession(f.store,user,900);
  assert.equal(result.ok,true,JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+result.sessionToken;
}
const ids=page=>page.projects.map(x=>x.id);
async function ok(response){
  const res=await response;
  const body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),["hasMore","nextCursor","projects","scope"]);
  for(const project of body.projects){
    assert.deepEqual(Object.keys(project).sort(),["areaId","areaKind","id","title"]);
    assert.equal("whenOn" in project,false);
    assert.equal("members" in project,false);
  }
  assert.equal("linearization" in body,false);
  assert.equal("revision" in body,false);
  assert.equal("areaEpochs" in body,false);
  return body;
}

test("independent default-off gate and authenticated owner required",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get()).status,404);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base))).status,401);
  assert.deepEqual(ids(await ok(get())),["a-alice","s-empty","s-family"]);
});

test("global Vše includes viewer/editor shared projects without assigned work",async()=>{
  const f=fixture();
  const bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get("?scope=all",bob))),
    ["b-bob","s-empty","s-family"]);
  assert.deepEqual(ids(await ok(get("?scope=personal",bob))),["b-bob"]);
  assert.deepEqual(ids(await ok(get("?scope=shared",bob))),["s-empty","s-family"]);
  assert.deepEqual(ids(await ok(get("?scope=all",carol))),
    ["c-carol","s-empty","s-family"]);
  assert.deepEqual(ids(await ok(get("?scope=all",erin))),
    ["e-erin","s-hidden"]);
  const page=await ok(get("?scope=shared",carol));
  assert.ok(!JSON.stringify(page).includes("Alice secret"));
  assert.ok(!JSON.stringify(page).includes("Erin secret"));
  assert.ok(!JSON.stringify(page).includes("b-bob"));
});

test("invalid or duplicate parameters and actor overrides fail closed",async()=>{
  fixture();
  for(const query of ["?scope=my-plan","?scope=everything",
    "?scope=all&scope=shared","?limit=0","?limit=101","?limit=01",
    "?limit=-1","?limit=1&limit=2","?cursor=abc",
    "?cursor=a%00b","?cursor=a.b&cursor=c.d",
    "?actor=erin","?offset=5","?assigneeUserId=bob"]){
    assert.equal((await get(query)).status,400,query);
  }
});

test("signed cursor binds current actor/session, scope and limit",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const query="?scope=all&limit=1";
  const first=await ok(get(query,bob));
  assert.deepEqual(ids(first),["b-bob"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const suffix="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(ids(await ok(get(query+suffix,bob))),["s-empty"]);
  for(const alternate of ["?scope=shared&limit=1","?scope=personal&limit=1",
    "?scope=all&limit=2"])
    assert.equal((await get(alternate+suffix,bob)).status,400);
  assert.equal((await get(query+suffix,carol)).status,400);
  assert.equal((await get(query+suffix,owner())).status,400);
  f.db.prepare("UPDATE projects SET title='New title' WHERE id='s-family'").run();
  assert.equal((await get(query+suffix,bob)).status,409);
});

test("live session, membership, Area content and empty Area changes invalidate reads",async()=>{
  const f=fixture(),carol=login(f,"carol");
  const hash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const child=()=>readStagingGlobalProjectPageInChild({
    stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all",100,0);
  const live=p=>verifyStagingReadBeforeRelease(
    req("?scope=all",carol),{kind:"session",tokenHash:hash},
    f.store,"alice",p.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:p.areaEpochs,scope:"global-all"},
  );
  const old=await child();assert.ok(old);
  assert.equal(live(old),"ok");
  f.db.prepare("UPDATE projects SET title='After snapshot' WHERE id='s-family'").run();
  assert.equal(live(old),"stale");
  const fresh=await child();assert.ok(fresh);assert.equal(live(fresh),"ok");
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('added','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('added-area','New empty','shared','added','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','carol','viewer')").run();
  assert.equal(live(fresh),"stale");
  const granted=await child();assert.ok(granted);
  assert.deepEqual(ids(granted),ids(fresh));
  assert.ok(granted.areaEpochs.some(a=>a.areaId==="added-area"));
  assert.equal(live(granted),"ok");
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(live(granted),"stale");
  assert.deepEqual(ids(await ok(get("?scope=all",carol))),["c-carol"]);
  const revoked=await child();assert.ok(revoked);
  assert.equal(live(revoked),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"carol").ok,true);
  assert.notEqual(live(revoked),"ok");
});

test("invalid project IDs are excluded before HTTP pagination",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const insert=f.db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  for(const id of [".","..","a"+String.fromCharCode(0)+"nul",
    "s"+String.fromCharCode(1)+"control","s"+String.fromCharCode(127)+"del",
    "x".repeat(513)])insert.run(id,"family-area","Invalid project");
  const visible=[];
  let cursor=null;
  for(let i=0;i<3;i++){
    const suffix=cursor?"&cursor="+encodeURIComponent(cursor):"";
    const page=await ok(get("?scope=all&limit=1"+suffix,bob));
    visible.push(...ids(page));
    cursor=page.nextCursor;
    assert.equal(page.hasMore,i<2);
  }
  assert.deepEqual(visible,["b-bob","s-empty","s-family"]);
  assert.equal(cursor,null);
});

test("strict child DTO rejects metadata leakage, forged Areas and row errors",()=>{
  const personal={areaId:"bob-private",areaKind:"private",access:"private-owner",
    policyRevision:0,contentRevision:1,projectContentRevision:1};
  const shared={areaId:"family-area",areaKind:"shared",access:"viewer",
    policyRevision:0,contentRevision:2,projectContentRevision:2};
  const p={id:"b",title:"Private",areaId:"bob-private",areaKind:"private"};
  const s={id:"s",title:"Shared",areaId:"family-area",areaKind:"shared"};
  const input={ok:true,scope:"all",hasMore:false,revision:"0".repeat(64),
    projects:[p,s],
    linearization:{actorUserId:"bob",areas:[
      {areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0},
      {areaId:"family-area",areaKind:"shared",access:"viewer",policyRevision:0},
    ]},areaEpochs:[personal,shared]};
  const parse=x=>parseStagingGlobalProjectPage(x,"all",2);
  assert.deepEqual(ids(parse(input)),["b","s"]);
  for(const forged of [
    {...input,debug:"secret"},
    {...input,scope:"my-plan"},
    {...input,projects:[s,p]},
    {...input,projects:[p,{...s,id:"b"}]},
    {...input,projects:[p,{...s,members:["erin"]}]},
    {...input,projects:[p,{...s,whenOn:"2026-11-07"}]},
    {...input,projects:[p,{...s,areaId:"bob-private"}]},
    {...input,projects:[{...p,areaKind:"shared"},s]},
    {...input,projects:[p,{...s,id:"."}]},
    {...input,projects:[p,{...s,id:"x".repeat(513)}]},
    {...input,projects:[p],hasMore:true},
    {...input,areaEpochs:[personal]},
    {...input,areaEpochs:[{...personal,contentRevision:-1},shared]},
    {...input,linearization:{...input.linearization,areas:[
      {...input.linearization.areas[0],access:"viewer"},
      input.linearization.areas[1]]}},
  ])assert.equal(parse(forged),null,JSON.stringify(forged).slice(0,140));
});
