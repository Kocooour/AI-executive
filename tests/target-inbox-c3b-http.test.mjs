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
const {GET:C3A_INBOX}=await import("../app/api/target-staging/inbox/route.ts");
const {POST:C3A_RECEIPT}=await import("../app/api/target-staging/inbox/receipt/route.ts");
const {issueInboxClientCommandId}=await import("../lib/target-inbox-client.ts");
const {GET:PREVIEW}=await import("../app/api/target-staging/inbox/c3b/route.ts");
const {POST:ACCEPT}=await import("../app/api/target-staging/inbox/c3b/accept/route.ts");
const {POST:CANCEL}=await import("../app/api/target-staging/inbox/c3b/cancel/route.ts");
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
  assert.equal(raw.enabled,false);
  assert.equal(raw.pending,false);
  assert.deepEqual(raw.capacity,{
    limit:65536,used:0,reserved:0,remainingAccepts:32256,warning:false,
  },"owner receives numeric headroom without receipt IDs");
});
test("C-3b optional preview+consent cannot starve a C-3a original receipt",async()=>{
  // This reproduces the C-3a real-browser regression: both optional C-3b
  // operations previously occupied the two shared write-child slots, making
  // an unrelated Process/Undo receipt fail immediately with HTTP 503.
  const inboxResponse=await C3A_INBOX(new Request(
    "http://localhost:3001/api/target-staging/inbox?limit=50",
    {headers:hdr()}));
  assert.equal(inboxResponse.status,200);
  const page=await inboxResponse.json();
  const item=page.items.find(x=>x.id==="captured");
  assert.ok(item?.canProcess&&item.expectedRevision);
  const fields={
    taskId:item.id,mode:"process",undoOfCommandId:null,
    expectedRevision:item.expectedRevision,
    expectedTriageRevision:item.triageRevision,
    writeAreaId:item.effectiveAreaId,
    restoreGeneration:page.restoreGeneration,
  };
  const commandId=await issueInboxClientCommandId(fields);
  assert.ok(commandId);
  const command={commandId,...fields};
  const rule=preview();
  const consentRead=consent();
  // The optional calls enter the shared server runner before the C-3a
  // actor-bound read-only status. Both optional calls must finish safely,
  // but they must not consume the C-3a reserved child capacity.
  const receipt=C3A_RECEIPT(new Request(
    "http://localhost:3001/api/target-staging/inbox/receipt",{
      method:"POST",
      headers:{...hdr(),origin:"http://localhost:3001",
        "content-type":"application/json","x-lumi-target-protocol":"1"},
      body:JSON.stringify(command),
    }));
  const [ruleReply,consentReply,receiptReply]=await Promise.all([
    rule,consentRead,receipt,
  ]);
  assert.equal(ruleReply.status,200);
  assert.equal(consentReply.status,200);
  assert.equal(receiptReply.status,200,
    "C-3a receipt must remain available during C-3b optional work");
  const result=await receiptReply.json();
  assert.equal(result.status,"not_recorded");
  assert.equal(result.next,null);
});

test("C-3b HTTP: rule Accept+Today+project/triage receipt, single atomic Undo",async()=>{
  const p=await read(preview());
  const command={commandId:randomUUID(),taskId:p.taskId,
    restoreGeneration:p.restoreGeneration,token:p.token,
    displayedWhy:p.why,displayedChanges:p.changes};
  const swapped=await post(ACCEPT,"accept",{command},{session:cookie()});
  assert.notEqual(swapped.status,200,
    "a fresh owner cookie must not accept an old session's sealed proposal");
  assert.equal(db.prepare("SELECT triage_state AS t FROM tasks WHERE id='captured'")
    .get().t,"unprocessed");
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
  const ruleWhileAIEnabled=await read(PREVIEW(new Request(
    base+"?taskId=captured&mode=rules",{headers:hdr()})));
  assert.equal(ruleWhileAIEnabled.source,"rule",
    "consented AI cannot delay the standalone signed rules preview");
  assert.equal(ruleWhileAIEnabled.changes.projectId,"project:c3b:home");
  await read(PREVIEW(new Request(base+"?taskId=captured&mode=unsafe",
    {headers:hdr()})),400);
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
test("C-3b HTTP: exhausting the optional AI bucket cannot rate-limit local rules",async()=>{
  const fixed={cookie:fixedOwnerSession,"x-forwarded-for":"10.91.17.249"};
  // Consent was explicitly revoked in the preceding test. Best mode
  // falls back to local rules and still spends its independent HTTP budget.
  const best=base+"?taskId=captured";
  for(let i=0;i<30;i++){
    const response=await PREVIEW(new Request(best,{headers:fixed}));
    assert.equal(response.status,200,"best-mode request before the limit");
  }
  const over=await PREVIEW(new Request(best,{headers:fixed}));
  assert.equal(over.status,429,"optional AI HTTP budget exhausted");
  const rule=await PREVIEW(new Request(
    best+"&mode=rules",{headers:fixed}));
  assert.equal(rule.status,200,
    "an exhausted AI budget must not block a local signed rules preview");
  assert.equal((await rule.json()).source,"rule");
});

test("C-3b HTTP: missing Accept becomes a durable cancel receipt; late Accept rejected",async()=>{
  const proposal=await read(preview());
  const original={commandId:randomUUID(),taskId:proposal.taskId,
    restoreGeneration:proposal.restoreGeneration,token:proposal.token,
    displayedWhy:proposal.why,displayedChanges:proposal.changes};
  const query={commandId:original.commandId,taskId:original.taskId,
    restoreGeneration:original.restoreGeneration};
  assert.equal((await read(post(RECEIPT,"receipt",{command:query}))).status,
    "not_recorded");
  assert.equal((await read(post(CANCEL,"cancel",{command:query}))).status,
    "cancelled");
  assert.equal((await read(post(CANCEL,"cancel",{command:query}))).status,
    "cancelled","cancel is safe to retry with same actor UUID");
  assert.equal((await read(post(RECEIPT,"receipt",{command:query}))).status,
    "cancelled");
  const late=await post(ACCEPT,"accept",{command:original});
  assert.equal(late.status,409,"original immutable command is fenced forever");
  assert.equal(db.prepare("SELECT triage_state AS t FROM tasks WHERE id='captured'")
    .get().t,"unprocessed");
});


test("C-3b P1 HTTP: a stale Undo is terminally cancelled, no late Undo or partial rewrite",async()=>{
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)")
    .run("stale-undo",fixture.unassignedAreaId,"Připravit Rekonstrukce dnes");
  const p=await read(preview("stale-undo"));
  const command={commandId:randomUUID(),taskId:p.taskId,
    restoreGeneration:p.restoreGeneration,token:p.token,
    displayedWhy:p.why,displayedChanges:p.changes};
  await read(post(ACCEPT,"accept",{command}));
  const receipt=await read(post(RECEIPT,"receipt",{command:{
    commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration,
  }}));
  assert.equal(receipt.status,"committed");
  assert.ok(receipt.next);
  const undo={commandId:randomUUID(),undoOfCommandId:command.commandId,
    taskId:command.taskId,restoreGeneration:command.restoreGeneration,
    ...receipt.next};
  db.prepare("UPDATE tasks SET title='Změněné zadání' WHERE id='stale-undo'").run();
  const denied=await post(UNDO,"undo",{command:undo});
  assert.equal(denied.status,409,"a newer edit must block Undo");
  const cancelled=await read(post(CANCEL,"cancel",{command:undo}));
  assert.equal(cancelled.status,"undo_cancelled");
  assert.equal((await read(post(CANCEL,"cancel",{command:undo}))).status,
    "undo_cancelled","retry after reload must remain terminal");
  const query={commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration};
  assert.equal((await read(post(RECEIPT,"receipt",{command:query}))).status,
    "undo_cancelled");
  assert.equal((await post(UNDO,"undo",{command:undo})).status,409,
    "late original Undo must lose the receipt lock");
  assert.deepEqual({...db.prepare(`SELECT title,triage_state AS state,project_id AS projectId
    FROM tasks WHERE id='stale-undo'`).get()},{
    title:"Změněné zadání",state:"processed",projectId:"project:c3b:home",
  });
});

test("C-3b HTTP: concurrent optional previews preserve rules worker capacity",async()=>{
  // Best mode remains a bounded optional lane even if no OpenAI grant exists.
  // The second request must not acquire another worker while the first is
  // running; a rules preview still has a separate subprocess slot.
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)")
    .run("ai-admission-test",fixture.unassignedAreaId,"Připravit Rekonstrukce dnes");
  const headers={cookie:fixedOwnerSession,"x-forwarded-for":"10.91.17.248"};
  // A fresh task ID bypasses the 15-second in-memory preview cache.
  const optional=base+"?taskId=ai-admission-test";
  const first=PREVIEW(new Request(optional,{headers}));
  const second=await PREVIEW(new Request(optional,{headers}));
  assert.equal(second.status,429,
    "a second optional request cannot occupy the rules worker slot");
  const rules=await PREVIEW(new Request(optional+"&mode=rules",{headers}));
  assert.equal(rules.status,200,"local rules must run while best is in flight");
  assert.equal((await rules.json()).source,"rule");
  assert.equal((await first).status,200);
});
