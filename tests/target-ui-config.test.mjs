import assert from "node:assert/strict";
import {test} from "node:test";
import {targetUiConfig,TARGET_UI_MY_PLAN_FLAGS} from "../lib/target-ui-config.ts";

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
  assert.deepEqual(targetUiConfig(base),{myPlan:{...off,enabled:true}});
  assert.equal(TARGET_UI_MY_PLAN_FLAGS.length,5);
  for(const name of TARGET_UI_MY_PLAN_FLAGS){
    const env={...base,...statusWrite,...whenWrite};
    delete env[name];
    if(name.endsWith("HTTP_ENABLED")||name==="AI_EXECUTIVE_TARGET_UI_ENABLED"){
      assert.equal(targetUiConfig(env),null,name);continue;
    }
    // Missing my-plan flag: target UI still on, My Plan and its writes off.
    assert.deepEqual(targetUiConfig(env),{myPlan:off},name);
    for(const bad of ["1","TRUE","false",""])
      assert.deepEqual(targetUiConfig({...env,[name]:bad}),{myPlan:off},name+bad);
  }
});

test("write gates are independent of each other and never apply without My Plan",()=>{
  assert.deepEqual(targetUiConfig({...base,...statusWrite}),
    {myPlan:{enabled:true,statusWrite:true,whenWrite:false}});
  assert.deepEqual(targetUiConfig({...base,...whenWrite}),
    {myPlan:{enabled:true,statusWrite:false,whenWrite:true}});
  assert.deepEqual(targetUiConfig({...base,...statusWrite,...whenWrite}),
    {myPlan:{enabled:true,statusWrite:true,whenWrite:true}});
  const noMyPlan={...base,...statusWrite,...whenWrite};
  delete noMyPlan.AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED;
  assert.deepEqual(targetUiConfig(noMyPlan),{myPlan:off});
  // A partial write gate leaves that write off while reads stay on.
  const partial={...base,...statusWrite};
  delete partial.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED;
  assert.deepEqual(targetUiConfig(partial),{myPlan:{...off,enabled:true}});
});

test("the config is plain serializable booleans only",()=>{
  const config=targetUiConfig({...base,...statusWrite,...whenWrite});
  assert.deepEqual(JSON.parse(JSON.stringify(config)),config);
  for(const value of Object.values(config.myPlan))assert.equal(typeof value,"boolean");
});
