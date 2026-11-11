import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,copyFileSync,renameSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,after} from 'node:test';
const root=mkdtempSync(path.join(os.tmpdir(),'lumi-v25-upgrade-'));
const legacy=path.join(root,'legacy');mkdirSync(legacy);process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import('../lib/target-store-bootstrap.ts');
const {upgradeTargetStagingV25}=await import('../lib/target-staging-schema-upgrade.ts');
const {inspectIsolatedTargetStore}=await import('../lib/target-store-preflight.ts');
const {issueDurableTargetStagingSession,verifyDurableTargetStagingSessionLive,hashTargetStagingSessionToken}=await import('../lib/target-staging-durable-session.ts');
const {TargetStagingSessionAuthority}=await import('../lib/target-staging-session-authority.ts');
const hashFile = file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture(name) {
 const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,name),ownerUserId:'alice'});
 const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
 const db=new DatabaseSync(stage.databasePath);db.exec("PRAGMA foreign_keys=ON; DROP TABLE project_title_audit; UPDATE metadata SET value='25' WHERE key='schema_version'");
 db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project',?,'Before')").run(stage.unassignedAreaId);
 db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('task',?,'Task')").run(stage.unassignedAreaId);
 return {stage,store,db};
}
function rows(db){
 const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'metadata' ORDER BY name").all().map(x=>x.name);
 return Object.fromEntries(names.map(name=>[name,db.prepare('SELECT * FROM "'+name+'"').all().map(row=>({...row}))]));
}
after(()=>rmSync(root,{recursive:true,force:true}));
test('explicit upgrade preserves all v25 rows and sessions, advances journal, and enables the project command',()=>{
 const {stage,store,db}=fixture('valid');
 const session=issueDurableTargetStagingSession(store,'alice',900);assert.equal(session.ok,true);
 const before=rows(db),generation=stage.restoreGeneration;
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 assert.deepEqual(upgradeTargetStagingV25(store),{ok:true,status:'upgraded'});
 const afterRows=rows(db);delete afterRows.project_title_audit;assert.deepEqual(afterRows,before);
 assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'26');
 assert.equal(db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value,generation);
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 assert.equal(verifyDurableTargetStagingSessionLive(store,hashTargetStagingSessionToken(session.sessionToken)).ok,true);
 const journal=readFileSync(path.join(stage.directory,'lumi-target.journal'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(journal.some(row=>row.t==='intent' && row.k==='schema_upgrade' && row.p.from===25 && row.p.to===26));
 assert.deepEqual(upgradeTargetStagingV25(store),{ok:true,status:'already_current'});
 const authority=new TargetStagingSessionAuthority(store),token=authority.issueWritable('alice').sessionToken;
 const page=authority.readProjectTitlePreview('alice','project');assert.equal(page.ok,true);
 assert.deepEqual(authority.updateProjectTitle(token,{projectId:'project',commandId:randomUUID(),title:'After',
   expectedRevision:page.page.revision,writeAreaId:stage.unassignedAreaId,restoreGeneration:generation,principalBinding:'P'.repeat(43)},'alice'),{ok:true});
 authority.close();db.close();
});
test('tampered v25 DDL and wrong generation fail closed without changing database or journal',()=>{
 const {stage,store,db}=fixture('invalid');
 db.exec('DROP TRIGGER project_tombstones_no_update');
 const files=[stage.databasePath,path.join(stage.directory,'lumi-target.journal'),path.join(stage.directory,'lumi-target-witness.sqlite')];
 const before=files.map(hashFile);
 assert.equal(upgradeTargetStagingV25(store).ok,false);
 assert.deepEqual(files.map(hashFile),before);
 assert.equal(upgradeTargetStagingV25({...store,expectedRestoreGeneration:randomUUID()}).ok,false);
 assert.deepEqual(files.map(hashFile),before);db.close();
});
test('a failed COMMIT rolls back schema and data; a fresh retry safely resolves the intent',()=>{
 const {stage,store,db}=fixture('failed-commit');
 const before=rows(db),original=DatabaseSync.prototype.exec;let failed=false;
 try {
   DatabaseSync.prototype.exec=function(sql,...args){
     if (!failed && sql==='COMMIT') {failed=true;throw Error('synthetic commit failure');}
     return original.call(this,sql,...args);
   };
   assert.deepEqual(upgradeTargetStagingV25(store),{ok:false,reason:'write_failed'});
 } finally { DatabaseSync.prototype.exec=original; }
 assert.equal(failed,true);
 assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'25');
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='project_title_audit'").get().n,0);
 assert.deepEqual(rows(db),before);
 assert.deepEqual(upgradeTargetStagingV25(store),{ok:true,status:'upgraded'});
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 assert.equal(db.prepare("SELECT title FROM projects WHERE id='project'").get().title,'Before');
 db.close();
});


test('a path swap after COMMIT returns confirm_untrusted and a verified retry resolves the journal',()=>{
 const {stage,store,db}=fixture('confirm-untrusted');
 const original=DatabaseSync.prototype.exec;let swapped=false;
 try {
   DatabaseSync.prototype.exec=function(sql,...args){
     const result=original.call(this,sql,...args);
     if (!swapped && sql==='COMMIT') {
       swapped=true;copyFileSync(stage.databasePath,stage.databasePath+'.copy');
       renameSync(stage.databasePath+'.copy',stage.databasePath);
     }
     return result;
   };
   assert.deepEqual(upgradeTargetStagingV25(store),{ok:false,reason:'confirm_untrusted'});
 } finally {DatabaseSync.prototype.exec=original;db.close();}
 assert.equal(swapped,true);
 assert.deepEqual(upgradeTargetStagingV25(store),{ok:true,status:'already_current'});
 assert.equal(inspectIsolatedTargetStore({...store,mode:'r2-model'}).ok,true);
 const current=new DatabaseSync(stage.databasePath,{readOnly:true});
 assert.equal(current.prepare("SELECT title FROM projects WHERE id='project'").get().title,'Before');
 current.close();
});
