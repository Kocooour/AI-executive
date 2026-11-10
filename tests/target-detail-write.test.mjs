import assert from "node:assert/strict";
import {test} from "node:test";
import {createWriteController,writeReducer,IDLE,canStartWrite,outcomeForFailure}from "../lib/target-detail-write.ts";
import {
  ctx,fakeServer,json,GEN,REV,TASK,NOTE,STATUS_PREFLIGHT,STATUS_PATCH,STATUS_RECEIPT,TITLE,TITLE_RECEIPT,
  TASK_DELETE,TASK_DELETE_RECEIPT,NOTE_DETAIL,taskBody,noteBody,WHEN_PREFLIGHT,WHEN_PATCH,WHEN_RECEIPT,NOTE_PREFLIGHT,NOTE_EDIT,
  NOTE_EDIT_RECEIPT,NOTE_DELETE,NOTE_DELETE_RECEIPT,TASK_DETAIL,
}from "./support/edit-fake-server.mjs";

const wait=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness(handlers,over={}){
  const server=fakeServer(handlers);
  const committed=[];
  let refusals=0;
  let online=true;
  const controller=createWriteController({
    fetch:server.fetchFake,online:()=>online,
    onCommitted:info=>committed.push(info),onRefusal:()=>{refusals++;},
    ...over,
  });
  return {server,controller,committed,refusals:()=>refusals,setOnline:v=>{online=v;}};
}
const preflight=()=>({[STATUS_PREFLIGHT]:()=>json(ctx()),[TASK_DETAIL]:()=>json({...taskBody("O"),expectedRevision:REV})});
const whenPreflight=(whenOn=null)=>json({expectedRevision:REV,expectedPrivateEpoch:1,expectedPlanRevision:null,whenOn,writeAreaId:"area1",restoreGeneration:GEN});

test("reducer: every outcome of a pending write",()=>{
  const pending=writeReducer(IDLE,{t:"start",write:"taskTitle"});
  assert.deepEqual(pending,{kind:"pending",write:"taskTitle",phase:"preparing",undoing:false});
  const settle=(state,outcome)=>writeReducer(state,{t:"settle",outcome});
  assert.equal(settle(pending,{t:"committed",undoable:true,deleted:false}).kind,"committed");
  assert.equal(settle(pending,{t:"conflict"}).kind,"conflict");
  assert.deepEqual(settle(pending,{t:"error",reason:"forbidden"}),{kind:"error",write:"taskTitle",reason:"forbidden"});
  assert.equal(settle(pending,{t:"uncertain"}).kind,"uncertain");
  // Before dispatch nothing happened: revoked/aborted -> idle, offline -> offline.
  assert.deepEqual(settle(pending,{t:"signed-out"}),IDLE);
  assert.deepEqual(settle(pending,{t:"aborted"}),IDLE);
  assert.equal(settle(pending,{t:"offline"}).kind,"offline");
  // After dispatch the same events can only mean "unknown".
  const sent=writeReducer(pending,{t:"dispatched"});
  for(const t of ["signed-out","offline","aborted"])assert.equal(settle(sent,{t}).kind,"uncertain",t);
  // Settling a state that is not pending is ignored (late results never overwrite).
  assert.deepEqual(settle(IDLE,{t:"committed",undoable:true,deleted:false}),IDLE);
});

test("reducer: blocks starting while pending or uncertain; Undo flag; reset keeps possibly-committed writes",()=>{
  const pending=writeReducer(IDLE,{t:"start",write:"taskStatus"});
  assert.equal(canStartWrite(pending),false);
  assert.deepEqual(writeReducer(pending,{t:"start",write:"taskTitle"}),pending);
  const uncertain={kind:"uncertain",write:"taskStatus",checking:false,notRecorded:false};
  assert.equal(canStartWrite(uncertain),false);
  assert.deepEqual(writeReducer(uncertain,{t:"start",write:"taskTitle"}),uncertain);
  const undoing=writeReducer({kind:"committed",write:"taskStatus",undoable:true,undone:false,deleted:false},{t:"start",write:"taskStatus",undoing:true});
  const done=writeReducer(undoing,{t:"settle",outcome:{t:"committed",undoable:true,deleted:false}});
  assert.deepEqual([done.undoable,done.undone],[false,true],"an Undo is not undoable again");
  assert.deepEqual(writeReducer(pending,{t:"reset"}),IDLE);
  assert.equal(writeReducer(writeReducer(pending,{t:"dispatched"}),{t:"reset"}).kind,"uncertain");
  assert.equal(writeReducer({kind:"committed",write:"taskStatus",undoable:true,undone:false,deleted:false},{t:"reset"}).kind,"idle");
  assert.equal(writeReducer({kind:"conflict",write:"noteEdit"},{t:"reset"}).kind,"idle");
});

test("reducer: receipt check results; neither not-recorded nor unreadable proves a rollback",()=>{
  const u={kind:"uncertain",write:"noteEdit",checking:false,notRecorded:false};
  const checking=writeReducer(u,{t:"check"});
  assert.equal(checking.checking,true);
  assert.deepEqual(writeReducer(checking,{t:"check"}),checking,"one check at a time");
  const nr=writeReducer(checking,{t:"checked",result:"not-recorded"});
  assert.deepEqual([nr.kind,nr.checking,nr.notRecorded],["uncertain",false,true]);
  assert.equal(writeReducer(writeReducer(u,{t:"check"}),{t:"checked",result:"unknown"}).kind,"uncertain");
  assert.equal(writeReducer(writeReducer(u,{t:"check"}),{t:"checked",result:"signed-out"}).kind,"uncertain");
  const ok=writeReducer(checking,{t:"checked",result:"committed",undoable:true});
  assert.deepEqual([ok.kind,ok.undoable],["committed",true]);
  assert.deepEqual(writeReducer(u,{t:"checked",result:"committed"}),u,"unrequested results are ignored");
});

test("reducer: offline attempt and recovery; dismiss only clears settled feedback",()=>{
  const off=writeReducer(IDLE,{t:"offline-attempt",write:"noteEdit"});
  assert.equal(off.kind,"offline");
  assert.equal(writeReducer(off,{t:"online"}).kind,"idle");
  assert.equal(writeReducer({kind:"pending",write:"noteEdit",phase:"dispatched",undoing:false},{t:"dismiss"}).kind,"pending");
  assert.equal(writeReducer({kind:"uncertain",write:"noteEdit",checking:false,notRecorded:false},{t:"dismiss"}).kind,"uncertain");
});

test("failure vocabulary: every transport reason maps to exactly one outcome",()=>{
  assert.deepEqual(outcomeForFailure("signed-out"),{t:"signed-out"});
  assert.deepEqual(outcomeForFailure("conflict"),{t:"conflict"});
  assert.deepEqual(outcomeForFailure("not-available"),{t:"error",reason:"forbidden"});
  assert.deepEqual(outcomeForFailure("rate-limited"),{t:"error",reason:"rate-limited"});
  assert.deepEqual(outcomeForFailure("invalid-request"),{t:"error",reason:"invalid"});
  assert.deepEqual(outcomeForFailure("invalid-response"),{t:"error",reason:"invalid-response"});
  assert.deepEqual(outcomeForFailure("unavailable"),{t:"error",reason:"unavailable"});
  assert.deepEqual(outcomeForFailure("offline"),{t:"offline"});
  assert.deepEqual(outcomeForFailure("aborted"),{t:"aborted"});
});

test("task title: committed; one preflight, one PATCH; Undo restores the previous title via CAS",async()=>{
  let title="Old";
  const h=harness({...preflight(),[TITLE]:()=>{title="New";return json({ok:true});},[TITLE_RECEIPT]:()=>json({status:"committed"}),
    [TASK_DETAIL]:()=>json(taskBody(title))});
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"New",baseTitle:"Old"});
  assert.deepEqual(h.controller.getState(),{kind:"committed",write:"taskTitle",undoable:true,undone:false,deleted:false});
  assert.equal(h.server.count(TITLE),1);
  assert.deepEqual(h.committed,[{write:"taskTitle",deleted:false}]);
  await h.controller.undo();
  const state=h.controller.getState();
  assert.deepEqual([state.kind,state.undone,state.undoable],["committed",true,false]);
  assert.equal(h.server.count(TITLE),2);
  const back=h.server.calls.filter(c=>c.path.endsWith("/title")).at(-1);
  assert.equal(back.body.title,"Old");
  assert.notEqual(back.body.commandId,h.server.calls.find(c=>c.path.endsWith("/title")).body.commandId,"Undo is a NEW command");
  // The original was confirmed by its receipt and the title was re-read before the Undo.
  assert.ok(h.server.count(TITLE_RECEIPT)>=1);
  assert.equal(h.server.count(TASK_DETAIL),2,"one read before the write (base check), one before the Undo");
  assert.equal(h.controller.hasUndo(),false);
});

test("task title Undo fails closed (conflict) when the title changed meanwhile",async()=>{
  let reads=0;
  const h=harness({...preflight(),[TITLE]:()=>json({ok:true}),[TITLE_RECEIPT]:()=>json({status:"committed"}),
    [TASK_DETAIL]:()=>json(taskBody(++reads===1?"Old":"Someone else's"))});
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"New",baseTitle:"Old"});
  await h.controller.undo();
  assert.equal(h.controller.getState().kind,"conflict");
  assert.equal(h.server.count(TITLE),1,"the Undo PATCH was never sent");
});

test("task title: an unchanged or unrestorable previous title offers no Undo",async()=>{
  const h=harness({...preflight(),[TASK_DETAIL]:()=>json(taskBody(" padded ")),[TITLE]:()=>json({ok:true})});
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"New",baseTitle:" padded "});
  assert.equal(h.controller.getState().undoable,false);
  assert.equal(h.controller.hasUndo(),false);
});

test("status: complete -> committed with Undo (reopen with a NEW command); restore has no Undo",async()=>{
  const h=harness({...preflight(),[STATUS_PATCH]:()=>json({ok:true}),[STATUS_RECEIPT]:()=>json({status:"committed"})});
  await h.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"});
  assert.equal(h.controller.getState().undoable,true);
  const first=h.server.calls.find(c=>c.method==="PATCH").body;
  assert.deepEqual(Object.keys(first).sort(),["commandId","expectedRevision","restoreGeneration","status","taskId","writeAreaId"]);
  assert.equal(first.status,"completed");
  await h.controller.undo();
  const patches=h.server.calls.filter(c=>c.method==="PATCH");
  assert.equal(patches.length,2);
  assert.equal(patches[1].body.status,"open");
  assert.notEqual(patches[1].body.commandId,first.commandId);
  assert.equal(h.controller.getState().undone,true);

  const restore=harness({...preflight(),[STATUS_PATCH]:()=>json({ok:true})});
  await restore.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"open"});
  assert.deepEqual([restore.controller.getState().kind,restore.controller.getState().undoable],["committed",false]);
});

test("When: committed with Undo back to the previous value",async()=>{
  const h=harness({[WHEN_PREFLIGHT]:()=>whenPreflight("2026-11-12"),[WHEN_PATCH]:()=>json({ok:true}),
    [WHEN_RECEIPT]:()=>json({status:"committed"})});
  await h.controller.run({kind:"taskWhen",taskId:TASK,areaId:"area1",whenOn:"2026-11-10"});
  assert.equal(h.controller.getState().kind,"committed");
  assert.equal(h.controller.getState().undoable,true);
});

test("When: preflight reporting the same date is a quiet no-op (idle), not an error and not a PATCH",async()=>{
  const h=harness({[WHEN_PREFLIGHT]:()=>whenPreflight("2026-11-10"),[WHEN_PATCH]:()=>json({ok:true})});
  await h.controller.run({kind:"taskWhen",taskId:TASK,areaId:"area1",whenOn:"2026-11-10"});
  assert.equal(h.controller.getState().kind,"idle");
  assert.equal(h.server.count(WHEN_PATCH),0);
});

test("delete task / note edit / delete note commit without Undo and report `deleted` correctly",async()=>{
  const a=harness({...preflight(),[TASK_DELETE]:()=>json({ok:true})});
  await a.controller.run({kind:"taskDelete",taskId:TASK,areaId:"area1",base:taskBody("O").task,baseRevision:REV});
  assert.deepEqual(a.controller.getState(),{kind:"committed",write:"taskDelete",undoable:false,undone:false,deleted:true});
  assert.deepEqual(a.committed,[{write:"taskDelete",deleted:true}]);
  const b=harness({[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(noteBody()),[NOTE_EDIT]:()=>json({ok:true})});
  await b.controller.run({kind:"noteEdit",noteId:NOTE,areaId:"area1",title:"T",body:"B",baseTitle:"T0",baseBody:"B0"});
  assert.deepEqual([b.controller.getState().kind,b.controller.getState().deleted],["committed",false]);
  const c=harness({[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(noteBody()),[NOTE_DELETE]:()=>json({ok:true})});
  await c.controller.run({kind:"noteDelete",noteId:NOTE,areaId:"area1",base:noteBody().note});
  assert.deepEqual([c.controller.getState().kind,c.controller.getState().deleted],["committed",true]);
});

test("conflict (409) per kind: nothing is overwritten, no receipt, no retry",async()=>{
  const cases=[
    [{kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"},{...preflight(),[TITLE]:()=>json({error:"Revision conflict"},409)},TITLE],
    [{kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"},{...preflight(),[STATUS_PATCH]:()=>json({error:"x"},409)},STATUS_PATCH],
    [{kind:"taskDelete",taskId:TASK,areaId:"area1",base:taskBody("O").task,baseRevision:REV},{...preflight(),[TASK_DELETE]:()=>json({error:"x",code:"stale_revision"},409)},TASK_DELETE],
    [{kind:"noteEdit",noteId:NOTE,areaId:"area1",title:"T",body:"B",baseTitle:"T0",baseBody:"B0"},{[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(noteBody()),[NOTE_EDIT]:()=>json({error:"x"},409)},NOTE_EDIT],
    [{kind:"noteDelete",noteId:NOTE,areaId:"area1",base:noteBody().note},{[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(noteBody()),[NOTE_DELETE]:()=>json({error:"x"},409)},NOTE_DELETE],
  ];
  for(const [input,handlers,key] of cases){
    const h=harness(handlers);
    await h.controller.run(input);
    assert.equal(h.controller.getState().kind,"conflict",input.kind);
    assert.equal(h.server.count(key),1,input.kind);
    assert.equal(h.committed.length,0);
    assert.equal(h.server.calls.filter(c=>/\/(status|receipt)$/.test(c.path)&&c.method==="POST").length,0);
  }
  // A stale preflight (the Area on screen no longer matches) is a conflict before any write.
  const area=harness({[STATUS_PREFLIGHT]:()=>json(ctx({writeAreaId:"moved"}))});
  await area.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(area.controller.getState().kind,"conflict");
  assert.equal(area.server.writes().length,0);
});

test("uncertain: no automatic resend; blocks new writes; reconcile checks only the receipt",async()=>{
  let recorded=false;
  const h=harness({...preflight(),[TITLE]:()=>{throw new TypeError("net");},
    [TITLE_RECEIPT]:()=>json({status:recorded?"committed":"not_recorded"})});
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(h.controller.getState().kind,"uncertain");
  assert.equal(h.server.count(TITLE),1);
  // Another write is refused while uncertain.
  await h.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"});
  assert.equal(h.server.count(STATUS_PATCH),0);
  const patchesBefore=h.server.writes().length;
  await h.controller.reconcile();
  let state=h.controller.getState();
  assert.deepEqual([state.kind,state.notRecorded,state.checking],["uncertain",true,false]);
  recorded=true;
  await h.controller.reconcile();
  state=h.controller.getState();
  assert.equal(state.kind,"committed");
  assert.equal(h.server.writes().length,patchesBefore,"reconciliation never resends");
  assert.deepEqual(h.committed,[{write:"taskTitle",deleted:false}]);
});

test("uncertain via a lost response AFTER the server committed: the receipt turns it committed at once",async()=>{
  const h=harness({[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(noteBody()),[NOTE_EDIT]:()=>json({error:"x"},503),
    [NOTE_EDIT_RECEIPT]:()=>json({status:"committed"})});
  await h.controller.run({kind:"noteEdit",noteId:NOTE,areaId:"area1",title:"T",body:"B",baseTitle:"T0",baseBody:"B0"});
  assert.equal(h.controller.getState().kind,"committed");
  assert.equal(h.server.count(NOTE_EDIT),1);
  void NOTE_DELETE_RECEIPT;void TASK_DELETE_RECEIPT;
});

test("revocation: 401 at preflight -> refusal budget + idle; 401 at PATCH stays uncertain and reconcilable",async()=>{
  const early=harness({[STATUS_PREFLIGHT]:()=>json({error:"x"},401)});
  await early.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(early.controller.getState().kind,"idle");
  assert.equal(early.refusals(),1);
  assert.equal(early.server.writes().length,0);

  let alive=false;
  const late=harness({...preflight(),[TITLE]:()=>json({error:"x"},401),
    [TITLE_RECEIPT]:()=>alive?json({status:"committed"}):json({error:"x"},401)});
  await late.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(late.controller.getState().kind,"uncertain","a late 401 may follow a commit");
  assert.equal(late.refusals(),0,"an ambiguous write is not a refusal event by itself");
  await late.controller.reconcile();
  assert.equal(late.controller.getState().kind,"uncertain");
  assert.equal(late.refusals(),1,"a denied receipt goes through the refusal budget but is kept");
  alive=true;
  await late.controller.reconcile();
  assert.equal(late.controller.getState().kind,"committed");
  assert.equal(late.server.count(TITLE),1);
});

test("error outcomes: forbidden (preflight 404 = read-only), invalid, rate-limited, unavailable",async()=>{
  const forbidden=harness({[STATUS_PREFLIGHT]:()=>json({error:"Not found"},404)});
  await forbidden.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"});
  assert.deepEqual(forbidden.controller.getState(),{kind:"error",write:"taskStatus",reason:"forbidden"});
  assert.equal(forbidden.server.writes().length,0);
  const limited=harness({...preflight(),[TITLE]:()=>json({error:"x"},429)});
  await limited.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(limited.controller.getState().reason,"rate-limited");
  const bad=harness({...preflight(),[TITLE]:()=>json({error:"x"},400)});
  await bad.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(bad.controller.getState().reason,"invalid");
  const down=harness({[STATUS_PREFLIGHT]:()=>json({error:"x"},503)});
  await down.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(down.controller.getState().reason,"unavailable");
  const garbage=harness({[STATUS_PREFLIGHT]:()=>json({nope:1})});
  await garbage.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(garbage.controller.getState().reason,"invalid-response");
  const invalid=harness({...preflight()});
  await invalid.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"  padded ",baseTitle:"O"});
  assert.equal(invalid.controller.getState().reason,"invalid","an invalid title is never dispatched");
  assert.equal(invalid.server.writes().length,0);
});

test("offline: no request at all, state `offline`, and recovery clears it",async()=>{
  const h=harness({...preflight(),[TITLE]:()=>json({ok:true})});
  h.setOnline(false);
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(h.controller.getState().kind,"offline");
  assert.equal(h.server.calls.length,0);
  h.setOnline(true);
  h.controller.setOnline(true);
  assert.equal(h.controller.getState().kind,"idle");
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"N",baseTitle:"O"});
  assert.equal(h.controller.getState().kind,"committed");
});

test("offline: Undo and reconcile are not attempted without a connection",async()=>{
  const h=harness({...preflight(),[STATUS_PATCH]:()=>json({ok:true}),[STATUS_RECEIPT]:()=>json({status:"committed"})});
  await h.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"});
  h.setOnline(false);
  const calls=h.server.calls.length;
  await h.controller.undo();
  assert.equal(h.server.calls.length,calls);
  assert.equal(h.controller.getState().kind,"committed");
});

test("single flight: a second run while pending is ignored",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({...preflight(),[TITLE]:async()=>{await gate;return json({ok:true});}});
  const first=h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"A",baseTitle:"O"});
  await wait();
  await h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"B",baseTitle:"O"});
  assert.equal(h.controller.getState().kind,"pending");
  release();await first;
  assert.equal(h.server.count(TITLE),1);
  assert.equal(h.server.calls.find(c=>c.method==="PATCH").body.title,"A");
});

test("generation reset while dispatched: late response ignored, state uncertain, reconcilable; Undo cleared",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({...preflight(),[TITLE]:async()=>{await gate;return json({ok:true});},
    [TITLE_RECEIPT]:()=>json({status:"committed"})});
  const run=h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"A",baseTitle:"O"});
  await wait();await wait();
  assert.equal(h.controller.getState().phase,"dispatched");
  h.controller.reset();
  assert.equal(h.controller.getState().kind,"uncertain");
  release();await run;
  assert.equal(h.controller.getState().kind,"uncertain","the late success does not become a stale 'committed'");
  assert.equal(h.committed.length,0);
  await h.controller.reconcile();
  assert.equal(h.controller.getState().kind,"committed");
  assert.equal(h.server.count(TITLE),1);

  const g=harness({...preflight(),[STATUS_PATCH]:()=>json({ok:true})});
  await g.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"completed"});
  assert.equal(g.controller.hasUndo(),true);
  g.controller.reset();
  assert.equal(g.controller.hasUndo(),false);
  assert.equal(g.controller.getState().kind,"idle");
  await g.controller.undo();
  assert.equal(g.server.calls.filter(c=>c.method==="PATCH").length,1);
});

test("reset before dispatch aborts the preparation and leaves nothing pending",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=harness({[STATUS_PREFLIGHT]:async()=>{await gate;return json(ctx());},[TITLE]:()=>json({ok:true})});
  const run=h.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"A",baseTitle:"O"});
  await wait();
  h.controller.reset();
  release();await run;
  assert.equal(h.controller.getState().kind,"idle");
  assert.equal(h.server.count(TITLE),0);
});

test("timeout after dispatch is uncertain, before dispatch idle (never a silent success)",async()=>{
  const hang=signal=>new Promise((_,reject)=>signal?.addEventListener("abort",()=>reject(new DOMException("x","AbortError"))));
  const server=fakeServer({...preflight()});
  const base=server.fetchFake;
  const fetchHang=(input,init)=>String(input).endsWith("/title")?hang(init?.signal):base(input,init);
  const controller=createWriteController({fetch:fetchHang,online:()=>true,onCommitted(){},onRefusal(){},timeoutMs:20});
  await controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"A",baseTitle:"O"});
  assert.equal(controller.getState().kind,"uncertain");

  const early=createWriteController({fetch:(input,init)=>hang(init?.signal),online:()=>true,onCommitted(){},onRefusal(){},timeoutMs:20});
  await early.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"A",baseTitle:"O"});
  assert.equal(early.getState().kind,"idle");
});

test("subscribers are notified on every transition and can unsubscribe",async()=>{
  const h=harness({...preflight(),[STATUS_PATCH]:()=>json({ok:true})});
  const seen=[];
  const off=h.controller.subscribe(()=>seen.push(h.controller.getState().kind));
  await h.controller.run({kind:"taskStatus",taskId:TASK,areaId:"area1",status:"open"});
  assert.deepEqual(seen,["pending","pending","committed"]);
  off();
  h.controller.dismiss();
  assert.equal(seen.length,3);
});

test("optimistic concurrency on what the user saw: a changed title or note is a conflict BEFORE any write",async()=>{
  const title=harness({...preflight(),[TASK_DETAIL]:()=>json(taskBody("Changed elsewhere")),[TITLE]:()=>json({ok:true})});
  await title.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"Mine",baseTitle:"O"});
  assert.equal(title.controller.getState().kind,"conflict");
  assert.equal(title.server.count(TITLE),0,"the draft never overwrites a change it did not see");
  const moved=harness({...preflight(),[TASK_DETAIL]:()=>json(taskBody("O",{areaId:"other-area"})),[TITLE]:()=>json({ok:true})});
  await moved.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"Mine",baseTitle:"O"});
  assert.equal(moved.controller.getState().kind,"conflict");
  for(const [seen,label] of [[noteBody("T0","changed"),"body"],[noteBody("changed","B0"),"title"],[noteBody("T0","B0",{areaId:"x"}),"area"]]){
    const note=harness({[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(seen),[NOTE_EDIT]:()=>json({ok:true})});
    await note.controller.run({kind:"noteEdit",noteId:NOTE,areaId:"area1",title:"T",body:"B",baseTitle:"T0",baseBody:"B0"});
    assert.equal(note.controller.getState().kind,"conflict",label);
    assert.equal(note.server.count(NOTE_EDIT),0,label);
  }
  // The item vanished after the preflight passed: conflict, not an error.
  const gone=harness({...preflight(),[TASK_DETAIL]:()=>json({error:"Not found"},404),[TITLE]:()=>json({ok:true})});
  await gone.controller.run({kind:"taskTitle",taskId:TASK,areaId:"area1",title:"Mine",baseTitle:"O"});
  assert.equal(gone.controller.getState().kind,"conflict");
  assert.equal(gone.server.count(TITLE),0);
});

test("irreversible delete is bound to the detail snapshot, not a newly fetched CAS alone",async()=>{
  const taskBase=taskBody("O").task;
  for(const current of [
    taskBody("Edited in another tab"),
    taskBody("O",{status:"completed",completedAtMs:123456}),
    taskBody("O",{dueOn:"2026-11-11"}),
  ]){
    const h=harness({...preflight(),[TASK_DETAIL]:()=>json({...current,expectedRevision:REV}),
      [TASK_DELETE]:()=>json({ok:true})});
    await h.controller.run({kind:"taskDelete",taskId:TASK,areaId:"area1",base:taskBase,baseRevision:REV});
    assert.equal(h.controller.getState().kind,"conflict");
    assert.equal(h.server.count(TASK_DELETE),0,"a task changed since opening must not be deleted");
  }
  const noteBase=noteBody().note;
  for(const current of [
    noteBody("Renamed elsewhere","B0",{revision:2}),
    noteBody("T0","Edited elsewhere",{revision:2}),
    noteBody("T0","B0",{revision:2}),
  ]){
    const h=harness({[NOTE_PREFLIGHT]:()=>json(ctx()),[NOTE_DETAIL]:()=>json(current),
      [NOTE_DELETE]:()=>json({ok:true})});
    await h.controller.run({kind:"noteDelete",noteId:NOTE,areaId:"area1",base:noteBase});
    assert.equal(h.controller.getState().kind,"conflict");
    assert.equal(h.server.count(NOTE_DELETE),0,"a note changed since opening must not be deleted");
  }
});

test("task delete refuses a changed opaque revision even when every preview field is identical",async()=>{
  const newer="b".repeat(64);
  const unchanged=taskBody("O");
  const h=harness({
    ...preflight(),
    [STATUS_PREFLIGHT]:()=>json(ctx({expectedRevision:newer})),
    [TASK_DETAIL]:()=>json({...unchanged,expectedRevision:newer}),
    [TASK_DELETE]:()=>json({ok:true}),
  });
  await h.controller.run({kind:"taskDelete",taskId:TASK,areaId:"area1",
    base:unchanged.task,baseRevision:REV});
  assert.equal(h.controller.getState().kind,"conflict");
  assert.equal(h.server.count(TASK_DELETE),0,"changed reassignment/ACL revision must block DELETE");
  assert.equal(h.server.count(TASK_DETAIL),0,"the fresh CAS already proves the detail changed");

  const missing=harness({...preflight(),[TASK_DELETE]:()=>json({ok:true})});
  await missing.controller.run({kind:"taskDelete",taskId:TASK,areaId:"area1",
    base:unchanged.task,baseRevision:""});
  assert.equal(missing.controller.getState().kind,"error");
  assert.equal(missing.server.calls.length,0,"missing token must never fetch or dispatch");

  const changedAfterPreflight=harness({...preflight(),
    [TASK_DETAIL]:()=>json({...unchanged,expectedRevision:newer}),
    [TASK_DELETE]:()=>json({ok:true})});
  await changedAfterPreflight.controller.run({kind:"taskDelete",taskId:TASK,areaId:"area1",
    base:unchanged.task,baseRevision:REV});
  assert.equal(changedAfterPreflight.controller.getState().kind,"conflict");
  assert.equal(changedAfterPreflight.server.count(TASK_DELETE),0,"revision change during recheck blocks DELETE");
});
