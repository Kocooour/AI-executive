import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,after} from 'node:test';
const root=mkdtempSync(path.join(os.tmpdir(),'lumi-project-title-'));
const legacy=path.join(root,'legacy'); mkdirSync(legacy);
Object.assign(process.env,{NODE_ENV:'production',AI_EXECUTIVE_DATA_DIR:legacy,
 AI_EXECUTIVE_PASSWORD_HASH:'scrypt:'+Buffer.alloc(16,1).toString('base64url')+':'+Buffer.alloc(64,2).toString('base64url'),
 AI_EXECUTIVE_SESSION_SECRET:'synthetic-project-title-session-secret',AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:'true', AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:'true'});
const {bootstrapIsolatedTargetStore}=await import('../lib/target-store-bootstrap.ts');
const {issueDurableTargetStagingSession,TARGET_STAGING_SESSION_COOKIE}=await import('../lib/target-staging-durable-session.ts');
const {GET:detail}=await import('../app/api/target-staging/projects/[projectId]/tasks/route.ts');
const {POST:recover}=await import('../app/api/target-staging/project-title/recovery/route.ts');
const {POST:cancel}=await import('../app/api/target-staging/projects/[projectId]/title/cancel/route.ts');
const {GET:preview,PATCH}=await import('../app/api/target-staging/projects/[projectId]/title/route.ts');
const {inspectIsolatedTargetStore}=await import('../lib/target-store-preflight.ts');
const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,'stage'),ownerUserId:'alice'});
Object.assign(process.env,{AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:'alice'});
const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
const db=new DatabaseSync(stage.databasePath);db.exec('PRAGMA foreign_keys=ON');
for(const who of ['bob','carol','dave']){
 db.prepare('INSERT INTO identities(id) VALUES (?)').run(who);
 db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(who+'-ws',who);
 db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')").run(who+'-area',who,who+'-ws',who);
}
db.exec("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice'); INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice'); INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin'),('team-area','bob','editor'),('team-area','carol','viewer'); INSERT INTO projects(id,area_id,title) VALUES ('proj','team-area','Original');");
after(()=>{db.close();rmSync(root,{recursive:true,force:true})});
const cookie=who=>{const x=issueDurableTargetStagingSession(store,who,900);assert.equal(x.ok,true);return `${TARGET_STAGING_SESSION_COOKIE}=${x.sessionToken}`};
const base='http://localhost:3001/api/target-staging/projects/proj/';const ctx={params:Promise.resolve({projectId:'proj'})};
const headers=c=>({cookie:c,origin:'http://localhost:3001','content-type':'application/json','x-lumi-target-protocol':'1'});
const read=async c=>detail(new Request(base+'tasks',{headers:headers(c)}),ctx);
const write=async(c,command)=>PATCH(new Request(base+'title',{method:'PATCH',headers:headers(c),body:JSON.stringify(command)}),ctx);
const receipt=async(c,commandId)=>recover(new Request('http://localhost:3001/api/target-staging/project-title/recovery',{method:'POST',headers:headers(c),body:JSON.stringify({commandId})}));
const cancelWrite=async(c,commandId,restoreGeneration=stage.restoreGeneration)=>
 cancel(new Request(base+'title/cancel',{method:'POST',headers:headers(c),
  body:JSON.stringify({commandId,restoreGeneration})}),ctx);
test('generic staging write flags do not expose project title preview or rename',async()=>{
 const old=process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED;
 delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED;
 try {
   // Generic staging HTTP/write remains enabled for unrelated commands.
   const cmd={commandId:randomUUID(),title:'Bypass',expectedRevision:'0'.repeat(64),
     writeAreaId:'team-area',restoreGeneration:stage.restoreGeneration};
   const before=db.prepare("SELECT title FROM projects WHERE id='proj'").get().title;
   assert.equal((await preview(new Request(base+'title'),ctx)).status,404);
   assert.equal((await write('',cmd)).status,404);
   assert.equal((await receipt('',cmd.commandId)).status,404);
   assert.equal((await cancelWrite('',cmd.commandId)).status,404);
   assert.equal(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,before);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_title_audit').get().n,0);
 } finally {
   if(old===undefined)delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED;
   else process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED=old;
 }
});
test('project rename enforces role and CAS, persists audit, supports retry, and rejects revoked access',async()=>{
 process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED='true';
 assert.deepEqual(inspectIsolatedTargetStore({...store,mode:'r2-model'}), {ok:true,mode:'r2-model',issues:[]});
 const bob=cookie('bob'), carol=cookie('carol'), dave=cookie('dave');
 let response=await preview(new Request(base+'title',{headers:headers(bob)}),ctx);assert.equal(response.status,200);const page=await response.json();
 assert.deepEqual(Object.keys(page).sort(),['currentTitle','principalBinding','restoreGeneration','snapshotRevision','writeAreaId']);
 assert.match(page.principalBinding,/^[A-Za-z0-9_-]{43}$/);
 const sameActor=await preview(new Request(base+'title',{headers:headers(cookie('bob'))}),ctx);
 assert.equal((await sameActor.json()).principalBinding,page.principalBinding,
   'fresh authenticated session for the same actor must get the same scoped binding');
 assert.equal((await preview(new Request(base+'title',{headers:headers(carol)}),ctx)).status,404,
   'viewer cannot obtain a writer identity binding');
 assert.equal((await preview(new Request(base+'title',{headers:headers(dave)}),ctx)).status,404,
   'outsider cannot obtain a writer identity binding');
 assert.equal(page.writeAreaId,'team-area');assert.equal(page.restoreGeneration,stage.restoreGeneration);
 const cmd={commandId:randomUUID(),title:'Updated',expectedRevision:page.snapshotRevision,writeAreaId:page.writeAreaId,restoreGeneration:page.restoreGeneration};
 assert.equal((await write(carol,cmd)).status,404); assert.equal((await write(dave,cmd)).status,404);
 response=await receipt(bob,cmd.commandId);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'not_recorded'});
 response=await write(bob,cmd);assert.equal(response.status,200,await response.clone().text());
 response=await receipt(bob,cmd.commandId);assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{status:'committed',principalBinding:page.principalBinding});
 response=await receipt(carol,cmd.commandId);assert.deepEqual(await response.json(),{status:'not_recorded'});
 response=await receipt(dave,cmd.commandId);assert.deepEqual(await response.json(),{status:'not_recorded'});
 response=await receipt(cookie('bob'),cmd.commandId);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{status:'committed',principalBinding:page.principalBinding});
 response=await write(bob,cmd);assert.deepEqual(await response.json(),{ok:true,replayed:true});
 assert.equal((await write(bob,{...cmd,title:'Other'})).status,409);
 assert.equal((await write(bob,{...cmd,commandId:randomUUID()})).status,409);
 response=await read(bob); assert.equal((await response.json()).project.title,'Updated');
 const audit=db.prepare('SELECT actor_user_id,project_id,revision_before,revision_after FROM project_title_audit').all();
 assert.equal(audit.length,1);assert.deepEqual({...audit[0]},{actor_user_id:'bob',project_id:'proj',revision_before:0,revision_after:1});
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
 assert.equal((await write(bob,cmd)).status,404);
 assert.equal((await receipt(bob,cmd.commandId)).status,404,'recovery requires current write ACL');
});

test('cancel fence serializes before lost PATCH and permanently rejects old UUID',async()=>{
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED='true';
  const alice=cookie('alice');
  const previewResponse=await preview(new Request(base+'title',{headers:headers(alice)}),ctx);
  assert.equal(previewResponse.status,200);
  const p=await previewResponse.json();
  const oldTitle=db.prepare("SELECT title FROM projects WHERE id='proj'").get().title;
  const old={commandId:randomUUID(),title:'Must never write after cancellation',
    expectedRevision:p.snapshotRevision,writeAreaId:p.writeAreaId,restoreGeneration:p.restoreGeneration};
  const first=await cancelWrite(alice,old.commandId);
  assert.equal(first.status,200,await first.clone().text());
  assert.deepEqual(await first.json(),{status:'cancelled'});
  // The committed fence must leave the strict store preflight readable.
  assert.deepEqual(inspectIsolatedTargetStore({...store,mode:'r2-model'}),
    {ok:true,mode:'r2-model',issues:[]});
  const reread=await preview(new Request(base+'title',{headers:headers(alice)}),ctx);
  assert.equal(reread.status,200,'the pinned store remains readable after cancellation');
  const duplicate=await cancelWrite(cookie('alice'),old.commandId);
  assert.deepEqual(await duplicate.json(),{status:'cancelled'});
  const tooLate=await write(alice,old);
  assert.equal(tooLate.status,409);
  assert.deepEqual(await tooLate.json(),{error:'Command cancelled'});
  assert.equal(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,oldTitle);
  assert.equal((await receipt(alice,old.commandId)).status,200);
  assert.deepEqual(await (await receipt(alice,old.commandId)).json(),{status:'not_recorded'});
  assert.equal((await cancelWrite(cookie('carol'),old.commandId)).status,404,
    'viewer cannot cancel another actor or issue a fence');
  const fresh={...old,commandId:randomUUID(),title:'New title after safe cancellation'};
  const success=await write(alice,fresh);
  assert.equal(success.status,200,await success.clone().text());
  assert.equal(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,fresh.title);
  const already=await cancelWrite(alice,fresh.commandId);
  assert.deepEqual(await already.json(),{status:'committed'});
  assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
});

test('simultaneous PATCH and cancel are ordered by pinned write transaction',async()=>{
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED='true';
  const alice=cookie('alice');
  const p=await (await preview(new Request(base+'title',{headers:headers(alice)}),ctx)).json();
  const command={commandId:randomUUID(),title:'Race winner title',
    expectedRevision:p.snapshotRevision,writeAreaId:p.writeAreaId,restoreGeneration:p.restoreGeneration};
  const [rename,fence]=await Promise.all([write(alice,command),cancelWrite(alice,command.commandId)]);
  assert.equal(fence.status,200,await fence.clone().text());
  const status=(await fence.json()).status;
  if(status==='cancelled'){
    assert.equal(rename.status,409);
    assert.equal((await rename.json()).error,'Command cancelled');
    assert.notEqual(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,command.title);
  }else{
    assert.equal(status,'committed');
    assert.equal(rename.status,200);
    assert.equal(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,command.title);
  }
  assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
});
