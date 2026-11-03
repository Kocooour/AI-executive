import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-note-lifecycle-"));
const production=path.join(root,"legacy-sentinel");
mkdirSync(production);
writeFileSync(path.join(production,"unchanged"),"keep");
const previous=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=production;

const {bootstrapIsolatedTargetStore,TARGET_STORE_SCHEMA_VERSION,
  TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {previewTargetNoteWrite}=await import("../lib/target-note-write-contract.ts");
const {readAuthorizedTargetNoteSyncPage}=await import("../lib/target-note-sync-read-model.ts");
const {verifyTargetNoteLifecycleJournal}=await import("../lib/target-note-lifecycle-preflight.ts");
const {decodeNoteSyncWirePage, applyNoteSyncPage, emptyNoteSyncPageState}=await import("../lib/target-sync/note-pages.ts");

const sessions=[];
function fixture() {
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('bob-personal','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES('bob-private','Private','private','bob-personal','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('team-area','Team','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area','bob','viewer')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES('project','team-area','Shared')").run();
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  sessions.push({db,authority});
  return {db,authority,stage};
}
after(()=>{
  for(const s of sessions){s.authority.close();s.db.close();}
  if(previous===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=previous;
  assert.equal(readFileSync(path.join(production,"unchanged"),"utf8"),"keep");
  rmSync(root,{recursive:true,force:true});
});
function create(stage,areaId,projectId=null,noteId="n1",commandId=randomUUID()){
  return {kind:"create",noteId,commandId,
    restoreGeneration:stage.restoreGeneration,areaId,projectId,
    title:"Private document",body:"Do not disclose note body"};
}
function move(db,stage,areaId,projectId=null,confirmShare=true,noteId="n1"){
  const p=previewTargetNoteWrite(db,"alice",noteId);
  assert.equal(p.ok,true,JSON.stringify(p));
  return {kind:"move",noteId,commandId:randomUUID(),
    restoreGeneration:stage.restoreGeneration,writeAreaId:p.writeAreaId,
    expectedRevision:p.expectedRevision,areaId,projectId,confirmShare};
}
function page(db,stage,areaId,cursor,actor="alice",limit=100){
  return readAuthorizedTargetNoteSyncPage(db,{
    actorUserId:actor,areaId,cursor,sessionEpoch:0,
    secret:"lumi-private-cursor-secret-32-bytes-or-more",limit,
    nowSeconds:1800000000,
  });
}
function apply(state,p){
  assert.ok(p, "authorized note page");
  const body={phase:p.phase,entries:p.entries,
    changes:p.changes.map(c=>({
      kind:c.kind,noteId:c.noteId,projectId:c.projectId,revision:c.revision,
      ...(c.kind==="upsert"?{parentRevision:c.parentRevision}:{})
    })),more:p.more,cursor:p.cursor};
  assert.ok(decodeNoteSyncWirePage(body),JSON.stringify(body));
  const out=applyNoteSyncPage(state,body);
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.state;
}
const details= db=> db.prepare("SELECT area_id,seq,kind,note_id,project_id,parent_revision,revision FROM note_change_journal ORDER BY area_id,seq").all().map(x=>({...x}));

test("v19+ authenticated note create and cross-Area move are audit-backed, atomic and content-free",()=>{
  const {stage,db,authority}=fixture();
  try {
    assert.ok(TARGET_STORE_SCHEMA_VERSION >= 19, "lifecycle journal requires v19+");
    const signed=authority.issueWritable("alice");
    const reader=authority.issueWritable("bob");
    assert.ok(signed&&reader);
    const request=create(stage,stage.unassignedAreaId);
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,request),{ok:true});
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,request),
      {ok:true,replayed:true},"committed create must be idempotent");
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,
      {...request,title:"different"}),{ok:false,reason:"idempotency_conflict"});
    assert.equal(db.prepare("SELECT revision FROM notes WHERE id='n1'").get().revision,0);
    const priv=page(db,stage,stage.unassignedAreaId);
    let state=apply(emptyNoteSyncPageState(),priv);
    assert.deepEqual(state.visible.map(x=>x.id),["n1"]);
    const privateBefore=priv.cursor;
    // Different shared viewer cannot write a note, even knowing the ID.
    const forbidden=create(stage,"team-area",null,"outside");
    assert.deepEqual(authority.changeNoteLifecycle(reader.sessionToken,forbidden),
      {ok:false,reason:"unavailable"});
    const withoutConfirmation=move(db,stage,"team-area",null,false);
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,withoutConfirmation),
      {ok:false,reason:"confirmation_required"});
    const transfer=move(db,stage,"team-area");
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,transfer),{ok:true});
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,transfer),
      {ok:true,replayed:true},"cross-Area move retry needs no stale source CAS");
    assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,
      {...transfer,confirmShare:false}),{ok:false,reason:"idempotency_conflict"});
    assert.equal(db.prepare("SELECT revision FROM notes WHERE id='n1'").get().revision,1);
    const oldArea=page(db,stage,stage.unassignedAreaId,privateBefore);
    assert.deepEqual(oldArea.changes.map(c=>c.kind),["leave"]);
    state=apply(state,oldArea);
    assert.deepEqual(state.visible,[],"old Area no longer exposes moved note");
    const team=page(db,stage,"team-area");
    let shared=apply(emptyNoteSyncPageState(),team);
    assert.deepEqual(shared.visible.map(x=>[x.id,x.revision]),[["n1",1]]);
    assert.deepEqual(details(db).map(x=>[x.area_id,x.seq,x.kind,x.revision]),[
      [stage.unassignedAreaId,1,"upsert",0],
      [stage.unassignedAreaId,2,"leave",1],
      ["team-area",1,"upsert",1],
    ]);
    assert.equal(verifyTargetNoteLifecycleJournal(db),true);
    assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:stage.directory}),
      {ok:true,mode:"stage",issues:[]});
    const log=JSON.stringify(db.prepare("SELECT * FROM note_lifecycle_audit").all())+
      JSON.stringify(details(db));
    assert.ok(!log.includes("Do not disclose")&&!log.includes("Private document"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX+"%").n,2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_lifecycle_audit").get().n,2);
  } finally {}
});

test("same-Area reparent advances one journal sequence and changes the parent metadata",()=>{
  const {stage,db,authority}=fixture();
  const signed=authority.issueWritable("alice");
  assert.ok(signed);
  assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,
    create(stage,"team-area",null)),{ok:true});
  const base=page(db,stage,"team-area");
  let state=apply(emptyNoteSyncPageState(),base);
  assert.deepEqual(state.visible.map(n=>n.projectId),[null]);
  const request=move(db,stage,"team-area","project",false);
  assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,request),{ok:true});
  const updates=page(db,stage,"team-area",base.cursor);
  assert.deepEqual(updates.changes.map(c=>[c.kind,c.parentRevision]),[["upsert",0]]);
  state=apply(state,updates);
  assert.deepEqual(state.visible.map(n=>[n.projectId,n.parentRevision,n.revision]),
    [["project",0,1]]);
  assert.deepEqual(details(db).map(x=>[x.seq,x.kind,x.revision]),[[1,"upsert",0],[2,"upsert",1]]);
  assert.equal(verifyTargetNoteLifecycleJournal(db),true);
  assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:stage.directory}),
    {ok:true,mode:"stage",issues:[]});
});

test("shared-to-shared transfer requires explicit confirmation; same-Area reparent does not",()=>{
  const {stage,db,authority}=fixture();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('team2','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('second-area','Second','shared','team2','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('second-area','alice','admin')").run();
  // The source already has both Alice/Bob members; the destination only Alice.
  // Their independent policy revisions are intentionally different.
  const sourcePolicy = db.prepare("SELECT policy_revision AS n FROM areas WHERE id='team-area'").get().n;
  const destinationPolicy = db.prepare("SELECT policy_revision AS n FROM areas WHERE id='second-area'").get().n;
  assert.notEqual(sourcePolicy,destinationPolicy);
  const signed=authority.issueWritable("alice");
  assert.ok(signed);
  assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,
    create(stage,"team-area")),{ok:true});
  const original=page(db,stage,"team-area");
  const toOther=move(db,stage,"second-area",null,false);
  assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,toOther),
    {ok:false,reason:"confirmation_required"});
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='n1'").get().revision,0);
  assert.deepEqual(page(db,stage,"team-area",original.cursor).changes,[]);
  assert.deepEqual(authority.changeNoteLifecycle(signed.sessionToken,
    {...toOther,confirmShare:true}),{ok:true});
  const recorded = db.prepare("SELECT old_policy_revision AS previous, policy_revision AS destination FROM note_lifecycle_audit WHERE kind='move'").get();
  assert.deepEqual([recorded.previous,recorded.destination],[sourcePolicy,destinationPolicy],
    "audit captures BOTH policy revisions under the pinned write lock");
  const rows = db.prepare("SELECT area_id AS area, kind, policy_revision AS policy FROM note_change_journal ORDER BY area_id,seq").all();
  const leave = rows.find(x=>x.kind==="leave");
  const arrived = rows.find(x=>x.kind==="upsert"&&x.area==="second-area");
  assert.deepEqual([leave.area,leave.policy],["team-area",sourcePolicy],
    "leave must name and witness the source Area, never the destination policy");
  assert.deepEqual([arrived.area,arrived.policy],["second-area",destinationPolicy],
    "upsert must name and witness the destination Area");
  assert.deepEqual(page(db,stage,"team-area",original.cursor).changes.map(c=>c.kind),["leave"]);
  assert.deepEqual(page(db,stage,"second-area").entries.map(n=>n.id),["n1"]);
  assert.equal(verifyTargetNoteLifecycleJournal(db),true);
  assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:stage.directory}),
    {ok:true,mode:"stage",issues:[]});
});

test("raw create/move leaves a witness gap; failed journal/audit and rejected writes never publish",()=>{
  const {stage,db,authority}=fixture();
  const signed=authority.issueWritable("alice");
  assert.ok(signed);
  const first=page(db,stage,"team-area");
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES('raw','team-area','Untrusted','Body')").run();
  assert.equal(page(db,stage,"team-area",first.cursor),null,"raw create forces restart");
  const authorized=authority.changeNoteLifecycle(signed.sessionToken,
    create(stage,"team-area",null,"fresh"));
  assert.deepEqual(authorized,{ok:true});
  // A journal event forged at an existing Area sequence is refused even under
  // INSERT OR REPLACE; provenance is never silently overwritten.
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO note_change_journal(area_id,seq,kind,receipt_key,actor_user_id,note_id,policy_revision,revision,committed_at_ms) VALUES(\'team-area\',1,\'upsert\',\'forged\',\'alice\',\'raw\',1,0,1000)").run());
  assert.equal(verifyTargetNoteLifecycleJournal(db),true);
  assert.deepEqual(inspectIsolatedTargetStore({stagingDirectory:stage.directory}),
    {ok:true,mode:"stage",issues:[]});
  const orphan=TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX+"f".repeat(64);
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(orphan,"f".repeat(64));
  assert.equal(verifyTargetNoteLifecycleJournal(db),false,
    "orphan lifecycle receipt must invalidate the canonical store");
  assert.equal(inspectIsolatedTargetStore({stagingDirectory:stage.directory}).ok,false);
  db.prepare("DELETE FROM metadata WHERE key=?").run(orphan);
  assert.equal(verifyTargetNoteLifecycleJournal(db),true);
  assert.throws(()=>db.prepare("UPDATE note_lifecycle_audit SET note_id='tampered'").run(),
    /immutable/);
  assert.throws(()=>db.prepare("DELETE FROM note_lifecycle_audit").run(),/permanent/);
  assert.throws(()=>db.prepare("DELETE FROM note_change_journal").run(),/permanent/);
});
