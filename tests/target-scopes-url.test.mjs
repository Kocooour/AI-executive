import assert from "node:assert/strict";
import {test} from "node:test";
import {
  addressUpdate,scopeFromSearch,searchForView,searchWithScope,searchWithoutScope,
  targetFromSearch,viewExitFromProject,viewFromSearch,urlScopes,
} from "../lib/view-url.ts";
import {mobileV1IsPlanPreviewRoute} from "../app/ui/navigation.ts";

const views=["Home","Today","Projects","Notes","Areas"];

test("R3-FE-3 scope: parse and serialize round-trip; default is omitted",()=>{
  assert.deepEqual([...urlScopes],["all","personal","shared"]);
  assert.equal(scopeFromSearch(""),"all");
  assert.equal(scopeFromSearch("?view=Projects"),"all");
  for(const scope of urlScopes){
    const search=searchWithScope("?view=Projects",scope);
    assert.equal(scopeFromSearch(search),scope);
    assert.equal(searchWithoutScope(search),"?view=Projects");
  }
  assert.equal(searchWithScope("?view=Projects","all"),"?view=Projects");
  assert.equal(searchWithScope("?view=Projects","shared"),"?view=Projects&scope=shared");
  assert.equal(searchWithScope("","personal"),"?scope=personal");
  assert.equal(searchWithScope("?view=Projects&scope=shared","all"),"?view=Projects");
  assert.equal(searchWithScope("?scope=shared","all"),"");
  assert.equal(searchWithScope("?scope=shared","personal"),"?scope=personal");
});

test("R3-FE-3 scope: invalid, empty, duplicated and case-changed values read as the default",()=>{
  for(const search of ["?scope=","?scope=bogus","?scope=ALL","?scope=Shared","?scope=shared&scope=personal",
    "?scope=%00","?scope=all%20","?scope[]=shared","?scope=__proto__"])
    assert.equal(scopeFromSearch(search),"all",search);
  // An invalid scope is cleaned out of the address, never kept as a claim.
  assert.equal(searchWithScope("?view=Notes&scope=bogus","all"),"?view=Notes");
});

test("R3-FE-3 scope never disturbs view or record targets",()=>{
  assert.equal(viewFromSearch("?view=Projects&scope=shared",views),"Projects");
  assert.deepEqual(targetFromSearch("?view=Projects&scope=personal",views,"Home"),{kind:"view",view:"Projects"});
  assert.deepEqual(targetFromSearch("?scope=shared",views,"Home"),{kind:"view",view:"Home"});
  assert.deepEqual(targetFromSearch("?view=Projects&projectId=p1&scope=shared",views,"Home"),{kind:"project",id:"p1"});
  // Unknown keys still invalidate the target; a bogus or duplicated scope does not choose a record.
  assert.equal(targetFromSearch("?view=Projects&extra=1&scope=shared",views,"Home"),null);
  assert.deepEqual(targetFromSearch("?view=Projects&scope=a&scope=b",views,"Home"),{kind:"view",view:"Projects"});
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview"),true);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview&scope=shared"),true);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview&x=1&scope=shared"),false);
  assert.equal(mobileV1IsPlanPreviewRoute("?scope=shared"),false);
});

test("R3-FE-3 scope: switching view keeps the shared scope (one state across views)",()=>{
  const move=(currentSearch,view)=>addressUpdate({currentSearch,view,startView:"Home",navigated:true});
  assert.deepEqual(move("?view=Projects&scope=shared","Notes"),{search:"?view=Notes&scope=shared",mode:"push"});
  assert.deepEqual(move("?view=Projects&scope=personal","MyPlanPreview"),{search:"?view=MyPlanPreview&scope=personal",mode:"push"});
  assert.deepEqual(move("?view=Projects&scope=shared","Home"),{search:"?scope=shared",mode:"push"});
  assert.deepEqual(move("?view=Projects","Notes"),{search:"?view=Notes",mode:"push"});
  // Nothing to do when the address already matches; an invalid scope is replaced away.
  assert.equal(move("?view=Notes&scope=shared","Notes"),null);
  assert.deepEqual(addressUpdate({currentSearch:"?view=Notes&scope=bogus",view:"Notes",startView:"Home",navigated:false}),
    {search:"?view=Notes",mode:"replace"});
  assert.equal(searchForView("Notes","Home"),"?view=Notes"); // legacy serializer unchanged
  assert.deepEqual(viewExitFromProject({currentSearch:"?view=Projects&projectId=p1&scope=shared",
    currentProjectId:"p1",nextView:"Notes",knownViews:views,startView:"Home"}),
    {search:"?view=Notes&scope=shared",mode:"push"});
});
