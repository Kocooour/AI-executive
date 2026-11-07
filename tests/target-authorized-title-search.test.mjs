import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d4a-title-search-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"untouched");
const saved=process.env.AI_EXECUTIVE_DATA_DIR;
const httpEnv=["NODE_ENV","AI_EXECUTIVE_AUTH_ENABLED","AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET","AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const oldHttp=Object.fromEntries(httpEnv.map(key=>[key,process.env[key]]));
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-title-search-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED:"true",
});

process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedTitleSearchPage,validAuthorizedTitleQuery}=
  await import("../lib/target-authorized-title-search.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET:searchGET}=await import("../app/api/target-staging/title-search/route.ts");
const {parseStagingTitleSearchPage}=await import("../lib/target-staging-read-process.ts");
const {createStagingTitleSearchSession}=
  await import("../lib/target-staging-title-search-session.ts");

let serial=0;const fixtures=[];
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
  for(const [area,who,role]of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
    .run(area,who,role);
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
    ["s-shared",null,"s-shared","Shared unassigned task"],
    ["z-hidden",null,"z-hidden","Erin hidden task"],
    ["wild",null,"s-shared","100% Shared _plan!"],
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
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const authority=new TargetStagingSessionAuthority(store);
  const f={stage,store,db,reader,authority};fixtures.push(f);return f;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  for(const [key,value] of Object.entries(oldHttp)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  if(saved===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=saved;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"untouched");
  rmSync(root,{recursive:true,force:true});
});
const page=(f,who="bob",scope="all",query="Shared",extra={})=>
  readAuthorizedTitleSearchPage(f.reader,{
    actorUserId:who,scope,query,limit:50,offset:0,
    restoreGeneration:f.stage.restoreGeneration,...extra,
  });
const labels=p=>p.items.map(i=>i.kind+":"+i.id);
const guard=(f,hash,p)=>durable.verifyTargetStagingReadLive(
  f.store,{tokenHash:hash},p.linearization,Date.now(),
  undefined,undefined,undefined,undefined,undefined,
  {areas:p.areaEpochs,scope:p.scope==="all"?"global-all":p.scope,
    noteAreaEpochs:p.noteAreaEpochs},
);

test("actor/Area SQL ACL before LIMIT, mixed types and inherited Area",()=>{
  const f=fixture();
  assert.deepEqual(labels(page(f)),[
    "project:s-empty","project:s-shared","task:s-shared",
    "note:s-shared","task:wild",
  ]);
  assert.deepEqual(labels(page(f,"carol","shared")),labels(page(f)));
  assert.deepEqual(labels(page(f,"bob","personal","Bob")),[
    "project:b-bob","task:b-bob","note:b-bob",
  ]);
  assert.deepEqual(labels(page(f,"bob","shared","Bob")),[]);
  assert.deepEqual(labels(page(f,"bob","all","Erin")),[]);
  assert.deepEqual(labels(page(f,"erin","all","Erin")),[
    "project:e-erin","task:e-erin","note:e-erin",
    "project:z-hidden","task:z-hidden","note:z-hidden",
  ]);
  assert.deepEqual(labels(page(f,"bob","all","BODY")),[],
    "note bodies must never be searched or released");
  const body=JSON.stringify(page(f));
  for(const secret of ["Erin","Alice","BODY secret","owner_user_id"])
    assert.equal(body.includes(secret),false,secret);
  const note=page(f).items.find(i=>i.kind==="note");
  assert.equal(note.projectId,"s-shared");
  assert.equal(note.areaId,"family-area");
  const prj=page(f).items.find(i=>i.kind==="project");
  assert.equal("projectId" in prj,false);
});

test("literal wildcard escaping, deterministic BINARY pagination and case",()=>{
  const f=fixture();
  assert.deepEqual(labels(page(f,"bob","all","100%")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","_plan")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","an!")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","%_")),[]);
  assert.deepEqual(labels(page(f,"bob","all","sHaReD")),labels(page(f)));
  const expected=labels(page(f));
  for(const limit of [1,2,3,4]){
    let offset=0,found=[],revision=null;
    for(let i=0;i<10;i++){
      const p=page(f,"bob","all","Shared",{limit,offset});
      assert.ok(p);
      found.push(...labels(p));
      if(revision)assert.equal(p.revision,revision);
      revision=p.revision;
      if(!p.hasMore){
        assert.equal(p.nextOffset,null);
        break;
      }
      assert.equal(p.nextOffset,offset+p.items.length);
      offset=p.nextOffset;
    }
    assert.deepEqual(found,expected);
  }
});

test("R2d.4b conjunctive multi-term title search ignores term order but preserves ACL",()=>{
  const f=fixture();
  const projects=["project:s-empty","project:s-shared"];
  assert.deepEqual(labels(page(f,"bob","all","project Shared")),projects);
  assert.deepEqual(labels(page(f,"bob","all","Shared project")),projects);
  assert.deepEqual(labels(page(f,"bob","all","Shared    project")),projects);
  assert.deepEqual(labels(page(f,"bob","all","Bob task")),["task:b-bob"]);
  assert.deepEqual(labels(page(f,"bob","all","task Bob")),["task:b-bob"]);
  assert.deepEqual(labels(page(f,"bob","all","Shared inherited")),["note:s-shared"]);
  assert.deepEqual(labels(page(f,"bob","all","Shared 100%")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","_plan! Shared")),["task:wild"]);
  assert.deepEqual(labels(page(f,"bob","all","Shared secret")),[]);
  assert.deepEqual(labels(page(f,"bob","all","Erin hidden")),[],
    "AND terms must not leak foreign project/task/note titles");
  assert.deepEqual(labels(page(f,"bob","shared","Bob task")),[]);
  // SQL LIMIT/OFFSET remain after ACL and the full AND-of-terms filter.
  const first=page(f,"bob","all","project Shared",{limit:1,offset:0});
  const second=page(f,"bob","all","project Shared",{limit:1,offset:1});
  assert.deepEqual(labels(first),projects.slice(0,1));
  assert.deepEqual(labels(second),projects.slice(1));
  assert.equal(first.hasMore,true);
  assert.equal(first.nextOffset,1);
  assert.equal(second.hasMore,false);
  assert.equal(second.nextOffset,null);
  assert.equal(first.revision,second.revision);
  assert.notEqual(first.revision,page(f,"bob","all","Shared project").revision,
    "revision remains tied to the original query for future bound cursors");
  assert.equal(validAuthorizedTitleQuery("a b c d e f g h"),true);
  assert.equal(validAuthorizedTitleQuery("a b c d e f g h i"),false);
  assert.equal(page(f,"bob","all","a b c d e f g h i"),null);
});

test("strict input validation and no direct actor-based HTTP exposure",()=>{
  const f=fixture();
  for(const q of ["","x"," Shared","Shared ","a".repeat(81),
    "some\nquery","hi\u0000there","\ud800invalid"])
    assert.equal(validAuthorizedTitleQuery(q),false,q);
  assert.equal(validAuthorizedTitleQuery("100%"),true);
  assert.equal(validAuthorizedTitleQuery("%_"),true);
  for(const override of [
    {actorUserId:"bob' OR 1=1"},{actorUserId:""},
    {scope:"my-plan"},{query:"x"},{query:" Shared"},
    {limit:0},{limit:51},{limit:1.1},{offset:-1},
    {offset:1_000_001},{offset:0.25},{restoreGeneration:"wrong"},
  ])assert.equal(page(f,"bob","all","Shared",override),null,JSON.stringify(override));
});

test("signed staging authority, complete live ACL and note-sync epoch fences",()=>{
  const f=fixture();
  const issued=durable.issueDurableTargetStagingSession(f.store,"carol",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const before=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.ok(before);
  assert.deepEqual(labels(before),labels(page(f,"carol")));
  assert.equal(guard(f,hash,before).ok,true);
  // A body-only edit must invalidate even a title-only search.
  f.db.prepare("UPDATE notes SET body='changed only in body' WHERE id='s-shared'").run();
  assert.equal(guard(f,hash,before).reason,"stale");
  const after=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.notEqual(after.revision,before.revision);
  assert.equal(guard(f,hash,after).ok,true);
  // Gaining an EMPTY Area must also stale the previous witness.
  f.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('fresh-ws','shared','alice')").run();
  f.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('fresh-area','Fresh','shared','fresh-ws','alice')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','alice','admin')").run();
  f.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('fresh-area','carol','viewer')").run();
  assert.equal(guard(f,hash,after).reason,"stale");
  const gained=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.deepEqual(labels(gained),labels(after));
  assert.equal(guard(f,hash,gained).ok,true);
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  assert.equal(guard(f,hash,gained).reason,"stale");
  const revoked=f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0);
  assert.deepEqual(labels(revoked),[]);
  assert.equal(guard(f,hash,revoked).ok,true);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"carol").ok,true);
  assert.notEqual(guard(f,hash,revoked).ok,true);
  f.authority.close();
  assert.equal(f.authority.readAuthorizedTitleSearchPage("carol","all","Shared",10,0),null);
});

function httpFor(f){
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:f.stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:f.stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
}
const url="http://localhost:3001/api/target-staging/title-search";
const ownerCookie=()=>sessionCookieName+"="+createSessionToken();
function loginHttp(f,who){
  const issued=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
function httpRequest(params="q=Shared",cookie=ownerCookie()){
  return searchGET(new Request(url+"?"+params,{headers:{
    cookie,"x-forwarded-for":"10.79.37."+Math.max(1,serial),
  }}));
}
async function httpOk(promise){
  const res=await promise,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),
    ["hasMore","items","nextCursor","query","scope"]);
  for(const item of body.items)
    assert.deepEqual(Object.keys(item).sort(),
      (item.kind==="project"
        ?["areaId","areaKind","id","kind","title"]
        :["areaId","areaKind","id","kind","projectId","title"]));
  for(const field of ["linearization","areaEpochs","noteAreaEpochs",
    "revision","actorUserId","restoreGeneration"])
    assert.equal(field in body,false,field);
  const serialized=JSON.stringify(body);
  for(const forbidden of ["BODY secret","owner_user_id","Erin hidden",
    "Alice private","Bob BODY","Carol BODY"])
    assert.equal(serialized.includes(forbidden),false,forbidden);
  return body;
}
test("R2d.4c HTTP independent default-off and strict query validation",async()=>{
  const f=fixture();httpFor(f);
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await httpRequest()).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await searchGET(new Request(url+"?q=Shared"))).status,401);
  for(const q of ["","q=x","q=+Shared","q=Shared+","q=Shared&q=Shared",
    "q=Shared&scope=foreign","q=Shared&scope=all&scope=shared",
    "q=Shared&limit=0","q=Shared&limit=51","q=Shared&limit=01",
    "q=Shared&actor=erin","q=Shared&offset=1",
    "q=Shared&cursor=bad", "q=Shared&cursor=a.b&cursor=a.b",
    "q=a+b+c+d+e+f+g+h+i"]){
    assert.equal((await httpRequest(q)).status,400,q);
  }
  const ok=await httpOk(httpRequest("q=Shared&scope=all"));
  assert.deepEqual(ok.items.map(x=>x.kind+":"+x.id),
    ["project:s-empty","project:s-shared","task:s-shared",
      "note:s-shared","task:wild"]);
});
test("R2d.4c HTTP actor ACL, multiword matching and HMAC continuation",async()=>{
  const f=fixture();httpFor(f);
  const bob=loginHttp(f,"bob"),carol=loginHttp(f,"carol");
  assert.deepEqual((await httpOk(httpRequest("q=Bob+task",bob))).items.map(x=>x.id),
    ["b-bob"]);
  assert.deepEqual((await httpOk(httpRequest("q=Bob+task&scope=shared",bob))).items,[]);
  assert.deepEqual((await httpOk(httpRequest("q=Erin",bob))).items,[]);
  assert.deepEqual((await httpOk(httpRequest("q=Shared&scope=shared",carol))).items.length,5);
  const first=await httpOk(httpRequest("q=Shared&scope=all&limit=1",bob));
  assert.deepEqual(first.items.map(x=>x.kind+":"+x.id),["project:s-empty"]);
  assert.equal(first.hasMore,true);
  assert.match(first.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const cursor=encodeURIComponent(first.nextCursor);
  const second=await httpOk(httpRequest("q=Shared&scope=all&limit=1&cursor="+cursor,bob));
  assert.deepEqual(second.items.map(x=>x.kind+":"+x.id),["project:s-shared"]);
  for(const [params,cookie] of [
    ["q=Shared&scope=all&limit=1&cursor="+cursor,carol],
    ["q=project+Shared&scope=all&limit=1&cursor="+cursor,bob],
    ["q=Shared&scope=personal&limit=1&cursor="+cursor,bob],
    ["q=Shared&scope=all&limit=2&cursor="+cursor,bob],
    ["q=Shared&scope=all&limit=1&cursor="+cursor.slice(0,-1)+"X",bob],
  ])assert.equal((await httpRequest(params,cookie)).status,400,params);
  // Even a body-only edit changes note_sync epoch and invalidates cursor.
  f.db.prepare("UPDATE notes SET body='new secret content' WHERE id='s-shared'").run();
  assert.equal((await httpRequest("q=Shared&scope=all&limit=1&cursor="+cursor,bob)).status,409);
  assert.deepEqual((await httpOk(httpRequest("q=Shared",bob))).items.length,5);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(
    f.store,"bob").ok,true);
  assert.equal((await httpRequest("q=Shared",bob)).status,401);
});
test("R2d.4c fail-closed child DTO requires all Area and note witnesses",()=>{
  const f=fixture();
  const internal=page(f,"bob","all","Shared");
  assert.ok(internal);
  const dto={ok:true,...internal};
  assert.ok(parseStagingTitleSearchPage(dto,"all",50,0));
  assert.equal(parseStagingTitleSearchPage({...dto,noteAreaEpochs:[]},"all",50,0),null);
  assert.equal(parseStagingTitleSearchPage({...dto,areaEpochs:[]},"all",50,0),null);
  assert.equal(parseStagingTitleSearchPage({...dto,extra:"leak"},"all",50,0),null);
  assert.equal(parseStagingTitleSearchPage({...dto,items:[
    {...dto.items[0],title:" "},...dto.items.slice(1)]},"all",50,0),null);
  assert.equal(parseStagingTitleSearchPage({...dto,items:[
    dto.items[0],dto.items[0],...dto.items.slice(2)]},"all",50,0),null);
  assert.equal(parseStagingTitleSearchPage({...dto,nextOffset:1},"all",50,0),null);
});

test("BE-19 live HTTP → streaming client → session: ACL, stale and revocation",async()=>{
  const f=fixture();httpFor(f);
  let cookie=loginHttp(f,"bob"),calls=0;
  const session=createStagingTitleSearchSession(async(resource,init)=>{
    calls++;
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    const req=new Request(new URL(resource,url),{
      method:init.method,
      signal:init.signal,
      headers:{
        cookie,"x-forwarded-for":"10.89.42."+Math.max(1,serial),
      },
    });
    return searchGET(req);
  });
  const opts={query:"Shared",scope:"shared",limit:1};
  assert.deepEqual(await session.first(opts),{ok:true});
  assert.deepEqual(session.getSnapshot().items.map(x=>x.kind+":"+x.id),
    ["project:s-empty"]);
  assert.deepEqual(await session.next(),{ok:true});
  assert.deepEqual(session.getSnapshot().items.map(x=>x.kind+":"+x.id),
    ["project:s-empty","project:s-shared"]);

  // A note body mutation changes the server-side note epoch; old cursor
  // cannot be appended, even if the titles themselves did not change.
  f.db.prepare("UPDATE notes SET body='changed after first pages' WHERE id='s-shared'").run();
  assert.deepEqual(await session.next(),{ok:false,reason:"stale"});
  assert.equal(session.getSnapshot().status,"error");
  assert.deepEqual(session.getSnapshot().items,[]);
  assert.equal(session.getSnapshot().nextCursor,null);

  assert.deepEqual(await session.first(opts),{ok:true});
  assert.deepEqual(await session.next(),{ok:true});
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.deepEqual(await session.next(),{ok:false,reason:"signed-out"});
  assert.deepEqual(session.getSnapshot().items,[]);
  assert.equal(session.getSnapshot().query,null);

  // The consuming UI must reset on a session switch, not reuse an old cursor.
  session.reset();
  cookie=loginHttp(f,"carol");
  assert.deepEqual(await session.first({query:"Bob",scope:"personal",limit:1}),
    {ok:true});
  assert.deepEqual(session.getSnapshot().items,[],
    "Carol must never observe Bob's private project/task/note titles");
  assert.equal(session.getSnapshot().hasMore,false);
  assert.equal(session.getSnapshot().failure,null);
  assert.equal(calls,7,"explicit requests only, never automatic retry");
});
