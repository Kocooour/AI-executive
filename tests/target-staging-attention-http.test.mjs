import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const before=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5c1-attention-http-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-attention-http-session-secret-longer-than-32",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED:"true",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET}=await import("../app/api/target-staging/attention/route.ts");
const {readStagingAttentionInChild,parseStagingAttentionPage}=
  await import("../lib/target-staging-read-process.ts");
const {verifyStagingReadBeforeRelease}=
  await import("../lib/target-staging-http-identity.ts");
let serial=0;const fixtures=[];
after(()=>{
  for(const fx of fixtures)fx.db.close();
  for(const [key,value] of Object.entries(before)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const {attentionKey,attentionEvaluationWindow}=
  await import("../lib/target-attention-read-model.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
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
  const insert=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  // Dates far in the past: always overdue/passed against the real server clock.
  for(const row of [
    ["p-alice",stage.unassignedAreaId,null,"Alice secret",null,"2020-01-01"],
    ["p-bob1","bob-private",null,"Bob one",null,"2020-01-01"],
    ["p-bob2","bob-private",null,"Bob two",null,"2020-01-02"],
    ["p-bobplan","bob-private",null,"Bob planned",null,null],
    ["s-bob","family-area",null,"Assigned Bob","bob","2020-01-03"],
    ["s-alice","family-area",null,"Assigned Alice","alice","2020-01-01"],
    ["s-unassigned","family-area",null,"Unassigned",null,"2020-01-01"],
    ["p-erin","erin-private",null,"Erin secret",null,"2020-01-01"],
    ["hidden","hidden-area",null,"Hidden","erin","2020-01-01"],
  ])insert.run(...row);
  db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES ('bob','p-bobplan','2020-01-05')").run();
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  const fx={db,store,stage};fixtures.push(fx);return fx;
}
const base="http://localhost:3001/api/target-staging/attention";
const TZ="Europe/Prague";
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(f,who){
  const session=durable.issueDurableTargetStagingSession(f.store,who,900);
  assert.equal(session.ok,true,JSON.stringify(session));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+session.sessionToken;
}
function q(o={}){
  const p=new URLSearchParams({timeZone:TZ,...o});
  for(const [k,v] of Object.entries(p))if(v===null)p.delete(k);
  return "?"+p.toString();
}
const req=(query,cookie=owner())=>new Request(base+query,{
  headers:{cookie,"x-forwarded-for":"10.9.76.1"},
});
const get=(query,cookie=owner())=>GET(req(query,cookie));
const ids=p=>p.items.map(t=>t.taskId);
const KEYS=["areaFilter","attentionEpoch","evaluatedAtMs","evaluationDate","hasMore",
  "items","nextCursor","soonThroughDate","timeZone","view"];
const ITEM_KEYS=["areaId","areaKind","attentionKey","dueOn","lifecycle","lifecycleRevision",
  "projectId","reasonCode","relevantAt","relevantOn","ruleId","ruleVersion","severity",
  "snoozedUntilMs","sourceRevision","subjectType","taskId","thresholdHours","title","whenOn"];
async function ok(request){
  const res=await request,body=await res.json();
  assert.equal(res.status,200,JSON.stringify(body));
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),KEYS);
  for(const k of ["privateEpoch","linearization","areaEpochs","revision","actor","actorUserId"])
    assert.equal(k in body,false);
  assert.equal(Number.isSafeInteger(body.attentionEpoch),true);
  for(const item of body.items){
    const expect=item.areaKind==="shared"?[...ITEM_KEYS,"assignedToMe"]:ITEM_KEYS;
    assert.deepEqual(Object.keys(item).sort(),expect.sort());
    if(item.areaKind==="shared")assert.equal(item.assignedToMe,true);
  }
  return body;
}
const dismiss=(f,who,task,rule="deadline_overdue",on="2020-01-01")=>
  f.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES (?,?,?,?,'dismissed',NULL)")
    .run(who,task,rule,on);

test("two explicit default-off staging gates and authenticated owner",async()=>{
  fixture();
  for(const flag of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED"]){
    process.env[flag]="false";
    assert.equal((await get(q())).status,404,flag);
    delete process.env[flag];
    assert.equal((await get(q())).status,404,flag+" unset");
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+q()))).status,401);
  const body=await ok(get(q()));
  assert.deepEqual(ids(body),["p-alice","s-alice"]);
  assert.equal(body.view,"active");assert.equal(body.areaFilter,"all");
  assert.equal(body.timeZone,TZ);assert.equal(body.hasMore,false);
});

test("strict query allowlist, duplicates and bounds",async()=>{
  fixture();
  const bad=[
    "","?areaFilter=all","?timeZone=Not/AZone","?timeZone=",
    "?timeZone=../../etc","?timeZone="+"A".repeat(65),
    q({areaFilter:"none"}),q({view:"all"}),q({view:"snoozed"}),
    q()+"&timeZone=UTC",q()+"&view=active&view=active",
    q()+"&areaFilter=all&areaFilter=all",q()+"&limit=1&limit=2",
    q()+"&evaluatedAtMs=1",q()+"&now=1",q()+"&actor=bob",q()+"&offset=1",
    q()+"&limit=0",q()+"&limit=101",q()+"&limit=01",q()+"&limit=1.5",
    q()+"&cursor=nope",q()+"&cursor=a%00b",q()+"&cursor=a.b&cursor=a.b",
    q()+"&cursor="+"a".repeat(4097),
  ];
  for(const query of bad)assert.equal((await get(query)).status,400,query);
});

test("owner and session actors see only their own candidates; viewer sees none",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol"),erin=login(f,"erin");
  assert.deepEqual(ids(await ok(get(q(),bob))),["p-bob1","p-bob2","s-bob","p-bobplan"]);
  assert.deepEqual(ids(await ok(get(q({areaFilter:"personal"}),bob))),["p-bob1","p-bob2","p-bobplan"]);
  assert.deepEqual(ids(await ok(get(q({areaFilter:"shared"}),bob))),["s-bob"]);
  assert.deepEqual(ids(await ok(get(q(),carol))),[]);
  assert.deepEqual(ids(await ok(get(q(),erin))),["hidden","p-erin"]);
  const body=await ok(get(q(),bob)),text=JSON.stringify(body);
  for(const s of ["Alice secret","Erin secret","Unassigned","Assigned Alice"])
    assert.ok(!text.includes(s),s);
  const first=body.items[0];
  assert.equal(first.attentionKey,attentionKey("deadline_overdue","p-bob1","2020-01-01"));
  assert.equal(first.lifecycle,"active");assert.equal(first.lifecycleRevision,null);
  assert.equal(body.items[3].ruleId,"planned_date_passed");
  assert.equal(body.items[3].whenOn,"2020-01-05");
  const w=attentionEvaluationWindow(body.evaluatedAtMs,TZ);
  assert.equal(body.evaluationDate,w.evaluationDate);
  assert.equal(body.soonThroughDate,w.soonThroughDate);
  assert.ok(Math.abs(body.evaluatedAtMs-Date.now())<60000);
});

test("hidden view appears once the actor's own lifecycle row exists",async()=>{
  const f=fixture(),bob=login(f,"bob"),alice=owner();
  const before=await ok(get(q(),bob));
  assert.deepEqual(ids(await ok(get(q({view:"hidden"}),bob))),[]);
  dismiss(f,"bob","p-bob1");
  const active=await ok(get(q(),bob)),hidden=await ok(get(q({view:"hidden"}),bob));
  assert.deepEqual(ids(active),["p-bob2","s-bob","p-bobplan"]);
  assert.deepEqual(ids(hidden),["p-bob1"]);
  assert.equal(hidden.items[0].lifecycle,"dismissed");
  assert.equal(hidden.items[0].snoozedUntilMs,null);
  assert.equal(Number.isSafeInteger(hidden.items[0].lifecycleRevision),true);
  assert.ok(active.attentionEpoch>before.attentionEpoch);
  // Another actor's lifecycle state never leaks across actors.
  assert.deepEqual(ids(await ok(get(q({view:"hidden"}),alice))),[]);
  assert.deepEqual(ids(await ok(get(q(),alice))),["p-alice","s-alice"]);
  // A future snooze is hidden and carries its end time.
  f.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES ('bob','p-bob2','deadline_overdue','2020-01-02','snoozed',?)")
    .run(Date.now()+3_600_000);
  const snoozed=await ok(get(q({view:"hidden"}),bob));
  assert.deepEqual(ids(snoozed).sort(),["p-bob1","p-bob2"]);
  assert.equal(snoozed.items.find(i=>i.taskId==="p-bob2").lifecycle,"snoozed");
});

test("paging binds the server evaluation instant in the signed cursor",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const query=q({limit:1});
  let page=await ok(get(query,bob));
  const instant=page.evaluatedAtMs,walked=[...ids(page)];
  assert.equal(page.hasMore,true);
  assert.match(page.nextCursor,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const firstCursor=page.nextCursor;
  while(page.hasMore){
    await new Promise(r=>setTimeout(r,15));
    page=await ok(get(query+"&cursor="+encodeURIComponent(page.nextCursor),bob));
    assert.equal(page.evaluatedAtMs,instant);
    walked.push(...ids(page));
  }
  assert.deepEqual(walked,["p-bob1","p-bob2","s-bob","p-bobplan"]);
  assert.equal(page.nextCursor,null);
  // The instant is signed: any payload tampering (even re-encoding) is refused.
  const [payload,sig]=firstCursor.split(".");
  const claims=JSON.parse(Buffer.from(payload,"base64url").toString());
  assert.equal(claims.at,instant);
  claims.at=instant+86_400_000;
  const forged=Buffer.from(JSON.stringify(claims)).toString("base64url")+"."+sig;
  for(const c of [forged,payload+"."+sig.slice(0,-2)+"AA",sig+"."+payload,
    firstCursor.replace(".",".A")])
    assert.equal((await get(query+"&cursor="+encodeURIComponent(c),bob)).status,400);
  // A cursor without an instant claim (other endpoints' format) is invalid here.
  assert.equal(typeof instant,"number");
});

test("cursor is bound to actor, areaFilter, view, timeZone and limit",async()=>{
  const f=fixture(),bob=login(f,"bob"),carol=login(f,"carol");
  const query=q({limit:1});
  const first=await ok(get(query,bob));
  const part="&cursor="+encodeURIComponent(first.nextCursor);
  assert.equal((await get(query+part,bob)).status,200);
  for(const alternate of [
    q({limit:1,areaFilter:"personal"}),q({limit:1,view:"hidden"}),
    q({limit:1,timeZone:"UTC"}),q({limit:2}),q({}),
  ])assert.equal((await get(alternate+part,bob)).status,400,alternate);
  assert.equal((await get(query+part,carol)).status,400);
  assert.equal((await get(query+part,owner())).status,400);
});

test("attention epoch change between pages gives 409 Cursor stale",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const query=q({limit:1});
  const first=await ok(get(query,bob));
  const part="&cursor="+encodeURIComponent(first.nextCursor);
  dismiss(f,"bob","p-bob2","deadline_overdue","2020-01-02");
  const res=await get(query+part,bob);
  assert.equal(res.status,409);
  assert.deepEqual(await res.json(),{error:"Cursor stale"});
});

test("live guard rejects a lifecycle write between child read and release",async()=>{
  const f=fixture(),bob=login(f,"bob");
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const at=Date.now();
  const read=()=>readStagingAttentionInChild({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
    ownerUserId:"alice",sessionTokenHash:hash,
  },"all","active",at,TZ,100,0);
  const page=await read();assert.ok(page);
  const verify=(pg,planGuard=true)=>verifyStagingReadBeforeRelease(req(q(),bob),
    {kind:"session",tokenHash:hash},f.store,"alice",pg.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:pg.areaEpochs,scope:"my-plan"},undefined,
    {privateEpoch:pg.privateEpoch},{attentionEpoch:pg.attentionEpoch});
  assert.equal(verify(page),"ok");
  dismiss(f,"bob","p-bob1");
  assert.equal(verify(page),"stale");
  // Without the new guard the attention-only race would be invisible.
  assert.equal(verifyStagingReadBeforeRelease(req(q(),bob),
    {kind:"session",tokenHash:hash},f.store,"alice",page.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {areas:page.areaEpochs,scope:"my-plan"},undefined,
    {privateEpoch:page.privateEpoch}),"ok");
  const fresh=await read();assert.ok(fresh);
  assert.equal(verify(fresh),"ok");
  // Malformed/negative guard input fails closed.
  assert.notEqual(verifyStagingReadBeforeRelease(req(q(),bob),
    {kind:"session",tokenHash:hash},f.store,"alice",fresh.linearization,
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    undefined,{attentionEpoch:-1}),"ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  assert.notEqual(verify(fresh),"ok");
});

test("revoked durable session is refused over HTTP",async()=>{
  const f=fixture(),bob=login(f,"bob");
  assert.equal((await get(q(),bob)).status,200);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(f.store,"bob").ok,true);
  const res=await get(q(),bob);
  assert.ok([401,403,404].includes(res.status),String(res.status));
  assert.ok(!(await res.text()).includes("Bob one"));
});

test("flag or environment turned off during the read yields 503",async()=>{
  fixture();
  const pending=get(q());
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED="false";
  const res=await pending;
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED="true";
  assert.equal(res.status,503);
  assert.deepEqual(await res.json(),{error:"Staging unavailable"});
});

test("child actor selector rejects bad input and flag-off child",async()=>{
  const f=fixture();
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:f.stage.directory,expectedRestoreGeneration:f.stage.restoreGeneration,
  });
  try {
    assert.equal(authority.readAttentionCandidatePage("bob","all","active",Date.now(),
      "Not/AZone",10,0),null);
    assert.equal(authority.readAttentionCandidatePage("bob","all","nope",Date.now(),
      TZ,10,0),null);
  }finally{authority.close();}
});

test("strict child DTO rejects injected metadata, forgery, ordering and lifecycle drift",()=>{
  const at=Date.UTC(2026,10,10,12);
  const w=attentionEvaluationWindow(at,TZ);
  const item={attentionKey:attentionKey("deadline_overdue","a","2020-01-01"),
    subjectType:"task",taskId:"a",title:"A",projectId:null,areaId:"bob-private",
    areaKind:"private",ruleId:"deadline_overdue",ruleVersion:1,severity:1,
    reasonCode:"deadline_overdue",relevantOn:"2020-01-01",
    relevantAt:attentionEvaluationWindow&&null,dueOn:"2020-01-01",whenOn:null,
    thresholdHours:0,sourceRevision:1,lifecycle:"active",snoozedUntilMs:null,
    lifecycleRevision:null};
  return import("../lib/attention.ts").then(({endOfLocalDate})=>{
    item.relevantAt=endOfLocalDate("2020-01-01",TZ);
    const second={...item,taskId:"b",attentionKey:attentionKey("deadline_overdue","b","2020-01-01"),
      areaId:"family-area",areaKind:"shared",assignedToMe:true};
    const frame={ok:true,areaFilter:"all",view:"active",evaluatedAtMs:at,timeZone:TZ,
      evaluationDate:w.evaluationDate,soonThroughDate:w.soonThroughDate,
      items:[item,second],hasMore:false,revision:"0".repeat(64),
      privateEpoch:2,attentionEpoch:3,linearization:{actorUserId:"bob",areas:[
        {areaId:"bob-private",areaKind:"private",access:"private-owner",policyRevision:0},
        {areaId:"family-area",areaKind:"shared",access:"editor",policyRevision:0}]},
      areaEpochs:[
        {areaId:"bob-private",areaKind:"private",access:"private-owner",
          policyRevision:0,contentRevision:2,projectContentRevision:0},
        {areaId:"family-area",areaKind:"shared",access:"editor",
          policyRevision:0,contentRevision:3,projectContentRevision:0}]};
    const parse=(x,view="active")=>parseStagingAttentionPage(x,"all",view,at,TZ,2);
    assert.deepEqual(ids({items:parse(frame).items}),["a","b"]);
    const bad=[
      {...frame,secret:1},{...frame,attentionEpoch:-1},{...frame,privateEpoch:"1"},
      {...frame,evaluatedAtMs:at+1},{...frame,timeZone:"UTC"},
      {...frame,evaluationDate:"2020-01-01"},{...frame,view:"hidden"},
      {...frame,items:[second,item]},{...frame,items:[item,{...second,taskId:"a"}]},
      {...frame,items:[{...item,severity:2},second]},
      {...frame,items:[{...item,attentionKey:"tatt1:"+"0".repeat(64)},second]},
      {...frame,items:[{...item,relevantAt:1},second]},
      {...frame,items:[{...item,extra:true},second]},
      {...frame,items:[item,{...second,assignedToMe:false}]},
      {...frame,items:[item,{...second,lifecycle:"dismissed",lifecycleRevision:1}]},
      {...frame,items:[{...item,snoozedUntilMs:5},second]},
      {...frame,items:[{...item,dueOn:"2099-01-01"},second]},
      {...frame,items:[item],hasMore:true},
      {...frame,areaEpochs:[frame.areaEpochs[0]]},
      {...frame,items:[{...item,areaId:"family-area"},second]},
    ];
    for(const x of bad)assert.equal(parse(x),null,JSON.stringify(x).slice(0,160));
    const hiddenItem={...item,lifecycle:"dismissed",lifecycleRevision:1};
    const hiddenFrame={...frame,view:"hidden",items:[hiddenItem]};
    assert.ok(parse(hiddenFrame,"hidden"));
    assert.equal(parse({...hiddenFrame,items:[{...hiddenItem,snoozedUntilMs:9}]},"hidden"),null);
    assert.equal(parse({...hiddenFrame,items:[{...item,lifecycle:"snoozed",
      snoozedUntilMs:at-1,lifecycleRevision:1}]},"hidden"),null);
    assert.ok(parse({...hiddenFrame,items:[{...item,lifecycle:"snoozed",
      snoozedUntilMs:at+1,lifecycleRevision:1}]},"hidden"));
  });
});

test("read child refuses when the parent master staging HTTP flag is off",async()=>{
  // Regression: the read runner used to hard-code the master flag to "true",
  // so this child-side re-check could never refuse.
  const f=fixture();
  const config={stagingDirectory:f.stage.directory,
    expectedRestoreGeneration:f.stage.restoreGeneration,ownerUserId:"alice"};
  const read=()=>readStagingAttentionInChild(config,"all","active",Date.now(),TZ,100,0);
  const previous=process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED;
  try{
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED="false";
    assert.equal(await read(),null,"false");
    delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED;
    assert.equal(await read(),null,"unset");
  }finally{process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=previous;}
  const page=await read();
  assert.ok(page,"enabled parent flag still reads");
  assert.deepEqual(ids(page),["p-alice","s-alice"]);
});
