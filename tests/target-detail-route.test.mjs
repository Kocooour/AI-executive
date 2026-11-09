import assert from "node:assert/strict";
import {test} from "node:test";
import {
  canStepBack,detailHistoryState,detailRequestFromSearch,detailRouteFromSearch,detailRouteKey,
  detailRowKey,isParentOf,isPlanDetailSearch,parentSearchForDetail,requestsTargetRecord,searchForDetail,
  TARGET_ADDRESS_EVENT,
} from "../lib/target-detail-route.ts";
import {scopeFromSearch} from "../lib/view-url.ts";

const all={task:true,project:true,note:true};
const none={task:false,project:false,note:false};

test("project, task and note routes round-trip through the address, keeping the scope",()=>{
  const routes=[
    {kind:"project",id:"p1",view:"Projects"},
    {kind:"task",id:"t1",view:"Projects",projectId:"p1"},
    {kind:"task",id:"t2",view:"MyPlanPreview"},
    {kind:"note",id:"n1",view:"Notes"},
  ];
  for(const route of routes)for(const scope of ["all","personal","shared"]){
    const search=searchForDetail(route,scope);
    assert.deepEqual(detailRouteFromSearch(search),route,search);
    assert.equal(scopeFromSearch(search),scope,search);
    // The default scope is omitted from the address.
    assert.equal(search.includes("scope="),scope!=="all",search);
  }
  assert.equal(searchForDetail(routes[0],"all"),"?view=Projects&projectId=p1");
  assert.equal(searchForDetail(routes[1],"shared"),"?view=Projects&projectId=p1&taskId=t1&scope=shared");
  assert.equal(searchForDetail(routes[2],"all"),"?view=MyPlanPreview&taskId=t2");
  assert.equal(searchForDetail(routes[3],"personal"),"?view=Notes&noteId=n1&scope=personal");
});

test("opaque ids are encoded, never interpreted",()=>{
  const id="a b/ž&=?#%";
  const route={kind:"note",id,view:"Notes"};
  assert.deepEqual(detailRouteFromSearch(searchForDetail(route,"all")),route);
  assert.throws(()=>searchForDetail({kind:"note",id:"",view:"Notes"},"all"));
  assert.throws(()=>searchForDetail({kind:"note",id:"x\u0000y",view:"Notes"},"all"));
  assert.throws(()=>searchForDetail({kind:"note",id:"x".repeat(257),view:"Notes"},"all"));
});

test("invalid, ambiguous and impossible addresses are never routes",()=>{
  for(const search of [
    "?noteId=n1",                               // no explicit view
    "?view=Notes&noteId=",                      // empty id
    "?view=Notes&noteId=a&noteId=b",            // duplicate key
    "?view=Notes&noteId=a&taskId=b",            // two targets
    "?view=Notes&projectId=p&noteId=n",         // project parent only valid under Projects
    "?view=Projects&taskId=t",                  // a task is always in a project or in My Plan
    "?view=MyPlanPreview&projectId=p&taskId=t", // plan tasks have no project parent
    "?view=Projects&projectId=p&noteId=n",      // project notes are not a read path yet
    "?view=Home&projectId=p",                   // wrong view
    "?view=Nope&noteId=n",                      // unknown view
    "?view=Notes&noteId=n&extra=1",             // unknown key
    "?view=Notes&noteId=a%00b",                 // control character
    "?view=Notes",                              // a plain view is no record
    "",
  ])assert.equal(detailRouteFromSearch(search),null,search);
});

test("request: none for plain addresses, one calm 'unavailable' for anything unusable",()=>{
  assert.deepEqual(detailRequestFromSearch("",all),{state:"none"});
  assert.deepEqual(detailRequestFromSearch("?view=Notes&scope=shared",all),{state:"none"});
  assert.deepEqual(detailRequestFromSearch("?view=Notes&noteId=n1",all),
    {state:"route",route:{kind:"note",id:"n1",view:"Notes"}});
  // Malformed and gated-off kinds are indistinguishable from each other.
  assert.deepEqual(detailRequestFromSearch("?view=Notes&noteId=a&noteId=b",all),{state:"unavailable"});
  assert.deepEqual(detailRequestFromSearch("?view=Notes&noteId=n1",{...all,note:false}),{state:"unavailable"});
  assert.deepEqual(detailRequestFromSearch("?view=Projects&projectId=p",none),{state:"unavailable"});
  assert.deepEqual(detailRequestFromSearch("?view=MyPlanPreview&taskId=t",{...all,task:false}),{state:"unavailable"});
  assert.equal(requestsTargetRecord("?view=Notes&noteId="),true);
  assert.equal(requestsTargetRecord("?view=Notes&scope=all"),false);
});

test("plan detail addresses are recognised so the shell can show the plan",()=>{
  assert.equal(isPlanDetailSearch("?view=MyPlanPreview&taskId=t1&scope=shared"),true);
  assert.equal(isPlanDetailSearch("?view=MyPlanPreview"),false);
  assert.equal(isPlanDetailSearch("?view=Projects&projectId=p"),false);
});

test("close leads to the parent of the current scope: project for a project task, else the list",()=>{
  assert.equal(parentSearchForDetail({kind:"task",id:"t",view:"Projects",projectId:"p"},"personal"),
    "?view=Projects&projectId=p&scope=personal");
  assert.equal(parentSearchForDetail({kind:"project",id:"p",view:"Projects"},"shared"),"?view=Projects&scope=shared");
  assert.equal(parentSearchForDetail({kind:"note",id:"n",view:"Notes"},"all"),"?view=Notes");
  assert.equal(parentSearchForDetail({kind:"task",id:"t",view:"MyPlanPreview"},"personal"),
    "?view=MyPlanPreview&scope=personal");
  assert.equal(parentSearchForDetail(null,"all"),"?view=Projects");
  assert.equal(isParentOf({kind:"project",id:"p",view:"Projects"},{kind:"task",id:"t",view:"Projects",projectId:"p"}),true);
  assert.equal(isParentOf({kind:"project",id:"q",view:"Projects"},{kind:"task",id:"t",view:"Projects",projectId:"p"}),false);
});

test("Back is used only for an entry this tab pushed under the same scope",()=>{
  assert.equal(canStepBack(detailHistoryState("all"),"?view=Notes&noteId=n"),true);
  assert.equal(canStepBack(detailHistoryState("shared"),"?view=Notes&noteId=n&scope=shared"),true);
  // The scope changed after opening: closing must not return to a stale scope.
  assert.equal(canStepBack(detailHistoryState("all"),"?view=Notes&noteId=n&scope=shared"),false);
  for(const state of [null,undefined,{},{lumiTargetDetail:null},"x",{lumiRecord:"n"}])
    assert.equal(canStepBack(state,"?view=Notes&noteId=n"),false);
});

test("keys are stable and never contain more than kind, id and parent",()=>{
  assert.equal(detailRowKey("task","t"),"task:t");
  assert.equal(detailRouteKey({kind:"task",id:"t",view:"Projects",projectId:"p"}),"task:t@p");
  assert.equal(TARGET_ADDRESS_EVENT,"lumi-target-address-changed");
});
