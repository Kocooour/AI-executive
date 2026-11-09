import assert from "node:assert/strict";
import {test} from "node:test";
import {
  canStepBack,detailActivation,detailHistoryState,detailIdOk,holdTypedAddress,isTargetAddress,
  shouldLeaveTypedAddress,viewOfSearch,withoutDetailMarker,detailRequestFromSearch,detailRouteFromSearch,detailRouteKey,
  detailRowKey,isParentOf,isPlanDetailSearch,parentSearchForDetail,requestsTargetRecord,searchForDetail,
  TARGET_ADDRESS_EVENT,
} from "../lib/target-detail-route.ts";
import {addressUpdate,scopeFromSearch} from "../lib/view-url.ts";

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
  const id="a bž&=?#%+";
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

test("Back is used only for an entry this tab pushed for exactly this address and scope",()=>{
  const a="?view=Notes&noteId=n";
  assert.equal(canStepBack(detailHistoryState("all",a),a),true);
  const b="?view=Notes&noteId=n&scope=shared";
  assert.equal(canStepBack(detailHistoryState("shared",b),b),true);
  // The scope changed after opening: closing must not return to a stale scope.
  assert.equal(canStepBack(detailHistoryState("all",a),b),false);
  // A copy of the marker on another entry with the same scope but another address never counts.
  assert.equal(canStepBack(detailHistoryState("all",a),"?view=Notes&noteId=other"),false);
  for(const state of [null,undefined,{},{lumiTargetDetail:null},"x",{lumiRecord:"n"}])
    assert.equal(canStepBack(state,a),false);
});

test("a scope change never carries the detail marker into its new history entry",()=>{
  const a="?view=Notes&noteId=n";
  const state=detailHistoryState("all",a);
  assert.equal(withoutDetailMarker(state),null);
  assert.deepEqual(withoutDetailMarker({...state,other:1}),{other:1});
  assert.equal(withoutDetailMarker(null),null);
  assert.deepEqual(withoutDetailMarker({x:1}),{x:1});
  // Close after a scope change: the new entry has no marker, so Close replaces to the list of the NEW scope.
  const afterScope="?view=Notes&noteId=n&scope=shared";
  assert.equal(canStepBack(withoutDetailMarker(state),afterScope),false);
  assert.equal(parentSearchForDetail({kind:"note",id:"n",view:"Notes"},"shared",afterScope),"?view=Notes&scope=shared");
});

test("closing the unavailable overlay returns to the current view's own parent address",()=>{
  assert.equal(parentSearchForDetail(null,"all","?view=Notes&noteId=a&noteId=b"),"?view=Notes");
  assert.equal(parentSearchForDetail(null,"shared","?view=MyPlanPreview&taskId="),"?view=MyPlanPreview&scope=shared");
  assert.equal(parentSearchForDetail(null,"all","?view=Projects&projectId=x%00"),"?view=Projects");
  // A view that is not a detail view falls back to Projects (never to a legacy view).
  assert.equal(parentSearchForDetail(null,"all","?view=Inbox&taskId=x"),"?view=Projects");
  assert.equal(viewOfSearch("?view=Notes&noteId=1&scope=shared"),"Notes");
});

test("ID rule: the intersection of address, client and server rules; unopenable IDs are text",()=>{
  for(const ok of ["a","abc-123","uuid-0000","ž č","x".repeat(256)])assert.equal(detailIdOk(ok),true,ok);
  for(const bad of ["", " a","a ", ".","..","a/b","a\\b","a\u0001","a\u007f","x".repeat(257),"\ud800","a\n"])
    assert.equal(detailIdOk(bad),false,JSON.stringify(bad));
  assert.equal(detailIdOk(null),false);
  assert.equal(detailIdOk(5),false);
  // Whatever passes survives the address round trip exactly.
  for(const id of ["a b","ž&=?#%+","x".repeat(256)]){
    const route={kind:"note",id,view:"Notes"};
    assert.deepEqual(detailRouteFromSearch(searchForDetail(route,"all")),route);
  }
  // A parent ID that fails the rule makes the whole address unusable.
  assert.equal(detailRouteFromSearch("?view=Projects&projectId=a%2Fb&taskId=t"),null);
});

test("target addresses are acted on only for views that really render target data",()=>{
  const views=["Projects"];
  assert.equal(isTargetAddress("?view=Projects&projectId=p",views),true);
  // Legacy writers: legacy inspect (?view=Today&taskId=L) and legacy project pages with flags/lists off.
  assert.equal(isTargetAddress("?view=Today&taskId=L",views),false);
  assert.equal(isTargetAddress("?view=Home&taskId=L",views),false);
  assert.equal(isTargetAddress("?view=Notes&noteId=L",views),false);
  assert.equal(isTargetAddress("?view=Projects&projectId=p",[]),false);
  assert.equal(isTargetAddress("?view=Projects",views),false);
  assert.equal(isTargetAddress("?projectId=p",views),false);
  const gates={task:true,project:true,note:true};
  assert.deepEqual(detailActivation({search:"?view=Today&taskId=L",gates,activeTargetView:null}),{state:"none"});
  assert.deepEqual(detailActivation({search:"?view=Projects&projectId=p",gates,activeTargetView:null}),{state:"none"});
  // An address for another view than the one on screen is ignored, not rendered.
  assert.deepEqual(detailActivation({search:"?view=Notes&noteId=n",gates,activeTargetView:"Projects"}),{state:"none"});
  assert.deepEqual(detailActivation({search:"?view=MyPlanPreview&taskId=t",gates,activeTargetView:"Projects"}),{state:"none"});
  assert.deepEqual(detailActivation({search:"?view=Projects&projectId=p",gates,activeTargetView:"Projects"}),
    {state:"route",route:{kind:"project",id:"p",view:"Projects"}});
  assert.deepEqual(detailActivation({search:"?view=Projects&projectId=a&projectId=b",gates,activeTargetView:"Projects"}),
    {state:"unavailable"});
  assert.deepEqual(detailActivation({search:"?view=Notes&noteId=n",gates:{...gates,note:false},activeTargetView:"Notes"}),
    {state:"unavailable"});
  assert.deepEqual(detailActivation({search:"?view=Notes",gates,activeTargetView:"Notes"}),{state:"none"});
});

test("cold start: a target address survives restore; only an explicit view choice leaves it",()=>{
  const search="?view=Projects&projectId=p1&scope=shared";
  const base={enabled:true,search,targetViews:["Projects"]};
  // Startup/restore calls setView with keepAddress: the address is never rewritten.
  assert.equal(shouldLeaveTypedAddress({...base,keepAddress:true}),false);
  // The address effect runs first with the initial view, then with the restored one.
  assert.equal(holdTypedAddress({...base,navigationView:"Projects"}),true);
  assert.equal(holdTypedAddress({...base,navigationView:"Home"}),false,"another view replaces the address (normal view sync)");
  // A user's view choice while the detail is open is one new view-only history step.
  assert.equal(shouldLeaveTypedAddress({...base,keepAddress:false}),true);
  // Same for every shape.
  for(const shape of ["?view=Projects&projectId=p&taskId=t","?view=Notes&noteId=n"]){
    const views=["Projects","Notes"];
    assert.equal(shouldLeaveTypedAddress({enabled:true,keepAddress:true,search:shape,targetViews:views}),false,shape);
    assert.equal(holdTypedAddress({enabled:true,search:shape,navigationView:shape.includes("Notes")?"Notes":"Projects",targetViews:views}),true,shape);
  }
  assert.equal(holdTypedAddress({enabled:true,search:"?view=MyPlanPreview&taskId=t",navigationView:"MyPlanPreview",targetViews:["MyPlanPreview"]}),true);
  // Flags off or a legacy view: exactly the legacy behaviour (never leave/hold).
  assert.equal(shouldLeaveTypedAddress({enabled:false,keepAddress:false,search,targetViews:["Projects"]}),false);
  assert.equal(holdTypedAddress({enabled:false,search,navigationView:"Projects",targetViews:["Projects"]}),false);
  assert.equal(holdTypedAddress({enabled:true,search:"?view=Today&taskId=L",navigationView:"Today",targetViews:["Projects"]}),false);
});

test("keys are stable and never contain more than kind, id and parent",()=>{
  assert.equal(detailRowKey("task","t"),"task:t");
  assert.equal(detailRouteKey({kind:"task",id:"t",view:"Projects",projectId:"p"}),"task:t@p");
  assert.equal(TARGET_ADDRESS_EVENT,"lumi-target-address-changed");
});

test("desktop (no v1 shell): ?view=MyPlanPreview&taskId is ignored AND replaced by the normal address",()=>{
  // targetViews has no MyPlanPreview there, so the layer ignores the address ...
  assert.equal(isTargetAddress("?view=MyPlanPreview&taskId=t",["Projects"]),false);
  assert.equal(holdTypedAddress({enabled:true,search:"?view=MyPlanPreview&taskId=t",navigationView:"Home",targetViews:["Projects"]}),false);
  // ... and the normal address sync replaces it (replace, not a new history step; scope kept).
  assert.deepEqual(addressUpdate({currentSearch:"?view=MyPlanPreview&taskId=t",view:"Home",startView:"Home",navigated:false}),
    {search:"",mode:"replace"});
  assert.deepEqual(addressUpdate({currentSearch:"?view=MyPlanPreview&taskId=t&scope=shared",view:"Home",startView:"Home",navigated:false}),
    {search:"?scope=shared",mode:"replace"});
});
