import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,readFileSync,copyFileSync,renameSync} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,after} from 'node:test';
const root=mkdtempSync(path.join(os.tmpdir(),'lumi-project-title-unit-'));
const legacy=path.join(root,'legacy'); mkdirSync(legacy);process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import('../lib/target-store-bootstrap.ts');
const {TargetStagingSessionAuthority}=await import('../lib/target-staging-session-authority.ts');
const {readAuthorizedProjectTasksPage}=await import('../lib/target-project-task-read-model.ts');
const {readChangeFeedPage}=await import('../lib/target-change-feed-read-model.ts');
const {inspectIsolatedTargetStore}=await import('../lib/target-store-preflight.ts');
const {issueDurableTargetStagingSession,hashTargetStagingSessionToken,revokeDurableTargetStagingSession}=await import('../lib/target-staging-durable-session.ts');
const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,'stage'),ownerUserId:'alice'});
const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
const db=new DatabaseSync(stage.databasePath);db.exec('PRAGMA foreign_keys=ON');
for(const who of ['bob','carol','dave']){
 db.prepare('INSERT INTO identities(id) VALUES (?)').run(who);
 db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run(who+'-ws',who);
 db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')").run(who+'-area',who,who+'-ws',who);
}
db.exec("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice'); INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice'); INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin'),('team-area','bob','editor'),('team-area','carol','viewer'); INSERT INTO projects(id,area_id,title) VALUES ('proj','team-area','Original');");
const authority=new TargetStagingSessionAuthority(store);
after(()=>{authority.close();db.close();rmSync(root,{recursive:true,force:true})});
test('project rename enforces roles and CAS, persists audit, supports retry, and denies revoked access',()=>{
 const session=who=>{const x=authority.issueWritable(who);assert.ok(x);return x.sessionToken};
 const bob=session('bob'), carol=session('carol'),dave=session('dave');
 const page=readAuthorizedProjectTasksPage(db,{actorUserId:'bob',projectId:'proj',limit:1,offset:0,restoreGeneration:stage.restoreGeneration});assert.equal(page.ok,true);
 const p=db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM change_log').get().n;
 const cmd={projectId:'proj',commandId:randomUUID(),title:'Updated',expectedRevision:page.page.revision,writeAreaId:'team-area',restoreGeneration:stage.restoreGeneration};
 assert.deepEqual(authority.updateProjectTitle(carol,cmd),{ok:false,reason:'unavailable'});
 assert.deepEqual(authority.updateProjectTitle(dave,cmd),{ok:false,reason:'unavailable'});
 assert.deepEqual(authority.updateProjectTitle(bob,cmd),{ok:true});
 assert.deepEqual(authority.updateProjectTitle(bob,cmd),{ok:true,replayed:true});
 assert.deepEqual(authority.updateProjectTitle(bob,{...cmd,title:'Other'}),{ok:false,reason:'idempotency_conflict'});
 assert.deepEqual(authority.updateProjectTitle(bob,{...cmd,commandId:randomUUID()}),{ok:false,reason:'stale_revision'});
 assert.equal(db.prepare("SELECT title FROM projects WHERE id='proj'").get().title,'Updated');
 const feed=who=>readChangeFeedPage(db,{actorUserId:who,restoreGeneration:stage.restoreGeneration,
   claims:{uid:who,epoch:0,gen:stage.restoreGeneration,pos:{ph:'f',p}}});
 assert.deepEqual(feed('bob').items,[{type:'upsert',kind:'project',id:'proj',revision:1,areaId:'team-area',areaKind:'shared',title:'Updated'}]);
 assert.deepEqual(feed('dave').items,[]);

 const audit=db.prepare('SELECT actor_user_id,project_id,revision_before,revision_after FROM project_title_audit').all();
 assert.equal(audit.length,1);assert.deepEqual({...audit[0]},{actor_user_id:'bob',project_id:'proj',revision_before:0,revision_after:1});
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
 assert.deepEqual(authority.updateProjectTitle(bob,cmd),{ok:false,reason:'unavailable'});
});

test('v25 remains readable and is not silently migrated or mutated by project rename',()=>{
 const old=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,'old-stage'),ownerUserId:'alice'});
 const oldStore={stagingDirectory:old.directory,expectedRestoreGeneration:old.restoreGeneration};
 const oldDb=new DatabaseSync(old.databasePath);oldDb.exec('DROP TABLE project_title_audit');
 oldDb.prepare("UPDATE metadata SET value='25' WHERE key='schema_version'").run();
 oldDb.prepare("INSERT INTO projects(id,area_id,title) VALUES ('old',?,'Old')").run(old.unassignedAreaId);
 assert.deepEqual(inspectIsolatedTargetStore({...oldStore,mode:'r2-model'}),{ok:true,mode:'r2-model',issues:[]});
 const a=new TargetStagingSessionAuthority(oldStore);const token=a.issueWritable('alice').sessionToken;
 assert.equal(a.readProjectTitlePreview('alice','old'),null);
 const page=readAuthorizedProjectTasksPage(oldDb,{actorUserId:'alice',projectId:'old',limit:1,offset:0,restoreGeneration:old.restoreGeneration});
 assert.equal(page.ok,true);
 const result=a.updateProjectTitle(token,{projectId:'old',commandId:randomUUID(),title:'New',expectedRevision:page.page.revision,writeAreaId:old.unassignedAreaId,restoreGeneration:old.restoreGeneration});
 assert.deepEqual(result,{ok:false,reason:'write_failed'});
 assert.equal(oldDb.prepare("SELECT title FROM projects WHERE id='old'").get().title,'Old');
 assert.equal(oldDb.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'25');
 a.close();oldDb.close();
});


test('a session expiring during a replay cannot reveal the receipt outcome',()=>{
 db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('expiry',?,'Before')").run(stage.unassignedAreaId);
 const issued=issueDurableTargetStagingSession(store,'alice',900);assert.equal(issued.ok,true);
 const token=authority.issueWritable('alice').sessionToken;
 const durableHash=hashTargetStagingSessionToken(issued.sessionToken);
 const page=readAuthorizedProjectTasksPage(db,{actorUserId:'alice',projectId:'expiry',limit:1,offset:0,restoreGeneration:stage.restoreGeneration});
 const cmd={projectId:'expiry',commandId:randomUUID(),title:'After',expectedRevision:page.page.revision,writeAreaId:stage.unassignedAreaId,restoreGeneration:stage.restoreGeneration};
 assert.deepEqual(authority.updateProjectTitle(token,cmd,durableHash),{ok:true});
 const originalNow=Date.now;let checks=0;
 try {
   Date.now=()=>{if ((new Error()).stack.includes('sessionLive')) return ++checks===1 ? issued.expiresAtMs-1 : issued.expiresAtMs; return originalNow();};
   assert.deepEqual(authority.updateProjectTitle(token,cmd,durableHash),{ok:false,reason:'session_revoked'});
   assert.equal(checks,2);
 } finally {Date.now=originalNow;}
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_title_audit WHERE project_id='expiry'").get().n,1);
});


test('two processes racing the same project CAS commit at most one change',async()=>{
 db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('race',?,'Before')").run(stage.unassignedAreaId);
 const page=readAuthorizedProjectTasksPage(db,{actorUserId:'alice',projectId:'race',limit:1,offset:0,restoreGeneration:stage.restoreGeneration});
 const ready=[path.join(root,'ready1'),path.join(root,'ready2')],go=path.join(root,'go');
 const results=[path.join(root,'result1'),path.join(root,'result2')];
 const workers=[0,1].map(i=>{
   const input=path.join(root,'input'+i);
   writeFileSync(input,JSON.stringify({store,command:{projectId:'race',commandId:randomUUID(),title:'After '+i,
     expectedRevision:page.page.revision,writeAreaId:stage.unassignedAreaId,restoreGeneration:stage.restoreGeneration}}));
   return spawn(process.execPath,['--experimental-loader','./tests/ts-loader.mjs','./tests/support/project-title-race-child.mjs',input,ready[i],go,results[i]],{stdio:'ignore',cwd:process.cwd()});
 });
 try {
   const deadline=Date.now()+10000;
   while (!ready.every(existsSync)) {if(Date.now()>deadline) throw Error('workers not ready');await new Promise(r=>setTimeout(r,20));}
   writeFileSync(go,'go');
   while (!results.every(existsSync)) {if(Date.now()>deadline) throw Error('workers did not finish');await new Promise(r=>setTimeout(r,20));}
   const outcome=results.map(file=>JSON.parse(readFileSync(file,'utf8')));
   assert.equal(outcome.filter(result=>result.ok).length,1,JSON.stringify(outcome));
   assert.deepEqual(outcome.filter(result=>!result.ok),[{ok:false,reason:'stale_revision'}]);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_title_audit WHERE project_id='race'").get().n,1);
 } finally {for(const worker of workers)worker.kill();}
});


test('session revoked in another process before the pending write prevents every mutation',async()=>{
 db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('revoked-race',?,'Before')").run(stage.unassignedAreaId);
 const issued=issueDurableTargetStagingSession(store,'alice',900);assert.equal(issued.ok,true);
 const page=readAuthorizedProjectTasksPage(db,{actorUserId:'alice',projectId:'revoked-race',limit:1,offset:0,restoreGeneration:stage.restoreGeneration});
 const input=path.join(root,'revoke-input'),ready=path.join(root,'revoke-ready'),go=path.join(root,'revoke-go'),result=path.join(root,'revoke-result');
 writeFileSync(input,JSON.stringify({store,durableHash:hashTargetStagingSessionToken(issued.sessionToken),command:{projectId:'revoked-race',commandId:randomUUID(),title:'After',expectedRevision:page.page.revision,writeAreaId:stage.unassignedAreaId,restoreGeneration:stage.restoreGeneration}}));
 const worker=spawn(process.execPath,['--experimental-loader','./tests/ts-loader.mjs','./tests/support/project-title-race-child.mjs',input,ready,go,result],{stdio:'ignore',cwd:process.cwd()});
 try {
   const deadline=Date.now()+10000;
   while(!existsSync(ready)){if(Date.now()>deadline) throw Error('worker not ready');await new Promise(r=>setTimeout(r,20));}
   assert.equal(revokeDurableTargetStagingSession(store,issued.sessionId).ok,true);
   writeFileSync(go,'go');
   while(!existsSync(result)){if(Date.now()>deadline) throw Error('worker did not finish');await new Promise(r=>setTimeout(r,20));}
   assert.deepEqual(JSON.parse(readFileSync(result,'utf8')),{ok:false,reason:'session_revoked'});
   assert.equal(db.prepare("SELECT title FROM projects WHERE id='revoked-race'").get().title,'Before');
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_title_audit WHERE project_id='revoked-race'").get().n,0);
 } finally {worker.kill();}
});

test('untrusted post-COMMIT journal confirmation never acknowledges a project title as saved',()=>{
 const isolated=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,'unconfirmed-title'),ownerUserId:'alice'});
 const isolatedStore={stagingDirectory:isolated.directory,expectedRestoreGeneration:isolated.restoreGeneration};
 const connection=new DatabaseSync(isolated.databasePath);
 connection.prepare("INSERT INTO projects(id,area_id,title) VALUES ('unconfirmed',?,'Before')").run(isolated.unassignedAreaId);
 const local=new TargetStagingSessionAuthority(isolatedStore);
 try {
   const token=local.issueWritable('alice').sessionToken;
   const preview=readAuthorizedProjectTasksPage(connection,{actorUserId:'alice',projectId:'unconfirmed',
     limit:1,offset:0,restoreGeneration:isolated.restoreGeneration});
   assert.equal(preview.ok,true);
   const cmd={projectId:'unconfirmed',commandId:randomUUID(),title:'Committed but unconfirmed',
     expectedRevision:preview.page.revision,writeAreaId:isolated.unassignedAreaId,
     restoreGeneration:isolated.restoreGeneration};
   const original=DatabaseSync.prototype.exec;
   let swapped=false;
   try {
     DatabaseSync.prototype.exec=function(sql,...args){
       const returned=original.call(this,sql,...args);
       if(!swapped&&sql==='COMMIT'){
         // Swap the committed canonical inode before the journal confirm.
         // The transaction's COMMIT happened, but the pinned write context
         // must not claim a trusted journal acknowledgement.
         swapped=true;
         copyFileSync(isolated.databasePath,isolated.databasePath+'.copy');
         renameSync(isolated.databasePath+'.copy',isolated.databasePath);
       }
       return returned;
     };
     assert.deepEqual(local.updateProjectTitle(token,cmd),{ok:false,reason:'write_failed'});
   } finally {DatabaseSync.prototype.exec=original;}
   assert.equal(swapped,true);
   const current=new DatabaseSync(isolated.databasePath,{readOnly:true});
   try {
     assert.equal(current.prepare("SELECT title FROM projects WHERE id='unconfirmed'").get().title,
       'Committed but unconfirmed');
     assert.equal(current.prepare('SELECT COUNT(*) AS n FROM project_title_audit').get().n,1);
   } finally {current.close();}
 } finally {local.close();connection.close();}
});

test('post-COMMIT untrusted cancellation must not acknowledge a safe unlock',async()=>{
 const isolated=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,'unconfirmed-cancel'),ownerUserId:'alice'});
 const isolatedStore={stagingDirectory:isolated.directory,expectedRestoreGeneration:isolated.restoreGeneration};
 const connection=new DatabaseSync(isolated.databasePath);
 connection.prepare("INSERT INTO projects(id,area_id,title) VALUES ('cancel-race',?,'Before')").run(isolated.unassignedAreaId);
 const local=new TargetStagingSessionAuthority(isolatedStore);
 try{
   const token=local.issueWritable('alice').sessionToken;
   const command={projectId:'cancel-race',commandId:randomUUID(),
     restoreGeneration:isolated.restoreGeneration,principalBinding:'A'.repeat(43)};
   const original=DatabaseSync.prototype.exec;let swapped=false;
   try{
     DatabaseSync.prototype.exec=function(sql,...args){
       const result=original.call(this,sql,...args);
       if(!swapped&&sql==='COMMIT'){
         swapped=true;
         copyFileSync(isolated.databasePath,isolated.databasePath+'.copy');
         renameSync(isolated.databasePath+'.copy',isolated.databasePath);
       }
       return result;
     };
     assert.deepEqual(local.cancelProjectTitle(token,command,'alice'),{ok:false,reason:'write_failed'});
   }finally{DatabaseSync.prototype.exec=original;}
   assert.equal(swapped,true);
   const {projectTitleCancelKey}=await import('../lib/target-project-title-cancel.ts');
   const current=new DatabaseSync(isolated.databasePath,{readOnly:true});
   try{
     const key=projectTitleCancelKey('alice',command.projectId,command.commandId);
     assert.equal(current.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value,'1',
       'cancellation may have committed, but no untrusted confirmation can unlock the browser');
     assert.equal(current.prepare("SELECT title FROM projects WHERE id='cancel-race'").get().title,'Before');
   }finally{current.close();}
 }finally{local.close();connection.close();}
});
