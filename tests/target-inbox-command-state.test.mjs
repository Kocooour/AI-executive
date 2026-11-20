import assert from "node:assert/strict";
import {test} from "node:test";
import {
  inboxDecisionSnapshot,inboxUncertainSnapshot,setInboxDecision,
  clearInboxDecision,subscribeInboxDecision,
} from "../lib/target-data-invalidation.ts";

function runtimeFixture(){
  let generation="actor-one",known=true;
  const rotations=new Set(),security=new Set();
  const runtime={
    known:()=>known,
    generation:()=>generation,
    subscribe(fn){rotations.add(fn);return ()=>rotations.delete(fn);},
    subscribeSecurityClear(fn){security.add(fn);return ()=>security.delete(fn);},
  };
  return {runtime,rotate(next){generation=next;for(const fn of [...rotations])fn();},
    revoke(){known=false;for(const fn of [...security])fn();
      for(const fn of [...rotations])fn();}};
}
const cmd=id=>({
  commandId:id,taskId:"task-1",mode:"process",undoOfCommandId:null,
  expectedRevision:"a".repeat(64),expectedTriageRevision:0,
  writeAreaId:"private",restoreGeneration:"gen",
});
const decision=(id,stage)=>({
  command:cmd(id),title:"Private task",processId:id,stage,next:null,
});

test("Inbox UUID survives view unsubscribe/remount; new write is blocked until receipt",()=>{
  const f=runtimeFixture(),runtime=f.runtime,g="actor-one";
  let calls=0;
  const off=subscribeInboxDecision(()=>{calls++;});
  try{
    const first=decision("first","sending");
    assert.equal(setInboxDecision(runtime,g,first),true);
    assert.equal(inboxDecisionSnapshot(runtime,g),first);
    assert.equal(inboxUncertainSnapshot(),g);
    off(); // Inbox route unmounted; the coordinator remains live.
    const remounted=subscribeInboxDecision(()=>{calls++;});
    assert.equal(inboxDecisionSnapshot(runtime,g)?.command.commandId,"first");
    assert.equal(setInboxDecision(runtime,g,decision("second","sending")),false);
    assert.equal(inboxDecisionSnapshot(runtime,g)?.command.commandId,"first");
    assert.equal(setInboxDecision(runtime,g,decision("first","uncertain")),true);
    assert.equal(inboxUncertainSnapshot(),g);
    assert.equal(setInboxDecision(runtime,g,decision("first","undo-ready")),true);
    assert.equal(inboxUncertainSnapshot(),"");
    assert.equal(setInboxDecision(runtime,g,decision("second","sending")),true);
    assert.equal(inboxDecisionSnapshot(runtime,g)?.command.commandId,"second");
    remounted();
    assert.ok(calls>=3);
  }finally{
    off();clearInboxDecision(runtime,g);
  }
});

test("session rotation and explicit security clear erase actor-specific command",()=>{
  const f=runtimeFixture(),runtime=f.runtime;
  setInboxDecision(runtime,"actor-one",decision("first","uncertain"));
  f.rotate("actor-two");
  assert.equal(inboxDecisionSnapshot(runtime,"actor-one"),null);
  assert.equal(inboxUncertainSnapshot(),"");
  assert.equal(setInboxDecision(runtime,"actor-two",decision("second","sending")),true);
  f.revoke();
  assert.equal(inboxDecisionSnapshot(runtime,"actor-two"),null);
  assert.equal(inboxUncertainSnapshot(),"");
});
