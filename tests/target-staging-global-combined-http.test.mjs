import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const names=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3m8-global-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"untouched");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"isolated-global-combined-http-secret-more-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED:"false",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED:"false",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/global-index/route.ts");
const {GET:NOTES}=await import("../app/api/target-staging/note-index/global/route.ts");
const {GET:PROJECTS}=await import("../app/api/target-staging/project-index/global/route.ts");
const {parseStagingGlobalCombinedPage,readStagingGlobalCombinedPageInChild}=
  await import("../lib/target-staging-read-process.ts");
const {signGlobalCombinedCursor,verifyGlobalCombinedCursor}=
  await import("../lib/target-staging-global-combined-http-cursor.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let serial=0;const fixtures=[];
after(()=>{
  for(const f of fixtures)f.db.close();
  for(const [k,v]of Object.entries(old)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"untouched");
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
  for(const row of [
    ["a-alice",stage.unassignedAreaId,"Alice private project"],
    ["b-bob","bob-private","Bob private project"],
    ["c-carol","carol-private","Carol private project"],
    ["e-erin","erin-private","Erin secret project"],
    ["s-empty","family-area","Shared empty project"],
    ["s-shared","family-area","Shared project"],
    ["z-hidden","hidden-area","Erin hidden project"],
  ])project.run(...row);
  const task=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private task"],
    ["b-bob","bob-private",null,"Bob private task"],
    ["c-carol","carol-private",null,"Carol private task"],
    ["e-erin","erin-private",null,"Erin secret task"],
    ["s-shared",null,"s-shared","Unassigned shared task"],
    ["z-hidden",null,"z-hidden","Erin hidden task"],
  ])task.run(...row);
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  for(const row of [
    ["a-alice",stage.unassignedAreaId,null,"Alice private note","Alice BODY secret"],
    ["b-bob","bob-private",null,"Bob private note","Bob BODY secret"],
    ["c-carol","carol-private",null,"Carol private note","Carol BODY secret"],
    ["e-erin","erin-private",null,"Erin secret note","Erin BODY secret"],
    ["s-shared",null,"s-shared","Shared inherited note","Shared BODY secret"],
    ["z-hidden",null,"z-hidden","Erin hidden note","Erin BODY secret"],
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
const base="http://localhost:3001/api/target-staging/global-index";
const owner=()=>sessionCookieName+"="+createSessionToken();
const req=(query="",cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.78.4"},
});
const get=(query="",cookie=owner())=>GET(req(query,cookie));
const labels=p=>p.items.map(x=>x.kind+":"+x.item.id);
function login(f,who){
  const issued=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
async function ok(promise){
  const response=await promise;
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),["hasMore","items","nextCursor","scope"]);
  for(const x of body.items){
    assert.deepEqual(Object.keys(x).sort(),["item","kind"]);
    const k=x.kind;
    assert.ok(["project","task","note"].includes(k));
    assert.deepEqual(Object.keys(x.item).sort(),
      (k==="project"?["areaId","areaKind","id","title"]:
        k==="task"?["areaId","areaKind",
          ...(x.item.areaKind==="shared"?["assignedToMe"]:[]),
          "dueOn","id","projectId","status","title"]:
          ["areaId","areaKind","id","projectId","revision","title"]).sort());
  }
  for(const k of ["areaEpochs","noteAreaEpochs","linearization",
    "revision","nextPositions","actorUserId"])
    assert.equal(k in body,false,k);
  const payload=JSON.stringify(body);
  for(const word of ["Alice BODY","Bob BODY","Shared BODY",
    "Erin BODY","members","owner_user_id"])
    assert.ok(!payload.includes(word),word);
  return body;
}
test("default-off flag is isolated and authenticated owner required",async()=>{
  fixture();
  for(const k of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED"]){
    process.env[k]="false";
    assert.equal((await get()).status,404,k);
    process.env[k]="true";
  }
  assert.equal((await GET(new Request(base))).status,401);
  assert.deepEqual(labels(await ok(get())),[
    "project:a-alice","task:a-alice","note:a-alice",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared",
  ]);
  assert.equal((await NOTES(new Request(
    "http://localhost:3001/api/target-staging/note-index/global",
    {headers:{cookie:owner()}}))).status,404);
  assert.equal((await PROJECTS(new Request(
    "http://localhost:3001/api/target-staging/project-index/global",
    {headers:{cookie:owner()}}))).status,404);
});
test("global Vše has editor/viewer shared work and only actor-owned private data",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),
    erin=login(f,"erin");
  const expected=[
    "project:b-bob","task:b-bob","note:b-bob",
    "project:s-empty","project:s-shared","task:s-shared","note:s-shared",
  ];
  assert.deepEqual(labels(await ok(get("?scope=all",bob))),expected);
  assert.deepEqual(labels(await ok(get("?scope=personal",bob))),
    expected.slice(0,3));
  assert.deepEqual(labels(await ok(get("?scope=shared",bob))),
    expected.slice(3));
  assert.deepEqual(labels(await ok(get("?scope=all",carol))),[
    "project:c-carol","task:c-carol","note:c-carol",
    ...expected.slice(3),
  ]);
  assert.deepEqual(labels(await ok(get("?scope=all",erin))),[
    "project:e-erin","task:e-erin","note:e-erin",
    "project:z-hidden","task:z-hidden","note:z-hidden",
  ]);
  const shared=await ok(get("?scope=shared",carol));
  const inherited=shared.items.find(x=>x.kind==="note");
  assert.equal(inherited.item.projectId,"s-shared");
  assert.equal(inherited.item.areaId,"family-area");
  const task=shared.items.find(x=>x.kind==="task");
  assert.equal(task.item.assignedToMe,false);
  assert.ok(!JSON.stringify(shared).includes("Bob private"));
});
test("bounded mixed HMAC cursor preserves typed ID ties across all pages",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const expected=labels(await ok(get("?scope=all",bob)));
  for(const limit of [1,2,3]){
    let cursor=null,seen=[],rounds=0;
    while(true){
      const q="?scope=all&limit="+limit+
        (cursor?"&cursor="+encodeURIComponent(cursor):"");
      const page=await ok(get(q,bob));
      assert.ok(page.items.length<=limit);
      seen.push(...labels(page));
      if(!page.hasMore){assert.equal(page.nextCursor,null);break;}
      assert.match(page.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      cursor=page.nextCursor;
      assert.ok(++rounds<12,"page traversal must terminate");
    }
    assert.deepEqual(seen,expected,"limit="+limit);
  }
});
test("query allowlist, cross-service, actor/session/scope/limit and stale cursor",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  for(const q of ["?scope=my-plan","?scope=unknown","?scope=all&scope=shared",
    "?limit=0","?limit=101","?limit=01","?limit=-1",
    "?limit=1&limit=2","?cursor=abc","?cursor=a.b&cursor=c.d",
    "?actor=erin","?offset=1","?positions=0,0,0","?noteBody=true"]){
    assert.equal((await get(q,bob)).status,400,q);
  }
  const query="?scope=all&limit=1",first=await ok(get(query,bob));
  assert.deepEqual(labels(first),["project:b-bob"]);
  const suffix="&cursor="+encodeURIComponent(first.nextCursor);
  assert.deepEqual(labels(await ok(get(query+suffix,bob))),["task:b-bob"]);
  for(const q of ["?scope=shared&limit=1","?scope=personal&limit=1",
    "?scope=all&limit=2"])
    assert.equal((await get(q+suffix,bob)).status,400);
  assert.equal((await get(query+suffix,carol)).status,400);
  assert.equal((await get(query+suffix,owner())).status,400);
  assert.equal((await get(query+"&cursor="+
    encodeURIComponent(first.nextCursor.slice(0,-1)+"x"),bob)).status,400);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED="true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED="true";
  assert.equal((await NOTES(new Request(
    "http://localhost:3001/api/target-staging/note-index/global"+query+suffix,
    {headers:{cookie:bob}}))).status,400);
  assert.equal((await PROJECTS(new Request(
    "http://localhost:3001/api/target-staging/project-index/global"+query+suffix,
    {headers:{cookie:bob}}))).status,400);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED="false";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED="false";
  f.db.prepare("UPDATE notes SET body='body-only edit' WHERE id='s-shared'").run();
  assert.equal((await get(query+suffix,bob)).status,409);
});
test("cursor expiry and raw position tampering fail closed",()=>{
  const context={actorUserId:"bob",authenticationBinding:"x".repeat(43),
    stagingDirectory:"/tmp/isolated",restoreGeneration:"g",
    sessionSecret:"safe-test-secret-longer-than-thirty-two",
    scope:"all",limit:1};
  const positions={projects:1,tasks:0,notes:0};
  const token=signGlobalCombinedCursor(context,"a".repeat(64),positions,
    undefined,1000);
  assert.ok(token);
  assert.deepEqual(verifyGlobalCombinedCursor(context,token,1001),{
    ok:true,positions,revision:"a".repeat(64),expiresAt:1900,
  });
  assert.deepEqual(verifyGlobalCombinedCursor(context,token,1900),{
    ok:false,reason:"expired",
  });
  for(const bad of [{projects:0,tasks:0,notes:0},
    {projects:-1,tasks:0,notes:0},{projects:1,tasks:0,notes:0,actor:"erin"}])
    assert.equal(signGlobalCombinedCursor(context,"a".repeat(64),bad,null,1000),null);
  assert.equal(verifyGlobalCombinedCursor({...context,limit:2},token,1001).ok,false);
  assert.equal(verifyGlobalCombinedCursor({...context,scope:"shared"},token,1001).ok,false);
});
test("live guard rejects note edits, newly granted empty Areas and revocations",async()=>{
  const f=fixture(),carol=login(f,"carol");
  const tokenHash=durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const child=()=>readStagingGlobalCombinedPageInChild({
    stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:tokenHash,
  },"all",100,{projects:0,tasks:0,notes:0});
  const live=p=>verifyStagingReadBeforeRelease(
    req("?scope=all",carol),{kind:"session",tokenHash},
    f.store,"alice",p.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:p.areaEpochs,scope:"global-all",noteAreaEpochs:p.noteAreaEpochs},
  );
  const before=await child();assert.ok(before);
  assert.equal(live(before),"ok");
  f.db.prepare("UPDATE notes SET body='changed after child' WHERE id='s-shared'").run();
  assert.equal(live(before),"stale");
  const fresh=await child();assert.ok(fresh);
  assert.equal(live(fresh),"ok");
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('added','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('added-area','Empty area','shared','added','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('added-area','carol','viewer')").run();
  assert.equal(live(fresh),"stale");
  const granted=await child();assert.ok(granted);
  assert.deepEqual(labels(granted),labels(fresh));
  assert.ok(granted.noteAreaEpochs.some(a=>a.areaId==="added-area"));
  assert.equal(live(granted),"ok");
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(live(granted),"stale");
  assert.deepEqual(labels(await ok(get("?scope=all",carol))),[
    "project:c-carol","task:c-carol","note:c-carol",
  ]);
  const revoked=await child();assert.ok(revoked);
  assert.equal(live(revoked),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"carol").ok,true);
  assert.notEqual(live(revoked),"ok");
});
test("strict mixed child DTO rejects bodies, extra fields, order and missing witnesses",()=>{
  const personal={areaId:"bob-private",areaKind:"private",access:"private-owner",
    policyRevision:0,contentRevision:1,projectContentRevision:1};
  const shared={areaId:"family-area",areaKind:"shared",access:"viewer",
    policyRevision:0,contentRevision:2,projectContentRevision:2};
  const p={kind:"project",item:{id:"b",title:"Private project",
    areaId:"bob-private",areaKind:"private"}};
  const t={kind:"task",item:{id:"b",title:"Private task",
    projectId:null,areaId:"bob-private",areaKind:"private",
    status:"open",dueOn:null}};
  const n={kind:"note",item:{id:"b",title:"Private note",
    projectId:null,areaId:"bob-private",areaKind:"private",revision:1}};
  const input={ok:true,scope:"all",hasMore:true,revision:"a".repeat(64),
    items:[p,t,n],nextPositions:{projects:1,tasks:1,notes:1},
    linearization:{actorUserId:"bob",areas:[
      {areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0},
      {areaId:"family-area",areaKind:"shared",access:"viewer",policyRevision:0},
    ]},areaEpochs:[personal,shared],
    noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:3},
      {areaId:"family-area",noteSyncRevision:4}],
  };
  const parse=x=>parseStagingGlobalCombinedPage(x,"all",3,
    {projects:0,tasks:0,notes:0});
  assert.deepEqual(labels(parse(input)),["project:b","task:b","note:b"]);
  for(const bad of [
    {...input,debug:"secret"},
    {...input,scope:"my-plan"},
    {...input,items:[t,p,n]},
    {...input,items:[p,n,t]},
    {...input,items:[p,t,{...n,item:{...n.item,body:"secret"}}]},
    {...input,items:[p,{...t,item:{...t.item,assignedToMe:false}},n]},
    {...input,items:[p,t,{...n,item:{...n.item,id:"."}}]},
    {...input,items:[p,t,{...n,item:{...n.item,revision:-1}}]},
    {...input,items:[p,t,{...n,item:{...n.item,areaId:"unreadable"}}]},
    {...input,items:[p,t,{...n,item:{...n.item,projectId:".."}}]},
    {...input,items:[p,t,{...n,item:{...n.item,title:""}}]},
    {...input,items:[p,t,{...n,item:{...n.item,title:"x".repeat(4097)}}]},
    {...input,items:[p,t],nextPositions:{projects:1,tasks:1,notes:1}},
    {...input,nextPositions:{projects:1,tasks:0,notes:1}},
    {...input,nextPositions:{projects:1,tasks:1,notes:1,actor:"erin"}},
    {...input,hasMore:false},
    {...input,areaEpochs:[personal]},
    {...input,noteAreaEpochs:[{areaId:"bob-private",noteSyncRevision:3}]},
    {...input,noteAreaEpochs:[{areaId:"elsewhere",noteSyncRevision:3},
      {areaId:"family-area",noteSyncRevision:4}]},
    {...input,linearization:{...input.linearization,areas:[
      {...input.linearization.areas[0],access:"viewer"},
      input.linearization.areas[1]]}},
  ])assert.equal(parse(bad),null,JSON.stringify(bad).slice(0,110));
});
