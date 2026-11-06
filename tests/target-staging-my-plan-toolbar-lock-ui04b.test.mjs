import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {myPlanToolbarChangeBlocked} from "../lib/target-staging-my-plan-toolbar-lock.ts";
import {
  dispatchMyPlanWhen,checkMyPlanWhenReceipt,
} from "../lib/target-staging-my-plan-when-client.ts";

const root=path.join(import.meta.dirname,"..");
const ui=()=>readFileSync(path.join(root,
  "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
const original={
  commandId:"123e4567-e89b-42d3-a456-426614174000",
  taskId:"task-1",whenOn:"2026-11-07",
  expectedRevision:"a".repeat(64),expectedPrivateEpoch:3,
  expectedPlanRevision:null,writeAreaId:"private-area",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};

test("P1 toolbar lock observes synchronous when/status refs even before React re-render",()=>{
  const safe={anyPending:false,statusInFlight:false,whenInFlight:false};
  assert.equal(myPlanToolbarChangeBlocked(safe),false);
  for(const patch of [
    {whenInFlight:true},
    {statusInFlight:true},
    {anyPending:true},
    {whenInFlight:true,statusInFlight:true},
  ]){
    assert.equal(myPlanToolbarChangeBlocked({...safe,...patch}),true,
      JSON.stringify(patch));
  }
  // The stale render still says "not pending", but the mutable operation ref
  // has already been set by the initiating click.
  const queuedReactRender={anyPending:false};
  const whenOperation={current:{command:original}};
  assert.equal(myPlanToolbarChangeBlocked({
    ...queuedReactRender,statusInFlight:false,
    whenInFlight:whenOperation.current!==null,
  }),true);
});

test("P1 date, Area filter and Aktuální den each check the SAME live ref guard before resetFeedback",()=>{
  const code=ui();
  const definition=code.slice(
    code.indexOf("const toolbarChangeBlocked=()=>"),
    code.indexOf("const canComplete=",code.indexOf("const toolbarChangeBlocked=()=>")),
  );
  assert.match(definition,/myPlanToolbarChangeBlocked\(\{/);
  assert.match(definition,/anyPending,statusInFlight:statusOperation\.current!==null/);
  assert.match(definition,/whenInFlight:whenOperation\.current!==null/);

  const sections=[
    ["date",'<input type="date"',"</label>"],
    ["Area",'<select value={areaFilter}',"</select>"],
    ["today",'<button type="button" disabled={anyPending} onClick={()=>{',
      "}}>Aktuální den</button>"],
  ];
  for(const [name,first,last] of sections){
    const start=code.indexOf(first);
    assert.ok(start>=0,name+" start");
    const end=code.indexOf(last,start);
    assert.ok(end>start,name+" end");
    const handler=code.slice(start,end);
    const guard=handler.indexOf("if(toolbarChangeBlocked())return;");
    const reset=handler.indexOf("resetFeedback();");
    assert.ok(guard>=0&&reset>guard,
      name+" must check live pending/ref guard before clearing command");
    assert.doesNotMatch(handler,/if\(actionPending\|\|statusOperation\.current\)return/);
  }
  assert.match(code,/whenOperation\.current=op; \/\/ Synchronous cross-family submission lock/);
});

test("P1 rapid Area/Today events cannot erase a possibly committed personal command",async()=>{
  const ref={current:original};
  const whenOperation={current:{command:original}};
  const statusOperation={current:null};
  // A queued React update has not committed yet; both toolbar controls still
  // receive callbacks from the previous render where anyPending was false.
  let renderedAnyPending=false,resetCalls=0;
  const maybeChangeContext=()=> {
    if(myPlanToolbarChangeBlocked({
      anyPending:renderedAnyPending,
      statusInFlight:statusOperation.current!==null,
      whenInFlight:whenOperation.current!==null,
    }))return false;
    resetCalls++;
    ref.current=null; // resetFeedback() would discard exact original CAS.
    return true;
  };
  const methods=[];
  let releasePatch;
  const patchWait=new Promise(resolve=>{releasePatch=resolve;});
  const dispatch=dispatchMyPlanWhen(original,async(url,options)=>{
    methods.push(options.method);
    if(options.method==="PATCH"){
      // Response lost after a possible durable write, while toolbar events race.
      await patchWait;
      throw Error("connection lost after possible commit");
    }
    assert.equal(options.method,"POST");
    assert.deepEqual(JSON.parse(options.body),original);
    return Response.json({error:"staging unavailable"},{
      status:503,headers:{"cache-control":"no-store"},
    });
  });
  assert.equal(maybeChangeContext(),false,"Area selection must not reset");
  assert.equal(maybeChangeContext(),false,"Aktuální den must not reset");
  assert.equal(resetCalls,0);
  assert.equal(ref.current,original);

  releasePatch();
  const result=await dispatch;
  assert.deepEqual(result,{kind:"uncertain",command:original});
  assert.deepEqual(methods,["PATCH","POST"],"must not retry PATCH");

  whenOperation.current=null;
  renderedAnyPending=true; // React eventually commits the uncertain state.
  assert.equal(maybeChangeContext(),false);
  assert.equal(ref.current,original);
  const receipt=await checkMyPlanWhenReceipt(ref.current,async(url,options)=>{
    methods.push(options.method);
    assert.equal(options.method,"POST");
    assert.deepEqual(JSON.parse(options.body),original);
    return Response.json({status:"committed"},{
      headers:{"cache-control":"no-store"},
    });
  });
  assert.deepEqual(receipt,{kind:"committed"});
  assert.deepEqual(methods,["PATCH","POST","POST"]);
  assert.equal(resetCalls,0);
});
