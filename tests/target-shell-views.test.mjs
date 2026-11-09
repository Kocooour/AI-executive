import assert from "node:assert/strict";
import {test} from "node:test";
import {activeTargetViewFor,detailsActive,targetViewsFor} from "../lib/target-shell-views.ts";
import {refusalBudgetFor} from "../lib/target-refusal-budget.ts";
import {detailIdOk} from "../lib/target-detail-route.ts";
import {validTaskPreviewId} from "../lib/target-staging-task-preview-client.ts";
import {validNotePreviewId} from "../lib/target-staging-note-preview-client.ts";
import {readableProjectId} from "../lib/target-staging-project-tasks-client.ts";
import {isReadableStagingProjectId} from "../lib/target-project-id.ts";
import {scopeFromSearch,targetFromSearch} from "../lib/view-url.ts";

const off={scopesOn:false,projectsList:false,notesList:false,myPlan:false,v1Shell:false};

test("target views exist only where a target list or the target plan really renders",()=>{
  assert.deepEqual(targetViewsFor(off),[]);
  assert.deepEqual(targetViewsFor({...off,scopesOn:true}),[]);
  assert.deepEqual(targetViewsFor({...off,scopesOn:true,projectsList:true}),["Projects"]);
  assert.deepEqual(targetViewsFor({...off,projectsList:true}),[],"a list flag without the switcher is inert");
  assert.deepEqual(targetViewsFor({...off,scopesOn:true,projectsList:true,notesList:true,myPlan:true,v1Shell:true}),
    ["Projects","Notes","MyPlanPreview"]);
  assert.deepEqual(targetViewsFor({...off,myPlan:true}),[],"the plan needs the v1 shell");
});

test("details without a list or plan to open them from are inert",()=>{
  const all={task:true,project:true,note:true};
  assert.equal(detailsActive(all,[]),false);
  assert.equal(detailsActive(all,["Projects"]),true);
  assert.equal(detailsActive({task:false,project:false,note:true},["Projects"]),false);
  assert.equal(detailsActive({task:true,project:false,note:false},["MyPlanPreview"]),true);
  assert.equal(detailsActive({task:true,project:false,note:false},["Notes"]),false);
  assert.equal(detailsActive({task:false,project:false,note:false},["Projects"]),false);
});

test("the target view on screen: lists per flag, the plan only in the v1 'Můj plán' entry",()=>{
  const input={scopesOn:true,projectsList:true,notesList:true,myPlan:true,v1Shell:true};
  const at=(view,planActive=false,more={})=>activeTargetViewFor({...input,...more,view,planActive}).active;
  assert.equal(at("Projects"),"Projects");
  assert.equal(at("Notes"),"Notes");
  assert.equal(at("Today",true),"MyPlanPreview");
  assert.equal(at("Today",false),null,"legacy Today");
  for(const legacy of ["Home","Inbox","Upcoming","Calendar","Areas","Search"])assert.equal(at(legacy),null,legacy);
  assert.equal(at("Projects",false,{projectsList:false}),null);
  assert.equal(at("Notes",false,{scopesOn:false}),null);
  assert.equal(at("Today",true,{v1Shell:false}),null);
});

test("one refusal budget per runtime, shared by every consumer",()=>{
  const runtimeA={},runtimeB={};
  assert.equal(refusalBudgetFor(runtimeA),refusalBudgetFor(runtimeA));
  assert.notEqual(refusalBudgetFor(runtimeA),refusalBudgetFor(runtimeB));
  const shared=refusalBudgetFor(runtimeB);
  assert.equal(shared.admit(),true);
  assert.equal(shared.admit(),true);
  // A third consumer asking the same runtime is refused: the budget does not multiply.
  assert.equal(refusalBudgetFor(runtimeB).admit(),false);
  refusalBudgetFor(runtimeB).reset();
  assert.equal(refusalBudgetFor(runtimeB).admit(),true);
  assert.equal(refusalBudgetFor(null),refusalBudgetFor(null));
});

test("ID parity: whatever the detail layer opens, every strict client and the address accept",()=>{
  const samples=["a","a b","ž","x".repeat(256),"x".repeat(257),"","  ","a ",".","..","a/b","a\\b","a\u0001","\ud800","a\n","é".repeat(200),"%2F","a&b=c"];
  for(const id of samples){
    const ok=detailIdOk(id);
    if(!ok)continue;
    assert.equal(validTaskPreviewId(id),true,"task "+JSON.stringify(id));
    assert.equal(validNotePreviewId(id),true,"note "+JSON.stringify(id));
    assert.equal(readableProjectId(id),true,"project "+JSON.stringify(id));
    assert.equal(isReadableStagingProjectId(id),true,"project route "+JSON.stringify(id));
    const search="?view=Notes&noteId="+encodeURIComponent(id);
    assert.deepEqual(targetFromSearch(search,["Home","Notes"],"Home"),{kind:"note",id,view:"Notes"});
  }
  // Rows for IDs the layer cannot open are text: these are exactly the server-only IDs.
  for(const serverOnly of ["", " padded ","a/b"])assert.equal(detailIdOk(serverOnly),false);
  assert.equal(scopeFromSearch("?scope=shared"),"shared");
});
