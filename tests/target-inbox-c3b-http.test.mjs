import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const envKeys=["NODE_ENV","AI_EXECUTIVE_E2E","LUMI_TARGET_INBOX_C3B_E2E",
  "AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED","AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID","OPENAI_API_KEY"];
const original=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-e2e-c3b-http-"));
mkdirSync(path.join(root,"legacy"));
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_E2E:"true",LUMI_TARGET_INBOX_C3B_E2E:"true",
  AI_EXECUTIVE_DATA_DIR:path.join(root,"legacy"),
  AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"C3b-http-test-secret-more-than-32-bytes",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED:"true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
  OPENAI_API_KEY:"",
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {provisionInboxAIFenceSchema}=await import("../lib/target-inbox-ai-consent-fence.ts");
const {createSessionToken,sessionCookieName}=
  await import("./support/owner-session-test-cookie.mjs");
const {GET:PREVIEW}=await import("../app/api/target-staging/inbox/c3b/route.ts");
const {POST:ACCEPT}=await import("../app/api/target-staging/inbox/c3b/accept/route.ts");
const {POST:UNDO}=await import("../app/api/target-staging/inbox/c3b/undo/route.ts");
const {POST:RECEIPT}=await import("../app/api/target-staging/inbox/c3b/receipt/route.ts");
const {GET:CONSENT,POST:CONSENT_WRITE}=
  await import("../app/api/target-staging/inbox/c3b/consent/route.ts");
const fixture=bootstrapIsolatedTargetStore({
  stagingDirectory:path.join(root,"target-store"),ownerUserId:"alice",
});
const db=new DatabaseSync(fixture.databasePath);
db.exec("PRAGMA foreign_keys=ON");
db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id)
  SELECT 'area:c3b:home','Rodina','private',w.id,'alice'
  FROM workspaces w WHERE kind='personal' AND owner_user_id='alice'`).run();
db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)")
  .run("project:c3b:home","area:c3b:home","Rekonstrukce");
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)")
  .run("captured",fixture.unassignedAreaId,"Připravit Rekonstrukce dnes");
db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
db.prepare(`INSERT INTO workspaces(id,kind,owner_user_id)
  VALUES('bob-ws','personal','bob')`).run();
db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
  VALUES('bob-private','Nezařazeno','private','bob-ws','bob','unassigned')`).run();
const previousUmask=process.umask(0o077);
let fence;
try{fence=new DatabaseSync(path.join(root,"inbox-ai-consent-fence.sqlite"));}
finally{process.umask(previousUmask);}
assert.equal(provisionInboxAIFenceSchema(fence),true);
fence.close();
Object.assign(process.env,{
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:fixture.directory,
  AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:fixture.restoreGeneration,
  AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
});
after(()=>{
  db.close();
  for(const [k,v] of Object.entries(original)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  rmSync(root,{recursive:true,force:true});
});
const base="http://localhost:3001/api/target-staging/inbox/c3b";
const cookie=()=>sessionCookieName+"="+createSessionToken();
const fixedOwnerSession=cookie(); // One authenticated cookie across preview+Accept.
let seq=0;
const hdr=(session=fixedOwnerSession)=>({
  cookie:session,"x-forwarded-for":"10.91.17."+String(10+(seq++%120)),
});
const preview=(id="captured",session=fixedOwnerSession)=>PREVIEW(
  new Request(base+"?taskId="+encodeURIComponent(id),{headers:hdr(session)}));
const consent=()=>CONSENT(new Request(base+"/consent",{headers:hdr()}));
const post=(handler,endpoint,body,{session=fixedOwnerSession,origin="http://localhost:3001",protocol="1"}={})=>
  handler(new Request(base+"/"+endpoint,{method:"POST",headers:{
    ...hdr(session),"content-type":"application/json",
    origin,"x-lumi-target-protocol":protocol,
  },body:JSON.stringify(body)}));
const read=async(p,expected=200)=>{
  const response=await p,body=await response.json();
  assert.equal(response.status,expected,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  return body;
};
test("C-3b HTTP: default-off, unauthenticated, CSRF, read-only foreign actor",async()=>{
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED="false";
  await read(preview(),404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED="true";
  await read(preview("captured",""),401);
  await read(preview("bad"),503); // unauthorized task cannot be released
  const legitimate=await read(preview());
  assert.equal(legitimate.taskId,"captured");
  assert.equal(legitimate.source,"rule");
  assert.equal(legitimate.changes.projectId,"project:c3b:home");
  assert.equal("linearization" in legitimate,false);
  assert.equal("actorUserId" in legitimate,false);
  await read(post(ACCEPT,"accept",{command:{}},{origin:"https://evil.invalid"}),403);
  const raw=await read(consent());
  assert.deepEqual(raw,{enabled:false,pending:false});
});
test("C-3b HTTP: rule Accept+Today+project/triage receipt, single atomic Undo",async()=>{
  const p=await read(preview());
  const command={commandId:randomUUID(),taskId:p.taskId,
    restoreGeneration:p.restoreGeneration,token:p.token,
    displayedWhy:p.why,displayedChanges:p.changes};
  await read(post(ACCEPT,"accept",{command}));
  await read(post(ACCEPT,"accept",{command})); // idempotent retry
  const receipt=await read(post(RECEIPT,"receipt",{command:{
    commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration,
  }}));
  assert.equal(receipt.status,"committed");
  assert.ok(receipt.next);
  assert.equal(db.prepare("SELECT project_id AS p FROM tasks WHERE id='captured'")
    .get().p,"project:c3b:home");
  assert.equal(db.prepare("SELECT triage_state AS t FROM tasks WHERE id='captured'")
    .get().t,"processed");
  const day=db.prepare("SELECT when_on AS d FROM personal_task_plans WHERE task_id='captured'")
    .get().d;
  assert.match(day,/^\d{4}-\d{2}-\d{2}$/);
  const undo={commandId:randomUUID(),undoOfCommandId:command.commandId,
    taskId:command.taskId,restoreGeneration:command.restoreGeneration,
    ...receipt.next};
  await read(post(UNDO,"undo",{command:undo}));
  await read(post(UNDO,"undo",{command:undo}));
  assert.equal((await read(post(RECEIPT,"receipt",{command}))).status,"undone");
  const row=db.prepare("SELECT project_id AS p,area_id AS a,triage_state AS t FROM tasks WHERE id='captured'").get();
  assert.equal(row.p,null);
  assert.equal(row.a,fixture.unassignedAreaId);
  assert.equal(row.t,"unprocessed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_task_plans WHERE task_id='captured'")
    .get().n,0);
});
test("C-3b HTTP: explicit consent, mock OpenAI, revoke and fail-closed fallback",async()=>{
  await read(post(CONSENT_WRITE,"consent",{enabled:true}));
  const enabled=await read(consent());
  assert.equal(enabled.enabled,true);
  const ai=await read(preview());
  assert.equal(ai.source,"ai");
  assert.equal(ai.changes.projectId,"project:c3b:home");
  await read(post(CONSENT_WRITE,"consent",{enabled:false}));
  assert.equal((await read(consent())).enabled,false);
  const after=await read(preview());
  assert.equal(after.source,"rule");
  assert.equal(after.changes.projectId,"project:c3b:home");
  // Existing AI token cannot be used after revocation.
  const refused=await post(ACCEPT,"accept",{command:{
    commandId:randomUUID(),taskId:ai.taskId,
    restoreGeneration:ai.restoreGeneration,token:ai.token,
    displayedWhy:ai.why,displayedChanges:ai.changes,
  }});
  assert.notEqual(refused.status,200);
});
