/** Integration contract against the REAL merged v22 SQLite schema.
 * The transactional adapter below exists ONLY in this test: it demonstrates
 * that a future pinned writer can implement the pure plan with v22 columns,
 * revision and attention epoch. It is not production authorization or a writer.
 */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";

const {bootstrapIsolatedTargetStore,TARGET_STORE_SCHEMA_VERSION}=
  await import("../lib/target-store-bootstrap.ts");
const {attentionKey,readAuthorizedAttentionCandidatePage}=
  await import("../lib/target-attention-read-model.ts");
const {planTargetAttentionLifecycle:plan}=
  await import("../lib/target-attention-lifecycle-policy.ts");

const ACTOR="alice",TASK="attention-v22-task",RULE="deadline_soon",
  DATE="2026-11-09",NOW=Date.parse("2026-11-08T12:00:00Z");
const key=attentionKey(RULE,TASK,DATE);
function withStore(check){
  const dir=mkdtempSync(path.join(os.tmpdir(),"lumi-attention-v22-policy-"));
  let db;
  try{
    const stage=bootstrapIsolatedTargetStore({
      stagingDirectory:path.join(dir,"stage"),ownerUserId:ACTOR,
    });
    db=new DatabaseSync(stage.databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,NULL,?,NULL,?)")
      .run(TASK,stage.unassignedAreaId,"Synthetic title",DATE);
    assert.equal(TARGET_STORE_SCHEMA_VERSION,25);
    return check(db,stage);
  }finally{
    db?.close();
    rmSync(dir,{recursive:true,force:true});
  }
}
const currentRow=(db,actor=ACTOR)=>{
  const raw=db.prepare("SELECT state,snoozed_until_ms AS untilMs,revision FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?")
    .get(actor,TASK,RULE,DATE);
  return raw?{state:raw.state,snoozedUntilMs:raw.untilMs,revision:raw.revision}:null;
};
const epoch=(db,actor=ACTOR)=>db.prepare(
  "SELECT revision FROM personal_attention_epochs WHERE user_id=?").get(actor)?.revision;
function snapshot(db,stage){
  return {actorUserId:ACTOR,restoreGeneration:stage.restoreGeneration,
    attentionKey:key,taskId:TASK,ruleId:RULE,relevantOn:DATE,
    attentionEpoch:epoch(db),row:currentRow(db)};
}
function evidence(db,stage,time,view="active"){
  const page=readAuthorizedAttentionCandidatePage(db,{
    actorUserId:ACTOR,areaFilter:"all",view,evaluatedAtMs:time,
    timeZone:"Europe/Prague",limit:25,offset:0,
    restoreGeneration:stage.restoreGeneration,
  });
  assert.ok(page,"actual authorized candidate read must succeed");
  const found=page.items.find(c=>c.attentionKey===key);
  assert.ok(found,"expected eligible candidate in the selected v22 view");
  return {
    actorUserId:ACTOR,restoreGeneration:stage.restoreGeneration,
    attentionEpoch:page.attentionEpoch,
    candidate:{attentionKey:found.attentionKey,taskId:found.taskId,
      ruleId:found.ruleId,relevantOn:found.relevantOn,
      sourceRevision:found.sourceRevision},
  };
}
const action=(kind,s,w,nowMs,rest={})=>({
  kind,nowMs,expectedAttentionEpoch:s.attentionEpoch,
  expectedLifecycleRevision:s.row?.revision??null,
  expectedSourceRevision:w.candidate.sourceRevision,...rest,
});
/** Minimal synthetic pinned transaction verifies real v22 CAS/columns only.
 * Real R2d.5b.2 writer must also guard live session, Area/private epoch,
 * restore generation, fresh source eligibility and receipt in this transaction.
 */
function applyPlan(db,s,planResult){
  assert.equal(planResult.ok,true);
  assert.notEqual(planResult.operation,"none");
  db.exec("BEGIN IMMEDIATE");
  try{
    const nowEpoch=epoch(db);
    const row=currentRow(db);
    const task=db.prepare("SELECT revision,status,due_on FROM tasks WHERE id=?").get(TASK);
    if(nowEpoch!==planResult.cas.attentionEpoch||
      (row?.revision??null)!==planResult.cas.lifecycleRevision||
      task?.revision!==planResult.cas.sourceRevision||
      task.status!=="open"||task.due_on!==DATE)
      throw Error("stale");
    if(planResult.operation==="insert"){
      assert.equal(row,null);
      const insert=db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms,revision) VALUES (?,?,?,?,?,?,?)");
      insert.run(ACTOR,TASK,RULE,DATE,planResult.row.state,
        planResult.row.snoozedUntilMs,planResult.row.revision);
    }else{
      assert.ok(row);
      const deleted=db.prepare("DELETE FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=? AND revision=?")
        .run(ACTOR,TASK,RULE,DATE,planResult.cas.lifecycleRevision);
      assert.equal(deleted.changes,1);
    }
    db.exec("COMMIT");
  }catch(error){
    db.exec("ROLLBACK");
    throw error;
  }
}

test("merged v22: empty active → real INSERT rev0 → hidden → expiry DELETE",()=>withStore((db,stage)=>{
  assert.equal(currentRow(db),null);
  assert.equal(epoch(db),0);
  const fresh=evidence(db,stage,NOW);
  assert.equal(fresh.candidate.attentionKey,key);
  const before=snapshot(db,stage);
  assert.equal(before.row,null);
  const create=plan(before,fresh,action("snooze",before,fresh,NOW,{
    untilMs:NOW+60_000,
  }));
  assert.equal(create.operation,"insert");
  applyPlan(db,before,create);
  assert.deepEqual(currentRow(db),{state:"snoozed",snoozedUntilMs:NOW+60_000,revision:0});
  assert.equal(epoch(db),1);
  assert.throws(()=>applyPlan(db,before,create),/stale/,
    "replaying old insert cannot overwrite any later state");
  assert.equal(epoch(db),1);

  const stillHidden=evidence(db,stage,NOW+1,"hidden");
  assert.equal(stillHidden.candidate.attentionKey,key);
  assert.equal(epoch(db),1);
  const s=snapshot(db,stage);
  const noOp=plan(s,stillHidden,action("recheck",s,stillHidden,NOW+59_999));
  assert.equal(noOp.operation,"none");
  assert.equal(noOp.visible,false);
  assert.deepEqual(currentRow(db),s.row);

  const activeView=evidence(db,stage,NOW+60_000,"active");
  // v22 reader reports active/null revision for expired snooze even BEFORE
  // deleting the persisted snoozed row. Raw row must be independently read.
  assert.equal(currentRow(db).state,"snoozed");
  const expiredPlan=plan(snapshot(db,stage),activeView,
    action("recheck",snapshot(db,stage),activeView,NOW+60_000));
  assert.equal(expiredPlan.operation,"delete");
  assert.equal(expiredPlan.row,null);
  applyPlan(db,snapshot(db,stage),expiredPlan);
  assert.equal(currentRow(db),null);
  assert.equal(epoch(db),2);
  assert.equal(evidence(db,stage,NOW+60_001).candidate.attentionKey,key);
}));

test("merged v22: dismiss survives title revision; restore deletes row, retry/ABA denied",()=>withStore((db,stage)=>{
  const initial=snapshot(db,stage),fresh=evidence(db,stage,NOW);
  const dismiss=plan(initial,fresh,action("dismiss",initial,fresh,NOW));
  applyPlan(db,initial,dismiss);
  assert.equal(currentRow(db).state,"dismissed");
  const oldHidden=snapshot(db,stage);
  assert.equal(oldHidden.row.revision,0);
  assert.equal(oldHidden.attentionEpoch,1);
  const oldWitness=evidence(db,stage,NOW+1,"hidden");

  db.prepare("UPDATE tasks SET title='Renamed but same occurrence' WHERE id=?").run(TASK);
  const updated=evidence(db,stage,NOW+2,"hidden");
  assert.ok(updated.candidate.sourceRevision>=fresh.candidate.sourceRevision);
  const unchanged=plan(snapshot(db,stage),updated,
    action("recheck",snapshot(db,stage),updated,NOW+2));
  assert.equal(unchanged.operation,"none");
  assert.equal(unchanged.row.state,"dismissed");

  const restoreSnapshot=snapshot(db,stage);
  const restore=plan(restoreSnapshot,updated,
    action("restore",restoreSnapshot,updated,NOW+3));
  assert.equal(restore.operation,"delete");
  applyPlan(db,restoreSnapshot,restore);
  assert.equal(currentRow(db),null);
  assert.equal(epoch(db),2);
  assert.throws(()=>applyPlan(db,restoreSnapshot,restore),/stale/);

  const newState=snapshot(db,stage);
  const newProof=evidence(db,stage,NOW+4);
  const reDismiss=plan(newState,newProof,action("dismiss",newState,newProof,NOW+4));
  applyPlan(db,newState,reDismiss);
  assert.equal(currentRow(db).revision,0,"row revision reused after reinsert");
  assert.equal(epoch(db),3,"monotonic attention epoch prevents ABA");
  const replayAgainstABA=plan(oldHidden,oldWitness,
    action("restore",oldHidden,oldWitness,NOW+5));
  assert.equal(replayAgainstABA.operation,"delete","old planner output alone is not proof");
  assert.throws(()=>applyPlan(db,oldHidden,replayAgainstABA),/stale/,
    "same row revision 0 must not permit an old delete after reinsert");
  assert.equal(currentRow(db).state,"dismissed");
  assert.equal(epoch(db),3);
}));

test("merged v22: foreign identity/generation, stale candidate and epoch deny without writes",()=>withStore((db,stage)=>{
  const s=snapshot(db,stage),w=evidence(db,stage,NOW);
  const attempts=[
    plan(s,{...w,actorUserId:"bob"},action("dismiss",s,w,NOW)),
    plan(s,{...w,restoreGeneration:"e639c8ef-3818-4f5a-a5a9-40c13bd3fc15"},
      action("dismiss",s,w,NOW)),
    plan(s,w,action("dismiss",s,w,NOW,{expectedAttentionEpoch:1})),
    plan(s,w,action("dismiss",s,w,NOW,{expectedSourceRevision:w.candidate.sourceRevision+1})),
  ];
  assert.deepEqual(attempts.map(a=>a.reason),
    ["unavailable","unavailable","stale","stale"]);
  assert.equal(currentRow(db),null);
  assert.equal(epoch(db),0);

  const create=plan(s,w,action("dismiss",s,w,NOW));
  db.prepare("UPDATE tasks SET title='Change source revision' WHERE id=?").run(TASK);
  assert.throws(()=>applyPlan(db,s,create),/stale/);
  assert.equal(currentRow(db),null);
  assert.equal(epoch(db),0);
}));
