import assert from "node:assert/strict";
import {test} from "node:test";
import {
  signMyPlanSliceCursor,verifyMyPlanSliceCursor,validMyPlanSlicePositions,
} from "../lib/target-staging-my-plan-slice-cursor.ts";

const context={
  actorUserId:"bob",authenticationBinding:"b".repeat(43),
  stagingDirectory:"/synthetic/isolated",restoreGeneration:"generation-a",
  sessionSecret:"synthetic-test-session-secret-at-least-32-chars",
  areaFilter:"all",evaluationDate:"2026-11-04",limit:2,
};
const revision="a".repeat(64);
const positions={today:2,tomorrow:1,undated:1};

test("R3 My Plan two-day cursor authenticates both positions, actor and date",()=>{
  const token=signMyPlanSliceCursor(context,revision,positions,undefined,100);
  assert.ok(token);
  assert.deepEqual(verifyMyPlanSliceCursor(context,token,101),{
    ok:true,positions,revision,expiresAt:100+900,
  });
  for(const drift of [
    {actorUserId:"alice"},{authenticationBinding:"c".repeat(43)},
    {stagingDirectory:"/other"},{restoreGeneration:"generation-b"},
    {sessionSecret:"different-long-test-session-secret-at-least-32"},
    {areaFilter:"shared"},{evaluationDate:"2026-11-05"},{limit:3},
  ]){
    assert.deepEqual(verifyMyPlanSliceCursor({...context,...drift},token,101),
      {ok:false,reason:"invalid"});
  }
  assert.deepEqual(verifyMyPlanSliceCursor(context,token.slice(0,-1)+(token.endsWith("A")?"B":"A"),101),
    {ok:false,reason:"invalid"});
  assert.deepEqual(verifyMyPlanSliceCursor(context,token,1000),
    {ok:false,reason:"expired"});
  const retained=signMyPlanSliceCursor(context,revision,positions,1000,101);
  assert.ok(retained);
  assert.equal(verifyMyPlanSliceCursor(context,retained,102).ok,true);
});

test("refuse malformed, empty, oversized or improperly encoded cursors",()=>{
  for(const value of [
    null,[],{today:1},{tomorrow:1},{today:-1,tomorrow:0,undated:0},
    {today:1.25,tomorrow:0,undated:0},{today:1,tomorrow:1_000_001,undated:0},
    {today:1,tomorrow:0,undated:0,actor:"bob"},
  ])assert.equal(validMyPlanSlicePositions(value),false);
  assert.equal(validMyPlanSlicePositions({today:0,tomorrow:0,undated:0}),true);
  assert.equal(signMyPlanSliceCursor(context,revision,{today:0,tomorrow:0,undated:0},undefined,100),null);
  assert.equal(signMyPlanSliceCursor(context,revision,{today:1,tomorrow:0,undated:0},100,100),null);
  assert.equal(signMyPlanSliceCursor(context,revision,{today:1,tomorrow:0,undated:0},1002,100),null);
  for(const cursor of ["", "abc", "abc.def.extra", "a".repeat(5000)])
    assert.deepEqual(verifyMyPlanSliceCursor(context,cursor,101),{ok:false,reason:"invalid"});
});
