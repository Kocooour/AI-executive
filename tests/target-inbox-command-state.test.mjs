import assert from "node:assert/strict";
import {test} from "node:test";
import {createRefusalBudget} from "../lib/target-my-plan-embed.ts";
import {randomUUID} from "node:crypto";
import {
  inboxDecisionSnapshot,inboxUncertainSnapshot,setInboxDecision,
  clearInboxDecision,subscribeInboxDecision,restoreInboxDecision,
  markInboxRefused,inboxRefused,clearInboxRefusedAfterSession,
  inboxSecurityVersion,subscribeInboxSecurity,
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
    // A missing receipt is not proof the original transport has quiesced.
    // The exact UUID remains pending and cannot be replaced by a fresh one;
    // the UI may safely replay the ORIGINAL idempotent command instead.
    assert.equal(setInboxDecision(runtime,g,decision("first","not-recorded")),true);
    assert.equal(inboxUncertainSnapshot(),g);
    assert.equal(setInboxDecision(runtime,g,decision("second","sending")),false);
    assert.equal(inboxDecisionSnapshot(runtime,g)?.command.commandId,"first");
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


test("tab-only recovery witness restores original UUID without task titles or a fresh write",()=>{
  const previous=globalThis.window,values=new Map();
  globalThis.window={sessionStorage:{
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
    removeItem:key=>values.delete(key),
  }};
  const g="actor-one",id=randomUUID(),generation=randomUUID();
  const command={
    ...cmd(id),restoreGeneration:generation,
  };
  const original={command,title:"Private secret title",processId:id,stage:"sending",next:null};
  const runtimeA=runtimeFixture().runtime;
  try{
    assert.equal(setInboxDecision(runtimeA,g,original),true);
    const raw=[...values.values()][0];
    assert.equal(typeof raw,"string");
    assert.ok(raw.includes(id));
    assert.equal(raw.includes("Private secret title"),false,
      "content-free recovery must never persist private titles");
    // A full page reload starts with a fresh in-memory coordinator. Supply the
    // exact stored protocol witness, not a guessed new UUID or task title.
    clearInboxDecision(runtimeA,g);
    const record={version:1,generation:g,command,processId:id};
    values.set("lumi:target-inbox-command:v1",JSON.stringify(record));
    const runtimeB=runtimeFixture().runtime;
    assert.equal(restoreInboxDecision(runtimeB,g),true);
    const recovered=inboxDecisionSnapshot(runtimeB,g);
    assert.equal(recovered?.stage,"uncertain");
    assert.equal(recovered?.command.commandId,id);
    assert.equal(recovered?.title,"");
    assert.equal(inboxUncertainSnapshot(),g);
    assert.equal(setInboxDecision(runtimeB,g,decision(randomUUID(),"sending")),false,
      "cannot dispatch any new UUID before original receipt reconciliation");
    clearInboxDecision(runtimeB,g);
    assert.equal(values.size,0);
    values.set("lumi:target-inbox-command:v1",JSON.stringify(record));
    assert.equal(restoreInboxDecision(runtimeB,"another-actor"),false,
      "an unknown generation may not restore another actor's command");
    runtimeB.generation=()=> "another-actor";
    assert.equal(restoreInboxDecision(runtimeB,"another-actor"),true);
    assert.equal(values.size,0,"different actor must erase old tab witness");
  }finally{
    clearInboxDecision(runtimeA,g);
    if(previous===undefined)delete globalThis.window;
    else globalThis.window=previous;
  }
});

test("unavailable tab storage refuses to dispatch an unrecoverable Process",()=>{
  const previous=globalThis.window;
  globalThis.window={sessionStorage:{
    getItem:()=>null,setItem:()=>{throw Error("storage unavailable");},
    removeItem:()=>{},
  }};
  const f=runtimeFixture();
  try{
    assert.equal(setInboxDecision(f.runtime,"actor-one",
      decision(randomUUID(),"sending")),false);
    assert.equal(inboxDecisionSnapshot(f.runtime,"actor-one"),null);
  }finally{
    if(previous===undefined)delete globalThis.window;
    else globalThis.window=previous;
  }
});

test("paginated refusal blocks late count GET until freshly verified session",()=>{
  const f=runtimeFixture(),runtime=f.runtime,g="actor-one";
  let notices=0;
  const off=subscribeInboxSecurity(()=>{notices++;});
  try{
    const original=inboxSecurityVersion();
    assert.equal(inboxRefused(runtime,g),false);
    // Two actions may exhaust the UI's refusal/reverify budget. The security
    // fence MUST be independent of that rate-limited background attempt.
    markInboxRefused(runtime,g);
    const blocked=inboxSecurityVersion();
    assert.ok(blocked>original);
    assert.equal(inboxRefused(runtime,g),true);
    markInboxRefused(runtime,g);
    assert.equal(inboxSecurityVersion(),blocked,"repeat revocation keeps the same fence");
    // A stale nav GET resolving now has no authority to clear the barrier.
    assert.equal(inboxRefused(runtime,g),true);
    // Nor can a session which is no longer known restore it.
    f.revoke();
    clearInboxRefusedAfterSession(runtime,g);
    assert.equal(inboxRefused(runtime,g),true);
    // The next verified generation is not the old actor's credentials.
    f.rotate("actor-two");
    assert.equal(inboxRefused(runtime,"actor-two"),false);
    assert.ok(notices>=1);
  }finally{
    off();
  }
});

test("fresh same-generation verification advances page epoch before badge can reappear",()=>{
  const f=runtimeFixture(),runtime=f.runtime,g="actor-one";
  markInboxRefused(runtime,g);
  const oldEpoch=inboxSecurityVersion();
  assert.equal(inboxRefused(runtime,g),true);
  // Only runtime.refresh()==ok (or a confirmed passive tick) may call this.
  clearInboxRefusedAfterSession(runtime,g);
  assert.equal(inboxRefused(runtime,g),false);
  assert.ok(inboxSecurityVersion()>oldEpoch,
    "pre-refusal page keys must not match the new authorized epoch");
});


test("exhausted reverify budget cannot clear a refused count with an old response key",()=>{
  const f=runtimeFixture(),runtime=f.runtime,g="actor-one";
  const budget=createRefusalBudget({limit:2,windowMs:60_000,now:()=>1000});
  assert.equal(budget.admit(),true);
  assert.equal(budget.admit(),true);
  assert.equal(budget.admit(),false,"third refusal cannot silently schedule reverify");
  const oldGetEpoch=inboxSecurityVersion();
  markInboxRefused(runtime,g);
  assert.equal(inboxRefused(runtime,g),true);
  assert.notEqual(inboxSecurityVersion(),oldGetEpoch,
    "late GET captured under the previous key is not a displayable count");
  // No successful refresh/tick occurred and there is no permissible API for
  // a generic, late read response to lift the refusal gate.
  assert.equal(inboxRefused(runtime,g),true);
  clearInboxRefusedAfterSession(runtime,g);
  assert.equal(inboxRefused(runtime,g),false);
  assert.notEqual(inboxSecurityVersion(),oldGetEpoch,
    "fresh session verification forces a new authorized GET key");
});
