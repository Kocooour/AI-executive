import assert from "node:assert/strict";
import {test} from "node:test";
import {targetUiConfig,TARGET_UI_MY_PLAN_FLAGS,TARGET_UI_SCOPES_FLAGS} from "../lib/target-ui-config.ts";

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
  assert.deepEqual(targetUiConfig(base),{myPlan:{...off,enabled:true},scopes:{enabled:false}});
  assert.equal(TARGET_UI_MY_PLAN_FLAGS.length,5);
  for(const name of TARGET_UI_MY_PLAN_FLAGS){
    const env={...base,...statusWrite,...whenWrite};
    delete env[name];
    if(name.endsWith("HTTP_ENABLED")||name==="AI_EXECUTIVE_TARGET_UI_ENABLED"){
      assert.equal(targetUiConfig(env),null,name);continue;
    }
    // Missing my-plan flag: target UI still on, My Plan and its writes off.
    assert.deepEqual(targetUiConfig(env),{myPlan:off,scopes:{enabled:false}},name);
    for(const bad of ["1","TRUE","false",""])
      assert.deepEqual(targetUiConfig({...env,[name]:bad}),{myPlan:off,scopes:{enabled:false}},name+bad);
  }
});

test("write gates are independent of each other and never apply without My Plan",()=>{
  assert.deepEqual(targetUiConfig({...base,...statusWrite}),{myPlan:{enabled:true,statusWrite:true,whenWrite:false},scopes:{enabled:false}});
  assert.deepEqual(targetUiConfig({...base,...whenWrite}),{myPlan:{enabled:true,statusWrite:false,whenWrite:true},scopes:{enabled:false}});
  assert.deepEqual(targetUiConfig({...base,...statusWrite,...whenWrite}),{myPlan:{enabled:true,statusWrite:true,whenWrite:true},scopes:{enabled:false}});
  const noMyPlan={...base,...statusWrite,...whenWrite};
  delete noMyPlan.AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED;
  assert.deepEqual(targetUiConfig(noMyPlan),{myPlan:off,scopes:{enabled:false}});
  // A partial write gate leaves that write off while reads stay on.
  const partial={...base,...statusWrite};
  delete partial.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED;
  assert.deepEqual(targetUiConfig(partial),{myPlan:{...off,enabled:true},scopes:{enabled:false}});
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
  AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED:T,
};

test("R3-FE-3: scopes need all four flags exactly true, independent of My Plan",()=>{
  assert.deepEqual(targetUiConfig(scopesOnly),{myPlan:off,scopes:{enabled:true}});
  assert.deepEqual(targetUiConfig({...base,...scopesOnly}),
    {myPlan:{...off,enabled:true},scopes:{enabled:true}});
  assert.equal(TARGET_UI_SCOPES_FLAGS.length,4);
  for(const name of TARGET_UI_SCOPES_FLAGS){
    const env={...scopesOnly};
    delete env[name];
    const expected=name==="AI_EXECUTIVE_TARGET_UI_ENABLED"||name==="AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED"
      ?null:{myPlan:off,scopes:{enabled:false}};
    assert.deepEqual(targetUiConfig(env),expected,name);
    for(const bad of ["1","TRUE","yes","false",""])
      assert.deepEqual(targetUiConfig({...scopesOnly,[name]:bad}),
        expected,name+bad);
  }
});

test("R3-FE-3: the My Plan flags alone never enable scopes (and vice versa)",()=>{
  assert.equal(targetUiConfig(base).scopes.enabled,false);
  assert.equal(targetUiConfig(scopesOnly).myPlan.enabled,false);
});

test("R3-FE-3: provider mount rule is My Plan OR scopes, as app/page.tsx computes it",()=>{
  const mounts=env=>{const c=targetUiConfig(env);return c!==null&&(c.myPlan.enabled||c.scopes.enabled);};
  assert.equal(mounts({}),false);
  assert.equal(mounts({AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T}),false);
  assert.equal(mounts(base),true);
  assert.equal(mounts(scopesOnly),true);
  const noGlobal={...scopesOnly};delete noGlobal.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED;
  assert.equal(mounts(noGlobal),false);
});
