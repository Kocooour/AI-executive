/** Staging-only R3 private task creation writer acceptance.
 * Real signed write audience, pinned SQLite and append-only journal, NO HTTP.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-private-task-create-core-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"legacy unchanged");
const beforeDir=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;

const { bootstrapIsolatedTargetStore }=await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority }=await import("../lib/target-staging-session-authority.ts");
const { inspectIsolatedTargetStore }=await import("../lib/target-store-preflight.ts");
const { TARGET_STAGING_JOURNAL_FILENAME }=await import("../lib/target-staging-anchor-journal.ts");
const { PRIVATE_TASK_CREATE_RECEIPT_PREFIX, validPrivateTaskCreateCommand }=
  await import("../lib/target-private-task-create-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");

const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('bob-space','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES('bob-private','Private','private','bob-space','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('team-area','Shared','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','bob','editor')").run();
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  const item={stage,db,authority,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
  fixtures.push(item);
  return item;
}
after(()=>{
  for(const {db,authority} of fixtures){authority.close();db.close();}
  if(beforeDir===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=beforeDir;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"legacy unchanged");
  rmSync(root,{recursive:true,force:true});
});
const request=(stage,areaId,changes={})=>({
  taskId:randomUUID(),commandId:randomUUID(),areaId,
  restoreGeneration:stage.restoreGeneration,title:"Private task title",
  ...changes,
});
const receiptCount=db=>db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
  .get(PRIVATE_TASK_CREATE_RECEIPT_PREFIX+"%").n;
const readTask=(db,id)=>db.prepare(
  "SELECT id,title,area_id,project_id,status,revision FROM tasks WHERE id=?").get(id);
const state=({db,stage})=>({
  tasks:db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,
  receipts:receiptCount(db),
  changes:db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n,
  anchor:db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value,
  journal:readFileSync(path.join(stage.directory,TARGET_STAGING_JOURNAL_FILENAME),"utf8"),
});
const rejected=reason=>({ok:false,reason});

test("trusted writable owner creates once, exact replay adds nothing and change log contains no title",()=>{
  const f=fixture(),write=f.authority.issueWritable("alice");
  assert.ok(write);
  const cmd=request(f.stage,f.stage.unassignedAreaId,{title:"Confidential capture"});
  assert.equal(validPrivateTaskCreateCommand(cmd),true);
  const baseline=state(f);
  assert.deepEqual(f.authority.createPrivateTask(write.sessionToken,cmd),{ok:true});
  assert.deepEqual({...readTask(f.db,cmd.taskId)},{
    id:cmd.taskId,title:cmd.title,area_id:cmd.areaId,project_id:null,status:"open",revision:0,
  });
  assert.equal(receiptCount(f.db),baseline.receipts+1);
  assert.equal(state(f).changes,baseline.changes+1);
  const event=f.db.prepare(
    "SELECT entity_kind,entity_id,area_id,op,revision FROM change_log ORDER BY seq DESC LIMIT 1").get();
  assert.deepEqual({...event},{entity_kind:"task",entity_id:cmd.taskId,
    area_id:cmd.areaId,op:"upsert",revision:0});
  const after=state(f);
  assert.equal(after.journal.includes("task_create"),true);
  assert.equal(after.journal.includes(cmd.title),false);
  assert.equal(after.journal.includes("Confidential"),false);
  assert.deepEqual(f.authority.createPrivateTask(write.sessionToken,cmd),{ok:true,replayed:true});
  assert.deepEqual(state(f),after,"a lost-response replay cannot emit a second event or receipt");
  assert.deepEqual(f.authority.createPrivateTask(write.sessionToken,{
    ...cmd,title:"Altered secret",
  }),rejected("idempotency_conflict"));
  assert.deepEqual(f.authority.createPrivateTask(write.sessionToken,{
    ...cmd,commandId:randomUUID(),
  }),rejected("unavailable"),"another command must not overwrite an existing ID");
  assert.deepEqual(f.authority.createPrivateTask(write.sessionToken,{
    ...cmd,taskId:randomUUID(),
  }),rejected("idempotency_conflict"),
  "same command UUID with a new task ID MUST NOT create a second task");
  assert.deepEqual(state(f),after);
  assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:f.stage.directory}),
    {ok:true,mode:"stage",issues:[]});
  // Private CREATE receipts are recognized, but unknown/malformed metadata
  // is still refused by the canonical preflight.
  const badKey=PRIVATE_TASK_CREATE_RECEIPT_PREFIX+"not-a-sha256";
  f.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(badKey,"tampered");
  assert.equal(inspectIsolatedTargetStore({stagingDirectory:f.stage.directory})
    .issues.includes("metadata_invalid"),true);
  f.db.prepare("DELETE FROM metadata WHERE key=?").run(badKey);
});

test("private boundary, write audience, strict shape and restore generation all fail closed",()=>{
  const f=fixture();
  const alice=f.authority.issueWritable("alice"),bob=f.authority.issueWritable("bob"),
    read=f.authority.issue("alice");
  assert.ok(alice&&bob&&read);
  const allowed=request(f.stage,"bob-private");
  assert.deepEqual(f.authority.createPrivateTask(bob.sessionToken,allowed),{ok:true});
  assert.equal(readTask(f.db,allowed.taskId).area_id,"bob-private");
  const baseline=state(f);
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,
    request(f.stage,"bob-private")),rejected("unavailable"));
  assert.deepEqual(f.authority.createPrivateTask(bob.sessionToken,
    request(f.stage,f.stage.unassignedAreaId)),rejected("unavailable"));
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,
    request(f.stage,"team-area")),rejected("unavailable"),
    "even a shared admin cannot create via private-only writer");
  assert.deepEqual(f.authority.createPrivateTask(read.sessionToken,
    request(f.stage,f.stage.unassignedAreaId)),rejected("unauthorized"));
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,
    request(f.stage,f.stage.unassignedAreaId,{restoreGeneration:randomUUID()})),
    rejected("resync_required"));
  for(const invalid of [
    {projectId:"some-project"},{workspaceId:"bob-space"},{scope:"all"},
    {actorUserId:"bob"},{assigneeUserId:"bob"},
    {title:"   "},{title:" Leading"},{title:"Secret\nnewline"},
    {title:"x".repeat(4097)},{taskId:"not-a-uuid"},
  ]){
    const cmd=request(f.stage,f.stage.unassignedAreaId,invalid);
    assert.equal(validPrivateTaskCreateCommand(cmd),false,JSON.stringify(invalid));
    assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,cmd),
      rejected("invalid_request"));
  }
  assert.deepEqual(state(f),baseline,"denied attempts must not mutate metadata or journal");
});

test("revoked durable session and tombstoned IDs never create or resurrect tasks",()=>{
  const f=fixture(),alice=f.authority.issueWritable("alice"),
    bobWrite=f.authority.issueWritable("bob");
  assert.ok(alice&&bobWrite);
  const issued=durable.issueDurableTargetStagingSession(f.store,"bob",900);
  assert.equal(issued.ok,true);
  const hashed=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const first=request(f.stage,"bob-private");
  assert.deepEqual(f.authority.createPrivateTask(bobWrite.sessionToken,first,hashed),{ok:true});
  assert.equal(durable.revokeDurableTargetStagingSession(f.store,issued.sessionId).ok,true);
  const afterRevoke=state(f);
  const blocked=request(f.stage,"bob-private");
  assert.deepEqual(f.authority.createPrivateTask(bobWrite.sessionToken,blocked,hashed),
    rejected("session_revoked"));
  assert.deepEqual(f.authority.createPrivateTask(bobWrite.sessionToken,first,hashed),
    rejected("session_revoked"),"a revoked session cannot use a valid older receipt");
  assert.deepEqual(state(f),afterRevoke);

  const cmd=request(f.stage,f.stage.unassignedAreaId);
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,cmd),{ok:true});
  const preview=f.authority.previewTaskTitleEdit(alice.sessionToken,{taskId:cmd.taskId});
  assert.equal(preview.ok,true);
  const removed=f.authority.deleteTask(alice.sessionToken,{
    taskId:cmd.taskId,commandId:randomUUID(),expectedRevision:preview.snapshotRevision,
    writeAreaId:cmd.areaId,restoreGeneration:cmd.restoreGeneration,
  },true);
  assert.deepEqual(removed,{ok:true});
  assert.equal(readTask(f.db,cmd.taskId),undefined);
  const afterDelete=state(f);
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,cmd),
    rejected("unavailable"),"a receipt must not resurrect an ID after delete");
  assert.deepEqual(f.authority.createPrivateTask(alice.sessionToken,{
    ...cmd,commandId:randomUUID(),
  }),rejected("unavailable"),"a different command cannot bypass tombstone ID lock");
  assert.deepEqual(state(f),afterDelete);
});
