import assert from "node:assert/strict";
import {test} from "node:test";
import {activeTargetViewFor,detailsActive,targetViewsFor,targetShellNavigationFor,targetMobileMoreCurrentViews,legacyInboxMailViewFor,retiredArchiveAddress,retiredArchiveView,SHELL_NAVIGATION_VIEWS} from "../lib/target-shell-views.ts";
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
  const inbox={...off,personalV1:true,homeRead:true,inboxRead:true};
  assert.deepEqual(targetViewsFor(inbox),["Home","Upcoming","Inbox"]);
  assert.deepEqual(targetViewsFor({...inbox,inboxRead:false}),["Home","Upcoming"]);
});

test("details without a list or plan to open them from are inert",()=>{
  const all={task:true,project:true,note:true};
  assert.equal(detailsActive(all,[]),false);
  assert.equal(detailsActive(all,["Projects"]),true);
  assert.equal(detailsActive({task:false,project:false,note:true},["Projects"]),false);
  assert.equal(detailsActive({task:true,project:false,note:false},["MyPlanPreview"]),true);
  assert.equal(detailsActive({task:true,project:false,note:false},["Notes"]),false);
  assert.equal(detailsActive({task:true,project:false,note:false},["Inbox"]),true);
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
  assert.equal(at("Inbox",false,{personalV1:true,homeRead:true,inboxRead:true}),"Inbox");
  assert.equal(at("Inbox",false,{personalV1:true,homeRead:true,inboxRead:false}),null);
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

const personalV1={scopesOn:true,projectsList:true,notesList:true,myPlan:true,
  v1Shell:true,targetSearch:true,quickCapture:true};

test("D: personal-v1 has no Archive navigation or legacy destinations",()=>{
  const model=targetShellNavigationFor(personalV1);
  assert.equal(model.personalV1,true);
  assert.deepEqual(model.primary,["MyPlanPreview","Projects","Notes","Calendar","Search"]);
  assert.deepEqual(model.archive,[]);
  assert.equal(model.quickCapture,true);
  assert.equal(model.byView.Today,"hidden","legacy Today must not masquerade as My Plan");
  assert.equal(model.byView.MyPlanPreview,"primary");
  assert.equal(model.byView.Home,"hidden");
  assert.equal(model.byView.Upcoming,"hidden");
  assert.equal(model.byView.LegacyHome,"hidden");
  assert.equal(model.byView.LegacyUpcoming,"hidden");
  assert.equal(model.byView.Settings,"hidden");
  assert.equal(model.byView.Agents,"hidden");
  assert.deepEqual(Object.keys(model.byView).sort(),[...SHELL_NAVIGATION_VIEWS].sort(),
    "every shell destination is classified once");
  assert.equal(new Set([...model.primary,...model.archive,...model.hidden]).size,SHELL_NAVIGATION_VIEWS.length);
});

test("C-1: off and partial flags must not activate archive navigation",()=>{
  for(const absent of Object.keys(personalV1)){
    const model=targetShellNavigationFor({...personalV1,[absent]:false});
    assert.equal(model.personalV1,false,absent);
    assert.deepEqual(model.primary,[],absent);
    assert.deepEqual(model.archive,[],absent);
    assert.equal(model.quickCapture,false,absent);
  }
  assert.equal(targetShellNavigationFor({...personalV1,...off,targetSearch:false,quickCapture:false}).personalV1,false);
});


test("C-2: only complete personal-v1 promotes authorized Home and Upcoming",()=>{
  const fields={...personalV1,personalV1:true,homeRead:true};
  const targetNavigation=targetShellNavigationFor(fields);
  assert.deepEqual(targetNavigation.primary,["MyPlanPreview","Home","Upcoming","Projects","Notes","Calendar","Search"]);
  assert.deepEqual(targetNavigation.archive,[]);
  const views=targetViewsFor(fields);
  assert.deepEqual(views,["Projects","Notes","MyPlanPreview","Home","Upcoming"]);
  assert.equal(activeTargetViewFor({...fields,view:"Home",planActive:false}).active,"Home");
  assert.equal(activeTargetViewFor({...fields,view:"Upcoming",planActive:false}).active,"Upcoming");
  for(const view of ["LegacyHome","LegacyUpcoming","Inbox"]){
    assert.equal(activeTargetViewFor({...fields,view,planActive:false}).active,null);
  }
  assert.equal(detailsActive({task:true,project:false,note:false},["Upcoming"]),true);
  const without={...personalV1,personalV1:false,homeRead:true};
  assert.deepEqual(targetShellNavigationFor({...personalV1,homeRead:false}).primary,
    ["MyPlanPreview","Projects","Notes","Calendar","Search"]);
  assert.equal(activeTargetViewFor({...without,view:"Upcoming",planActive:false}).active,null);
  assert.equal(targetViewsFor(without).includes("Upcoming"),false);
});


test("D: target Inbox is primary but all Legacy destinations are removed",()=>{
  const ready={...personalV1,personalV1:true,homeRead:true,inboxRead:true};
  const nav=targetShellNavigationFor(ready);
  assert.deepEqual(nav.primary,["MyPlanPreview","Home","Inbox","Upcoming","Projects","Notes","Calendar","Search"]);
  assert.deepEqual(nav.archive,[]);
  assert.equal(nav.byView.Inbox,"primary");
  assert.equal(nav.byView.LegacyInbox,"hidden");
  assert.equal(nav.byView.LegacyHome,"hidden");
  assert.equal(new Set([...nav.primary,...nav.archive,...nav.hidden]).size,SHELL_NAVIGATION_VIEWS.length);
  for(const key of ["homeRead","inboxRead"]){
    const withheld=targetShellNavigationFor({...ready,[key]:false});
    assert.equal(withheld.byView.Inbox,"hidden");
    assert.equal(withheld.byView.LegacyInbox,"hidden");
  }
  const offNav=targetShellNavigationFor({...ready,quickCapture:false});
  assert.equal(offNav.personalV1,false);
  assert.equal(offNav.byView.LegacyInbox,"hidden");
});

test("D: mobile More offers only current Inbox and no Archive",()=>{
  const ready={...personalV1,personalV1:true,homeRead:true,inboxRead:true};
  const nav=targetShellNavigationFor(ready);
  const current=targetMobileMoreCurrentViews(nav);
  assert.deepEqual(current,["Home","Inbox","Upcoming","Notes","Search"]);
  assert.deepEqual(nav.archive,[]);
  assert.equal(current.filter(v=>v==="Inbox").length,1);
  assert.ok(!current.includes("LegacyInbox"));
  assert.equal(new Set([...current,...nav.archive]).size,current.length+nav.archive.length);
  const noTarget=targetShellNavigationFor({...ready,inboxRead:false});
  assert.equal(targetMobileMoreCurrentViews(noTarget).includes("Inbox"),false);
});

test("C-3a: historical Gmail source follows archive alias only after complete target cutover",()=>{
  assert.equal(legacyInboxMailViewFor(false,false),"Inbox");
  assert.equal(legacyInboxMailViewFor(false,true),"Inbox","off mode stays unchanged");
  assert.equal(legacyInboxMailViewFor(true,false),"Inbox","C-2 archive remains readable");
  assert.equal(legacyInboxMailViewFor(true,true),"LegacyInbox");
});

test("D: all former Archive links redirect only in personal-v1",()=>{
  for (const route of ["LegacyHome","LegacyInbox","LegacyUpcoming","Today","Overdue",
    "Anytime","Someday","Completed","Areas","Context"])
    assert.equal(retiredArchiveView(route),true,route);
  for (const current of ["MyPlanPreview","Home","Inbox","Upcoming","Projects","Notes","Calendar","Search","Agents","Settings"])
    assert.equal(retiredArchiveView(current),false,current);
  for (const search of ["?view=LegacyHome", "?view=LegacyObsolete", "?view=Archive", "?view=Today&scope=personal"])
    assert.equal(retiredArchiveAddress(search),true,search);
  for (const search of ["?view=Home","?view=Notes&noteId=target","?view=Settings"])
    assert.equal(retiredArchiveAddress(search),false,search);
  // The router uses this classifier only when personalV1 is active;
  // the 'off' model remains exactly as before.
  assert.equal(targetShellNavigationFor({...personalV1,quickCapture:false}).personalV1,false);
});
