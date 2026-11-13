import assert from "node:assert/strict";
import {test} from "node:test";
import {targetDataNeeded,targetUiConfig,TARGET_UI_DETAILS_FLAGS,TARGET_UI_MY_PLAN_FLAGS,TARGET_UI_SCOPES_FLAGS} from "../lib/target-ui-config.ts";

const T="true";
const base={
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T,
  AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED:T,
};
const statusWrite={
  AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_STATUS_UI_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED:T,
};
const whenWrite={
  AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_WHEN_UI_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED:T,
};
const off={enabled:false,statusWrite:false,whenWrite:false};
const off3={enabled:false,projects:false,notes:false};
const det0={task:false,project:false,note:false};
const ed0={taskTitle:false,taskStatus:false,taskWhen:false,taskDelete:false,noteEdit:false,noteDelete:false};
const cr0={projects:false,projectTasks:false};

test("default env: target UI off, no config at all",()=>{
  assert.equal(targetUiConfig({}),null);
});

test("either R3-FE-1 flag missing or not exactly true: null (identical legacy tree)",()=>{
  for(const name of ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED","AI_EXECUTIVE_TARGET_UI_ENABLED"]){
    assert.equal(targetUiConfig({...base,[name]:undefined}),null,name);
    for(const bad of ["1","TRUE","yes","false",""])
      assert.equal(targetUiConfig({...base,[name]:bad}),null,name+bad);
  }
});

test("My Plan is enabled only when ALL five flags are exactly true",()=>{
  assert.deepEqual(targetUiConfig(base),{myPlan:{...off,enabled:true},scopes:off3,details:det0,edits:ed0,creates:cr0});
  assert.equal(TARGET_UI_MY_PLAN_FLAGS.length,5);
  for(const name of TARGET_UI_MY_PLAN_FLAGS){
    const env={...base,...statusWrite,...whenWrite};
    delete env[name];
    if(name.endsWith("HTTP_ENABLED")||name==="AI_EXECUTIVE_TARGET_UI_ENABLED"){
      assert.equal(targetUiConfig(env),null,name);continue;
    }
    // Missing my-plan flag: target UI still on, My Plan and its writes off.
    assert.deepEqual(targetUiConfig(env),{myPlan:off,scopes:off3,details:det0,edits:ed0,creates:cr0},name);
    for(const bad of ["1","TRUE","false",""])
      assert.deepEqual(targetUiConfig({...env,[name]:bad}),{myPlan:off,scopes:off3,details:det0,edits:ed0,creates:cr0},name+bad);
  }
});

test("write gates are independent of each other and never apply without My Plan",()=>{
  assert.deepEqual(targetUiConfig({...base,...statusWrite}),{myPlan:{enabled:true,statusWrite:true,whenWrite:false},scopes:off3,details:det0,edits:ed0,creates:cr0});
  assert.deepEqual(targetUiConfig({...base,...whenWrite}),{myPlan:{enabled:true,statusWrite:false,whenWrite:true},scopes:off3,details:det0,edits:ed0,creates:cr0});
  assert.deepEqual(targetUiConfig({...base,...statusWrite,...whenWrite}),{myPlan:{enabled:true,statusWrite:true,whenWrite:true},scopes:off3,details:det0,edits:ed0,creates:cr0});
  const noMyPlan={...base,...statusWrite,...whenWrite};
  delete noMyPlan.AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED;
  assert.deepEqual(targetUiConfig(noMyPlan),{myPlan:off,scopes:off3,details:det0,edits:ed0,creates:cr0});
  // A partial write gate leaves that write off while reads stay on.
  const partial={...base,...statusWrite};
  delete partial.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED;
  assert.deepEqual(targetUiConfig(partial),{myPlan:{...off,enabled:true},scopes:off3,details:det0,edits:ed0,creates:cr0});
});

test("the config is plain serializable booleans only",()=>{
  const config=targetUiConfig({...base,...statusWrite,...whenWrite});
  assert.deepEqual(JSON.parse(JSON.stringify(config)),config);
  for(const value of [...Object.values(config.myPlan),...Object.values(config.scopes)])
    assert.equal(typeof value,"boolean");
});

const scopesOnly={
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T,
  AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED:T,
};
const projectsFlag={AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED:T};
const notesFlag={AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED:T};

test("R3-FE-3: switcher needs all three flags exactly true, independent of My Plan",()=>{
  assert.deepEqual(targetUiConfig(scopesOnly),{myPlan:off,scopes:{enabled:true,projects:false,notes:false},details:det0,edits:ed0,creates:cr0});
  assert.deepEqual(targetUiConfig({...base,...scopesOnly}),
    {myPlan:{...off,enabled:true},scopes:{enabled:true,projects:false,notes:false},details:det0,edits:ed0,creates:cr0});
  assert.equal(TARGET_UI_SCOPES_FLAGS.length,3);
  for(const name of TARGET_UI_SCOPES_FLAGS){
    const env={...scopesOnly,...projectsFlag,...notesFlag};
    delete env[name];
    const expected=name==="AI_EXECUTIVE_TARGET_UI_ENABLED"||name==="AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED"
      ?null:{myPlan:off,scopes:off3,details:det0,edits:ed0,creates:cr0};
    assert.deepEqual(targetUiConfig(env),expected,name);
    for(const bad of ["1","TRUE","yes","false",""])
      assert.deepEqual(targetUiConfig({...env,[name]:bad}),expected,name+bad);
  }
});

test("R3-FE-3: Projects and Notes are enabled per view by their own dedicated-index flag",()=>{
  assert.deepEqual(targetUiConfig({...scopesOnly,...projectsFlag}).scopes,{enabled:true,projects:true,notes:false});
  assert.deepEqual(targetUiConfig({...scopesOnly,...notesFlag}).scopes,{enabled:true,projects:false,notes:true});
  assert.deepEqual(targetUiConfig({...scopesOnly,...projectsFlag,...notesFlag}).scopes,{enabled:true,projects:true,notes:true});
  // A list flag alone, without the switcher flag, enables nothing.
  const noSwitcher={...scopesOnly,...projectsFlag,...notesFlag};
  delete noSwitcher.AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED;
  assert.deepEqual(targetUiConfig(noSwitcher).scopes,off3);
  for(const bad of ["1","TRUE","false",""])
    assert.equal(targetUiConfig({...scopesOnly,AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED:bad}).scopes.projects,false,bad);
  // The combined index flag is no longer used by the lists.
  assert.deepEqual(targetUiConfig({...scopesOnly,AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED:T}).scopes,
    {enabled:true,projects:false,notes:false});
});

test("R3-FE-3: the My Plan flags alone never enable scopes (and vice versa)",()=>{
  assert.equal(targetUiConfig(base).scopes.enabled,false);
  assert.equal(targetUiConfig(scopesOnly).myPlan.enabled,false);
});

test("R3-FE-3: provider mount rule is My Plan OR a scoped list view (R3-FE-4a: or a detail), as app/page.tsx computes it",()=>{
  const mounts=env=>targetDataNeeded(targetUiConfig(env));
  assert.equal(mounts({}),false);
  assert.equal(mounts({AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T}),false);
  assert.equal(mounts(base),true);
  // The switcher flag alone has no consumer: no provider, no session request.
  assert.equal(mounts(scopesOnly),false);
  assert.equal(mounts({...scopesOnly,...projectsFlag}),true);
  assert.equal(mounts({...scopesOnly,...notesFlag}),true);
  assert.equal(mounts({...projectsFlag,...notesFlag}),false);
});

// ---- R3-FE-4a: authorized details in the main app --------------------------
const detailsFlag={AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED:T};
const taskFlag={AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:T};
const noteDetailFlag={AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:T};
const baseUi={AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T};

test("R3-FE-4a: details are off by default and without the new UI flag",()=>{
  assert.deepEqual(targetUiConfig(baseUi).details,det0);
  assert.deepEqual(targetUiConfig({...baseUi,...taskFlag,...noteDetailFlag}).details,det0);
  assert.equal(targetUiConfig({...detailsFlag,...taskFlag,...noteDetailFlag}),null);
});

test("R3-FE-4a: each kind needs the UI flag AND the flags its own route requires",()=>{
  assert.deepEqual(TARGET_UI_DETAILS_FLAGS.slice(-1),["AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED"]);
  const on={...baseUi,...detailsFlag};
  assert.deepEqual(targetUiConfig(on).details,{task:false,project:true,note:false});
  assert.deepEqual(targetUiConfig({...on,...taskFlag}).details,{task:true,project:true,note:false});
  assert.deepEqual(targetUiConfig({...on,...noteDetailFlag}).details,{task:false,project:true,note:true});
  assert.deepEqual(targetUiConfig({...on,...taskFlag,...noteDetailFlag}).details,{task:true,project:true,note:true});
  for(const bad of ["1","TRUE","yes","false",""]){
    assert.deepEqual(targetUiConfig({...baseUi,AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED:bad,...taskFlag,...noteDetailFlag}).details,det0,bad);
    assert.equal(targetUiConfig({...on,AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:bad}).details.task,false,bad);
    assert.equal(targetUiConfig({...on,AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:bad}).details.note,false,bad);
  }
});

test("R3-FE-4a: details are independent of My Plan and scopes and the config stays plain booleans",()=>{
  const all={...baseUi,...detailsFlag,...taskFlag,...noteDetailFlag};
  const config=targetUiConfig(all);
  assert.equal(config.myPlan.enabled,false);
  assert.equal(config.scopes.enabled,false);
  assert.deepEqual(JSON.parse(JSON.stringify(config)),config);
  for(const value of Object.values(config.details))assert.equal(typeof value,"boolean");
});

test("R3-FE-4a: details are no provider consumer of their own (they stay inert without a list or plan)",()=>{
  const mounts=env=>targetDataNeeded(targetUiConfig(env));
  assert.equal(mounts({...baseUi,...detailsFlag}),false);
  assert.equal(mounts({...baseUi,...detailsFlag,...taskFlag,...noteDetailFlag}),false);
  assert.equal(mounts({...scopesOnly,...detailsFlag}),false);
  assert.equal(mounts({...scopesOnly,...projectsFlag,...detailsFlag}),true);
  assert.equal(mounts({...base,...detailsFlag}),true);
  assert.equal(mounts(scopesOnly),false);
  assert.equal(targetDataNeeded(null),false);
});
