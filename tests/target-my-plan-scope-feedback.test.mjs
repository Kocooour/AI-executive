import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {scopeFeedbackDecision} from "../lib/target-my-plan-scope-feedback.ts";

const decide=(recorded,current,statusKind,whenKind="idle")=>
  scopeFeedbackDecision({recorded,current,statusKind,whenKind});

const keep=recorded=>({recorded,clearStatus:false,clearWhen:false});

test("feedback is recorded against the scope current when the first write starts",()=>{
  assert.deepEqual(decide(null,"all","pending"),keep("all"));
  assert.deepEqual(decide(null,"personal","idle","pending"),keep("personal"));
  assert.deepEqual(decide("all","all","committed"),keep("all"));
});

test("idle forgets the recorded scope and never clears anything",()=>{
  assert.deepEqual(decide("all","shared","idle"),keep(null));
});

test("Personal -> Shared DURING a status write: kept while in flight, cleared once settled",()=>{
  for(const kind of ["pending","checking"])
    assert.deepEqual(decide("personal","shared",kind),keep("personal"),kind);
  assert.deepEqual(decide("personal","shared","committed"),{recorded:null,clearStatus:true,clearWhen:false});
  assert.deepEqual(decide("personal","shared","error"),{recorded:null,clearStatus:true,clearWhen:false});
});

test("Personal -> Shared DURING a When write: kept while in flight, cleared once settled",()=>{
  for(const kind of ["pending","checking"])
    assert.deepEqual(decide("personal","shared","idle",kind),keep("personal"),kind);
  assert.deepEqual(decide("personal","shared","idle","committed"),{recorded:null,clearStatus:false,clearWhen:true});
  assert.deepEqual(decide("personal","shared","idle","error"),{recorded:null,clearStatus:false,clearWhen:true});
});

test("uncertain outcomes are never dropped, and never keep the OTHER family's settled Undo alive",()=>{
  // Uncertain status: its reconciliation stays (no clear).
  assert.deepEqual(decide("personal","shared","uncertain"),keep("personal"));
  assert.deepEqual(decide("personal","shared","idle","uncertain"),keep("personal"));
  // Committed status Undo of Personal next to an uncertain When: the status
  // Undo is cleared at once, the When reconciliation is kept.
  assert.deepEqual(decide("personal","shared","committed","uncertain"),
    {recorded:"personal",clearStatus:true,clearWhen:false});
  assert.deepEqual(decide("personal","shared","uncertain","committed"),
    {recorded:"personal",clearStatus:false,clearWhen:true});
  assert.deepEqual(decide("personal","shared","checking","error"),
    {recorded:"personal",clearStatus:false,clearWhen:true});
  // Once the uncertain one is reconciled (settles), it is cleared too.
  assert.deepEqual(decide("personal","shared","idle","committed"),{recorded:null,clearStatus:false,clearWhen:true});
});

test("same scope never clears; first non-idle after idle records the current scope",()=>{
  assert.deepEqual(decide("shared","shared","committed"),keep("shared"));
  assert.deepEqual(decide(null,"shared","committed"),keep("shared"));
});

test("wiring: the preview uses the helper and renders rows only for the current filter",()=>{
  const source=readFileSync(path.resolve(import.meta.dirname,"../app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  assert.match(source,/scopeFeedbackDecision\(\{/);
  assert.match(source,/if\(decision\.clearStatus\)resetStatusFeedback\(\);/);
  assert.match(source,/if\(decision\.clearWhen\)resetWhenFeedback\(\);/);
  assert.match(source,/state\.page\.evaluationDate===date&&state\.page\.areaFilter===areaFilter/);
});
