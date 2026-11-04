import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const flagNames=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
];
const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  ...flagNames,"AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3k4b-when-http-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-personal-when-http-secret-at-least-32",
  ...Object.fromEntries(flagNames.map(k=>[k,"true"])),
});
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX:PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("../lib/auth.ts");
const {GET,PATCH}=await import("../app/api/target-staging/task-temporal/personal-when/command/route.ts");
const {POST}=await import("../app/api/target-staging/task-temporal/personal-when/command/receipt/route.ts");
const {parsePersonalWhenWriteReply,parsePersonalWhenReceiptReply}=
  await import("../lib/target-staging-personal-when-http-process.ts");
const {parseStagingPersonalWhenPreview,readStagingPersonalWhenPreviewInChild}=
  await import("../lib/target-staging-read-process.ts");
const {verifyPersonalWhenPreviewLive}=
  await import("../lib/target-staging-personal-when-http.ts");

let count=0;
after(()=>{
  for(const [key,value] of Object.entries(old)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('proj','family-area','Shared project')").run();
  db.prepare("INSERT INTO tasks(id,area_id,title,due_on,assignee_user_id) VALUES (?,?,?,?,?)")
    .run("p-alice",stage.unassignedAreaId,"Private Alice","2027-12-31",null);
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)")
    .run("p-bob","bob-private","Private Bob",null);
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)")
    .run("s-bob","family-area","Bob assigned","bob");
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)")
    .run("s-other","family-area","Not assigned","alice");
  db.prepare("INSERT INTO tasks(id,project_id,title,assignee_user_id) VALUES (?,?,?,?)")
    .run("child","proj","Inherited","bob");
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)")
    .run("  č padded  ","family-area","Unicode","bob");
  db.close();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return {stage,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(fx,who){
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const base="http://localhost:3001/api/target-staging/task-temporal/personal-when/command";
function query(taskId,cookie=owner(),extra=""){
  return GET(new Request(base+"?taskId="+encodeURIComponent(taskId)+extra,{
    headers:{cookie,"x-forwarded-for":"10.28.21.3"},
  }));
}
function call(method,command,cookie=owner(),options={}){
  const url=base+(method==="POST"?"/receipt":"")+(options.query||"");
  return (method==="PATCH"?PATCH:POST)(new Request(url,{
    method,headers:{
      cookie,"content-type":"application/json","x-forwarded-for":"10.28.21.3",
      ...(options.origin===null?{}:{origin:options.origin||"http://localhost:3001"}),
      ...(options.protocol===null?{}:{"x-lumi-target-protocol":options.protocol||"1"}),
    },body:typeof command==="string"?command:JSON.stringify(command),
  }));
}
async function preview(taskId,cookie=owner()){
  const response=await query(taskId,cookie);
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(result).sort(),[
    "expectedPlanRevision","expectedPrivateEpoch","expectedRevision",
    "restoreGeneration","whenOn","writeAreaId",
  ]);
  assert.match(result.expectedRevision,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(result.expectedPrivateEpoch));
  return result;
}
async function command(taskId,whenOn,cookie=owner()){
  const state=await preview(taskId,cookie);
  const {whenOn:prior,...cas}=state;
  return {...cas,commandId:randomUUID(),taskId,whenOn};
}
const read=(fx,sql,...params)=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare(sql).get(...params);}
  finally{db.close();}
};
const plan=(fx,actor,taskId)=>read(fx,
  "SELECT when_on AS whenOn,revision FROM personal_task_plans WHERE user_id=? AND task_id=?",
  actor,taskId);
const epoch=(fx,actor)=>read(fx,"SELECT revision FROM personal_plan_epochs WHERE user_id=?",actor).revision;
const receiptCount=fx=>read(fx,"SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",PREFIX+"%").n;

test("all four flags independently default off, auth and malformed selectors fail closed",async()=>{
  fixture();
  for(const flag of flagNames){
    process.env[flag]="false";
    assert.equal((await query("p-alice")).status,404,flag);
    assert.equal((await call("PATCH",{})).status,404,flag);
    assert.equal((await call("POST",{})).status,404,flag);
    process.env[flag]="true";
  }
  assert.equal((await GET(new Request(base+"?taskId=p-alice"))).status,401);
  assert.equal((await PATCH(new Request(base,{method:"PATCH",body:"{}"}))).status,401);
  for(const tail of ["?foo=bar","?taskId=x&actor=bob",
    "?taskId=p-alice&taskId=p-bob","?taskId=","?taskId=%00"]){
    const r=await GET(new Request(base+tail,{headers:{cookie:owner()}}));
    assert.equal(r.status,400,tail);
  }
  assert.equal((await query("unknown")).status,404);
  assert.equal((await preview("p-alice")).whenOn,null);
});

test("private set/update/clear, replay and receipt preserve shared dueOn/task revision",async()=>{
  const fx=fixture(),cookie=owner();
  const initial=read(fx,
    "SELECT due_on AS dueOn,revision,status FROM tasks WHERE id='p-alice'");
  const first=await command("p-alice","2028-02-29",cookie);
  assert.deepEqual(await (await call("POST",first,cookie)).json(),{status:"not_recorded"});
  assert.deepEqual(await (await call("PATCH",first,cookie)).json(),{ok:true});
  assert.equal(plan(fx,"alice","p-alice").whenOn,"2028-02-29");
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(await (await call("POST",first,cookie)).json(),{status:"committed"});
  assert.deepEqual(await (await call("PATCH",first,cookie)).json(),{ok:true,replayed:true});
  assert.equal(epoch(fx,"alice"),1);
  const next=await command("p-alice","2028-03-01",cookie);
  assert.deepEqual(await (await call("PATCH",next,cookie)).json(),{ok:true});
  assert.equal(plan(fx,"alice","p-alice").revision,1);
  const clear=await command("p-alice",null,cookie);
  assert.deepEqual(await (await call("PATCH",clear,cookie)).json(),{ok:true});
  assert.equal(plan(fx,"alice","p-alice"),undefined);
  assert.equal(epoch(fx,"alice"),3);
  assert.deepEqual({...read(fx,
    "SELECT due_on AS dueOn,revision,status FROM tasks WHERE id='p-alice'")},initial);
  assert.equal(receiptCount(fx),3);
  assert.deepEqual(await (await call("POST",first,cookie)).json(),{status:"committed"});
});

test("shared plans require current assignment/editor ACL and never leak to another actor",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),carol=login(fx,"carol");
  assert.equal((await query("s-bob",carol)).status,404);
  assert.equal((await query("s-other",bob)).status,404);
  const assigned=await command("s-bob","2028-03-05",bob);
  assert.equal((await call("PATCH",assigned,carol)).status,404);
  assert.equal((await call("POST",assigned,carol)).status,404);
  assert.equal((await call("PATCH",assigned,bob)).status,200);
  assert.equal(plan(fx,"alice","s-bob"),undefined);
  assert.equal(plan(fx,"bob","s-bob").whenOn,"2028-03-05");
  assert.equal((await call("POST",assigned,bob)).status,200);
  const inherited=await command("child","2028-03-06",bob);
  assert.equal((await call("PATCH",inherited,bob)).status,200);
  assert.equal(plan(fx,"bob","child").whenOn,"2028-03-06");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  db.close();
  assert.equal(plan(fx,"bob","s-bob"),undefined);
  assert.equal((await query("s-bob",bob)).status,404);
  assert.equal((await call("POST",assigned,bob)).status,404);
  assert.equal((await call("PATCH",assigned,bob)).status,404);
});

test("CSRF, exact fields, CAS conflicts and cross-Area commands fail closed",async()=>{
  const fx=fixture(),cookie=owner();
  const c=await command("p-alice","2028-03-05",cookie);
  assert.equal((await call("PATCH",c,cookie,{origin:"https://evil.test"})).status,403);
  assert.equal((await call("PATCH",c,cookie,{origin:null})).status,403);
  assert.equal((await call("PATCH",c,cookie,{protocol:null})).status,400);
  assert.equal((await call("POST",c,cookie,{protocol:null})).status,400);
  assert.equal((await call("PATCH",{...c,actorUserId:"alice"},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,whenOn:"2026-02-29"},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,expectedPrivateEpoch:-1},cookie)).status,400);
  assert.equal((await call("PATCH",{...c,restoreGeneration:randomUUID()},cookie)).status,409);
  assert.equal((await call("PATCH",{...c,writeAreaId:"bob-private"},cookie)).status,404);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET title='edited' WHERE id='p-alice'").run();
  db.close();
  assert.equal((await call("PATCH",c,cookie)).status,409);
  const fresh=await command("p-alice","2028-03-05",cookie);
  assert.equal((await call("PATCH",fresh,cookie)).status,200);
  assert.equal((await call("PATCH",{...fresh,whenOn:null},cookie)).status,409);
  assert.equal((await call("POST",{...fresh,whenOn:null},cookie)).status,409);
  assert.equal((await call("PATCH",await command("p-alice","2028-03-05",cookie),cookie)).status,409);
  assert.equal(receiptCount(fx),1);
});

test("Unicode task ID, durable-session revocation and server-only live epoch guard",async()=>{
  const fx=fixture(),bob=login(fx,"bob"),taskId="  č padded  ";
  const c=await command(taskId,"2028-12-31",bob);
  assert.deepEqual(await (await call("PATCH",c,bob)).json(),{ok:true});
  assert.deepEqual(await (await call("POST",c,bob)).json(),{status:"committed"});
  const hash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const caught=await readStagingPersonalWhenPreviewInChild({
    ...fx.store,ownerUserId:"alice",sessionTokenHash:hash,
  },taskId);
  assert.equal(caught?.ok,true,JSON.stringify(caught));
  const request=new Request(base+"/receipt",{
    method:"POST",headers:{cookie:bob,origin:"http://localhost:3001"},body:"{}",
  });
  const identity={kind:"session",tokenHash:hash};
  assert.equal(verifyPersonalWhenPreviewLive(request,identity,{
    ...fx.store,ownerUserId:"alice",
  },caught.preview),"ok");
  const other=await command("child","2028-12-30",bob);
  assert.equal((await call("PATCH",other,bob)).status,200);
  assert.equal(verifyPersonalWhenPreviewLive(request,identity,{
    ...fx.store,ownerUserId:"alice",
  },caught.preview),"stale","another plan change invalidates private epoch");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  assert.equal((await call("POST",c,bob)).status,401);
  assert.equal((await call("PATCH",c,bob)).status,401);
  assert.equal((await query(taskId,bob)).status,401);
});

test("child DTO parser rejects injected actor, private plan and invalid witness",()=>{
  const base={ok:true,expectedRevision:"a".repeat(64),expectedPrivateEpoch:0,
    expectedPlanRevision:null,whenOn:null,writeAreaId:"area",
    linearization:{actorUserId:"alice",areas:[{
      areaId:"area",areaKind:"private",access:"private-owner",policyRevision:0,
    }]},
    guard:{taskId:"t",projectId:null,areaId:"area",taskRevision:0,parentRevision:null},
  };
  assert.equal(parseStagingPersonalWhenPreview(base,"t")?.ok,true);
  for(const broken of [
    {...base,actorUserId:"alice"},
    {...base,expectedPrivateEpoch:-1},
    {...base,whenOn:"2026-02-29"},
    {...base,expectedPlanRevision:0},
    {...base,guard:{...base.guard,taskId:"foreign"}},
    {...base,linearization:{...base.linearization,areas:[{
      ...base.linearization.areas[0],access:"viewer",
    }]}},
  ])assert.equal(parseStagingPersonalWhenPreview(broken,"t"),null);
  assert.deepEqual(parsePersonalWhenWriteReply({ok:true}),{ok:true});
  assert.equal(parsePersonalWhenWriteReply({ok:true,taskId:"secret"}),null);
  assert.equal(parsePersonalWhenWriteReply({ok:false,reason:"unauthorized"}),null);
  assert.deepEqual(parsePersonalWhenReceiptReply({ok:true,status:"committed"}),
    {ok:true,status:"committed"});
  assert.equal(parsePersonalWhenReceiptReply({ok:true,status:"committed",actor:"alice"}),null);
});
