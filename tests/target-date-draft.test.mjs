import assert from "node:assert/strict";
import {test} from "node:test";
import {reconcileDateDraft,displayedDateDraft} from "../lib/target-date-draft.ts";

const context={identity:"actor:scope:task:area",snapshot:"when:due",value:"2026-11-27",allowed:true};
const record={identity:context.identity,snapshot:context.snapshot,
  draft:{value:"2026-12-01",confirming:true},resetNotice:false};
test("an unchanged authorized snapshot keeps the draft and confirmation through a passive check",()=>{
  const checking={...context,allowed:null,snapshot:"pending"};
  assert.equal(reconcileDateDraft(record,checking),record);
  assert.deepEqual(displayedDateDraft(record,checking),{value:context.value,confirming:false});
  assert.equal(reconcileDateDraft(record,context),record);
  assert.deepEqual(displayedDateDraft(record,context),record.draft);
});
test("a changed authoritative date resets the draft and confirmation, with a visible reset notice",()=>{
  const changed={...context,snapshot:"new:due",value:"2026-11-28"};
  const next=reconcileDateDraft(record,changed);
  assert.deepEqual(next,{identity:context.identity,snapshot:changed.snapshot,
    draft:{value:changed.value,confirming:false},resetNotice:true});
  assert.deepEqual(displayedDateDraft(record,changed),next.draft);
  assert.notEqual(reconcileDateDraft(next,context).draft.value,record.draft.value);
});
test("a new actor, scope, task, Area or denied write cannot inherit a draft",()=>{
  for(const changed of [{...context,allowed:false},{...context,identity:"other",allowed:null}]){
    assert.equal(reconcileDateDraft(record,changed),null);
    assert.deepEqual(displayedDateDraft(record,changed),{value:context.value,confirming:false});
  }
});
