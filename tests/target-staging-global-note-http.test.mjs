import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const names=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m6-global-note-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"isolated-global-note-http-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED:"false",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/note-index/global/route.ts");
const {GET:PROJECTS}=await import("../app/api/target-staging/project-index/global/route.ts");
const {parseStagingGlobalNotePage,readStagingGlobalNotePageInChild}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let serial=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [k,v]of Object.entries(old)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++serial)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [ws,who]of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)")
      .run(ws,who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,who);
  }
  for(const [a,who,role]of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(a,who,role);
  const project=db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  project.run("family-project","family-area","Shared project");
  project.run("hidden-project","hidden-area","Hidden project");
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private note","Alice BODY secret"],
    ["b-bob","bob-private",null,"Bob personal note","Bob BODY secret"],
    ["c-carol","carol-private",null,"Carol personal note","Carol BODY secret"],
    ["e-erin","erin-private",null,"Erin secret note","Erin BODY secret"],
    ["s-child",null,"family-project","Shared child note","Shared CHILD body"],
    ["s-direct","family-area",null,"Shared standalone note","Shared DIRECT body"],
    ["s-hidden",null,"hidden-project","Hidden shared note","Hidden shared BODY"],
  ])note.run(...row);
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const f={stage,db,store};fixtures.push(f);return f;
}
const base="http://localhost:3001/api/target-staging/note-index/global";
const owner=()=>sessionCookieName+"="+createSessionToken();
const request=(query="",cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.78.3"},
});
const get=(query="",cookie=owner())=>GET(request(query,cookie));
const ids=p=>p.notes.map(n=>n.id);
function login(f,who){
  const issued=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
async function ok(promise){
  const res=await promise,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),["hasMore","nextCursor","notes","scope"]);
  for(const n of body.notes)
    assert.deepEqual(Object.keys(n).sort(),
      ["areaId","areaKind","id","projectId","revision","title"]);
  for(const k of ["linearization","revision","areaEpochs","noteAreaEpochs"])
    assert.equal(k in body,false,k);
  for(const secret of [" BODY ","member","actorUserId","Alice BODY","Erin BODY",
    "Shared CHILD body","Shared DIRECT body"])
    assert.ok(!JSON.stringify(body).includes(secret),secret);
  return body;
}

test("both gates are independently default-off; no owner authentication fallback",async()=>{
  fixture();
  for(const k of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED"]){
    process.env[k]="false";
    assert.equal((await get()).status,404,k);
    process.env[k]="true";
  }
  assert.equal((await GET(new Request(base))).status,401);
  assert.deepEqual(ids(await ok(get())),["a-alice","s-child","s-direct"]);
  assert.equal((await PROJECTS(new Request(
    "http://localhost:3001/api/target-staging/project-index/global",
    {headers:{cookie:owner()}}))).status,404,
    "note flag must not activate separate project endpoint");
});

test("Vše includes all readable shared note titles for editor and viewer",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get("?scope=all",bob))),
    ["b-bob","s-child","s-direct"]);
  assert.deepEqual(ids(await ok(get("?scope=personal",bob))),["b-bob"]);
  assert.deepEqual(ids(await ok(get("?scope=shared",bob))),["s-child","s-direct"]);
  assert.deepEqual(ids(await ok(get("?scope=all",carol))),
    ["c-carol","s-child","s-direct"]);
  assert.deepEqual(ids(await ok(get("?scope=all",erin))),
    ["e-erin","s-hidden"]);
  const child=(await ok(get("?scope=shared",carol))).notes[0];
  assert.equal(child.projectId,"family-project","note inherits effective parent Area");
  assert.equal(child.revision,0);
});

test("query allowlist and signed cursor bind actor/session/scope/limit",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  for(const q of ["?scope=my-plan","?scope=unknown",
    "?scope=all&scope=shared","?limit=0","?limit=101","?limit=01",
    "?limit=-1","?limit=1&limit=2","?cursor=abc",
    "?cursor=x.y&cursor=z.q","?actor=erin","?offset=1","?noteBody=true"]){
    assert.equal((await get(q,bob)).status,400,q);
  }
  const query="?scope=all&limit=1",first=await ok(get(query,bob));
  assert.deepEqual(ids(first),["b-bob"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const suffix="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(ids(await ok(get(query+suffix,bob))),["s-child"]);
  assert.equal((await get("?scope=shared&limit=1"+suffix,bob)).status,400);
  assert.equal((await get("?scope=all&limit=2"+suffix,bob)).status,400);
  assert.equal((await get(query+suffix,carol)).status,400);
  assert.equal((await get(query+suffix,owner())).status,400);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED="true";
  assert.equal((await PROJECTS(new Request(
    "http://localhost:3001/api/target-staging/project-index/global?scope=all&limit=1&cursor="+
    encodeURIComponent(first.nextCursor),{headers:{cookie:bob}}))).status,400,
    "note cursor must not work in project route");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED="false";
  f.db.prepare("UPDATE notes SET body='New body without a title change' WHERE id='s-direct'").run();
  assert.equal((await get(query+suffix,bob)).status,409,
    "note-specific epochs must invalidate continuation after a body-only edit");
});

test("live content/membership/empty Area/session guards fail closed after child read",async()=>{
  const f=fixture(),carol=login(f,"carol");
  const hash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const child=()=>readStagingGlobalNotePageInChild({
    stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all",100,0);
  const live=p=>verifyStagingReadBeforeRelease(
    request("?scope=all",carol),{kind:"session",tokenHash:hash},
    f.store,"alice",p.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:p.areaEpochs,scope:"global-all",noteAreaEpochs:p.noteAreaEpochs},
  );
  const prior=await child();assert.ok(prior);
  assert.equal(live(prior),"ok");
  f.db.prepare("UPDATE notes SET body='Changed after child snapshot' WHERE id='s-child'").run();
  assert.equal(live(prior),"stale");
  const after=await child();assert.ok(after);assert.equal(live(after),"ok");
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('added','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('added-area','New empty','shared','added','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','carol','viewer')").run();
  assert.equal(live(after),"stale");
  const granted=await child();assert.ok(granted);
  assert.deepEqual(ids(granted),ids(after));
  assert.ok(granted.noteAreaEpochs.some(e=>e.areaId==="added-area"));
  assert.equal(live(granted),"ok");
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(live(granted),"stale");
  assert.deepEqual(ids(await ok(get("?scope=all",carol))),["c-carol"]);
  const withdrawn=await child();assert.ok(withdrawn);
  assert.equal(live(withdrawn),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"carol").ok,true);
  assert.notEqual(live(withdrawn),"ok");
});

test("strict child DTO rejects body, members, wrong kind/parent, reordering and forged epochs",()=>{
  const personal={areaId:"bob-private",areaKind:"private",access:"private-owner",
    policyRevision:0,contentRevision:1,projectContentRevision:1};
  const shared={areaId:"family-area",areaKind:"shared",access:"viewer",
    policyRevision:0,contentRevision:2,projectContentRevision:2};
  const p={id:"b",title:"Private",projectId:null,areaId:"bob-private",
    areaKind:"private",revision:1};
  const s={id:"s",title:"Shared",projectId:"family-project",
    areaId:"family-area",areaKind:"shared",revision:2};
  const input={ok:true,scope:"all",hasMore:false,revision:"0".repeat(64),
    notes:[p,s],
    linearization:{actorUserId:"bob",areas:[
      {areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0},
      {areaId:"family-area",areaKind:"shared",access:"viewer",policyRevision:0},
    ]},
    areaEpochs:[personal,shared],
    noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:3},
      {areaId:"family-area",noteSyncRevision:4}],
  };
  const parse=v=>parseStagingGlobalNotePage(v,"all",2);
  assert.deepEqual(ids(parse(input)),["b","s"]);
  for(const invalid of [
    {...input,debug:"leak"},
    {...input,scope:"my-plan"},
    {...input,notes:[s,p]},
    {...input,notes:[p,{...s,id:"b"}]},
    {...input,notes:[p,{...s,body:"private secret"}]},
    {...input,notes:[p,{...s,members:["erin"]}]},
    {...input,notes:[p,{...s,projectId:".."}]},
    {...input,notes:[p,{...s,title:""}]},
    {...input,notes:[p,{...s,revision:-1}]},
    {...input,notes:[p,{...s,areaId:"bob-private"}]},
    {...input,notes:[{...p,areaKind:"shared"},s]},
    {...input,notes:[p,{...s,id:"."}]},
    {...input,notes:[p,{...s,id:"x".repeat(513)}]},
    {...input,notes:[p],hasMore:true},
    {...input,areaEpochs:[personal]},
    {...input,noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:3}]},
    {...input,noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:3},
      {areaId:"elsewhere",noteSyncRevision:4}]},
    {...input,noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:-1},
      {areaId:"family-area",noteSyncRevision:4}]},
    {...input,linearization:{...input.linearization,areas:[
      {...input.linearization.areas[0],access:"viewer"},
      input.linearization.areas[1]]}},
  ])assert.equal(parse(invalid),null,JSON.stringify(invalid).slice(0,130));
});
