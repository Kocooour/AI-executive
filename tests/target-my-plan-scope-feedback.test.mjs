import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {scopeFeedbackDecision} from "../lib/target-my-plan-scope-feedback.ts";

const decide=(recorded,current,statusKind,whenKind="idle")=>
  scopeFeedbackDecision({recorded,current,statusKind,whenKind});

test("feedback is recorded against the scope current when the first write starts",()=>{
  assert.deepEqual(decide(null,"all","pending"),{recorded:"all",clear:false});
  assert.deepEqual(decide(null,"personal","idle","pending"),{recorded:"personal",clear:false});
  assert.deepEqual(decide("all","all","committed"),{recorded:"all",clear:false});
});

test("idle forgets the recorded scope and never clears anything",()=>{
  assert.deepEqual(decide("all","shared","idle"),{recorded:null,clear:false});
});

test("scope change DURING a write keeps everything; the settled write is then cleared",()=>{
  for(const kind of ["pending","checking","uncertain"])
    assert.deepEqual(decide("all","shared",kind),{recorded:"all",clear:false},kind);
  assert.deepEqual(decide("all","shared","idle","pending"),{recorded:"all",clear:false});
  // The write completes under the new scope: the previous scope's Undo goes away.
  assert.deepEqual(decide("all","shared","committed"),{recorded:null,clear:true});
  assert.deepEqual(decide("all","shared","error"),{recorded:null,clear:true});
  assert.deepEqual(decide("all","shared","idle","committed"),{recorded:null,clear:true});
});

test("an uncertain command's reconciliation is never dropped, even long after the scope changed",()=>{
  for(const [status,when] of [["uncertain","idle"],["idle","uncertain"],["committed","uncertain"],["uncertain","committed"],["checking","error"]])
    assert.equal(decide("all","personal",status,when).clear,false,status+when);
});

test("same scope never clears; first non-idle after idle records the current scope",()=>{
  assert.equal(decide("shared","shared","committed").clear,false);
  assert.deepEqual(decide(null,"shared","committed"),{recorded:"shared",clear:false});
});

test("wiring: the preview uses the helper and renders rows only for the current filter",()=>{
  const source=readFileSync(path.resolve(import.meta.dirname,"../app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  assert.match(source,/scopeFeedbackDecision\(\{/);
  assert.match(source,/if\(decision\.clear\)resetFeedback\(\)/);
  assert.match(source,/state\.page\.evaluationDate===date&&state\.page\.areaFilter===areaFilter/);
});
