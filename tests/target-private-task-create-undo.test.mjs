import assert from "node:assert/strict";
import {test} from "node:test";
import {confirmPrivateTaskUndo,readPrivateTaskUndoBaseline,undoPrivateTaskCreate,
  PRIVATE_TASK_UNDO_WINDOW_MS}from "../lib/target-private-task-create-undo.ts";
import {buildTaskDeleteCommand}from "../lib/target-staging-edit-clients.ts";
import {ctx,fakeServer,json,REV,TASK,STATUS_PREFLIGHT,TASK_DELETE,TASK_DELETE_RECEIPT,
  TASK_DETAIL,taskBody}from "./support/edit-fake-server.mjs";

const NEWER="b".repeat(64);
const signal=()=>new AbortController().signal;
const detail=(over={},revision=REV)=>()=>json(taskBody("Koupit mléko",over),200,
  revision===null?{}:{"x-lumi-task-revision":revision});
const baseline={taskId:TASK,areaId:"area1",revision:REV};
const happy=(extra={})=>({
  [TASK_DETAIL]:detail(),
  [STATUS_PREFLIGHT]:()=>json(ctx()),
  [TASK_DELETE]:()=>json({ok:true}),
  ...extra,
});

test("Undo window is bounded",()=>{
  assert.equal(PRIVATE_TASK_UNDO_WINDOW_MS,60_000);
});

test("baseline: only an open private task with a writable revision is undoable",async()=>{
  const run=handler=>readPrivateTaskUndoBaseline(TASK,fakeServer({[TASK_DETAIL]:handler}).fetchFake,signal());
  assert.deepEqual(await run(detail()),{ok:true,baseline});
  assert.deepEqual(await run(detail({areaKind:"shared"})),{ok:false});
  assert.deepEqual(await run(detail({status:"completed",completedAtMs:1})),{ok:false});
  assert.deepEqual(await run(detail({},null)),{ok:false},"no CAS token = not writable");
  assert.deepEqual(await run(()=>json({error:"Not found"},404)),{ok:false});
});

test("Undo deletes an unchanged task with exactly one delete command",async()=>{
  const server=fakeServer(happy());
  assert.deepEqual(await undoPrivateTaskCreate(baseline,server.fetchFake,signal()),{kind:"deleted"});
  assert.equal(server.count(TASK_DELETE),1);
  const body=server.calls.find(c=>c.method+" "+c.path===TASK_DELETE).body;
  assert.equal(body.expectedRevision,REV);
  assert.equal(body.writeAreaId,"area1");
});

test("a task changed since creation is never deleted",async()=>{
  for(const [name,handlers] of [
    ["edited (new revision in detail)",happy({[TASK_DETAIL]:detail({},NEWER)})],
    ["completed",happy({[TASK_DETAIL]:detail({status:"completed",completedAtMs:1})})],
    ["moved to another Area",happy({[TASK_DETAIL]:detail({areaId:"area2"})})],
    ["revision changed between reads",happy({[STATUS_PREFLIGHT]:()=>json(ctx({expectedRevision:NEWER}))})],
    ["Area changed between reads",happy({[STATUS_PREFLIGHT]:()=>json(ctx({writeAreaId:"area2"}))})],
    ["writer CAS conflict",happy({[TASK_DELETE]:()=>json({error:"Conflict"},409)})],
  ]){
    const server=fakeServer(handlers);
    assert.deepEqual(await undoPrivateTaskCreate(baseline,server.fetchFake,signal()),{kind:"changed"},name);
    if(name!=="writer CAS conflict")assert.equal(server.count(TASK_DELETE),0,name+": no delete dispatched");
  }
});

test("a task moved to a shared Area is never deleted",async()=>{
  const server=fakeServer(happy({[TASK_DETAIL]:detail({areaKind:"shared"})}));
  const outcome=await undoPrivateTaskCreate(baseline,server.fetchFake,signal());
  assert.ok(["changed","failed"].includes(outcome.kind),outcome.kind);
  assert.equal(server.count(TASK_DELETE),0);
});

test("missing, foreign or revoked access fails closed without a delete",async()=>{
  const gone=fakeServer(happy({[TASK_DETAIL]:()=>json({error:"Not found"},404)}));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,gone.fetchFake,signal()),{kind:"gone"});
  assert.equal(gone.count(TASK_DELETE),0);
  const out=fakeServer(happy({[TASK_DETAIL]:()=>json({error:"Unauthorized"},401)}));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,out.fetchFake,signal()),{kind:"signed-out"});
  assert.equal(out.count(TASK_DELETE),0);
  const noContext=fakeServer(happy({[STATUS_PREFLIGHT]:()=>json({error:"Not found"},404)}));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,noContext.fetchFake,signal()),{kind:"gone"});
  assert.equal(noContext.count(TASK_DELETE),0);
});

test("a lost response is confirmed only through the receipt and never resent",async()=>{
  const lost=fakeServer(happy({
    [TASK_DELETE]:()=>{throw new TypeError("network");},
    [TASK_DELETE_RECEIPT]:()=>json({error:"Unavailable"},503),
  }));
  const outcome=await undoPrivateTaskCreate(baseline,lost.fetchFake,signal());
  assert.equal(outcome.kind,"uncertain");
  assert.equal(lost.count(TASK_DELETE),1,"exactly one delete");
  const committed=fakeServer({[TASK_DELETE_RECEIPT]:()=>json({status:"committed"})});
  assert.deepEqual(await confirmPrivateTaskUndo(outcome.command,committed.fetchFake,signal()),{kind:"deleted"});
  assert.equal(committed.count(TASK_DELETE),0,"confirmation never deletes");
  const notRecorded=fakeServer({[TASK_DELETE_RECEIPT]:()=>json({status:"not_recorded"})});
  assert.deepEqual(await confirmPrivateTaskUndo(outcome.command,notRecorded.fetchFake,signal()),{kind:"failed"});
  const revoked=fakeServer({[TASK_DELETE_RECEIPT]:()=>json({error:"Unauthorized"},401)});
  assert.deepEqual(await confirmPrivateTaskUndo(outcome.command,revoked.fetchFake,signal()),{kind:"signed-out"});
  const still=fakeServer({[TASK_DELETE_RECEIPT]:()=>json({error:"Unavailable"},503)});
  assert.equal((await confirmPrivateTaskUndo(outcome.command,still.fetchFake,signal())).kind,"uncertain");
});

test("a late commit after a refused lost response is reported as deleted",async()=>{
  const server=fakeServer(happy({
    [TASK_DELETE]:()=>json({error:"Unavailable"},503),
    [TASK_DELETE_RECEIPT]:()=>json({status:"committed"}),
  }));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,server.fetchFake,signal()),{kind:"deleted"});
  assert.equal(server.count(TASK_DELETE),1);
});

test("rate limit and transient failures dispatch nothing extra and allow a fresh attempt",async()=>{
  const limited=fakeServer(happy({[TASK_DELETE]:()=>json({error:"Too many"},429)}));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,limited.fetchFake,signal()),{kind:"failed"});
  assert.equal(limited.count(TASK_DELETE),1);
  const offline=fakeServer(happy({[TASK_DETAIL]:()=>{throw new TypeError("offline");}}));
  assert.deepEqual(await undoPrivateTaskCreate(baseline,offline.fetchFake,signal()),{kind:"failed"});
  assert.equal(offline.count(TASK_DELETE),0);
});

test("confirm refuses a malformed command without any request",async()=>{
  const server=fakeServer({});
  const command={...buildTaskDeleteCommand(TASK,ctx()),commandId:"not-a-uuid"};
  assert.equal((await confirmPrivateTaskUndo(command,server.fetchFake,signal())).kind,"uncertain");
  assert.equal(server.calls.length,0);
});
