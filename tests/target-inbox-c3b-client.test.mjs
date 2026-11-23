import assert from "node:assert/strict";
import test from "node:test";
import {fetchC3bProposal} from "../lib/target-inbox-c3b-client.ts";
import {targetAppFetch} from "../lib/target-app-fetch.ts";

test("C-3b local rules queue leaves detail GET ahead of the next preview",async()=>{
  const originalFetch=globalThis.fetch;
  const order=[];
  let unblockFirst=()=>{},signalFirst=()=>{};
  const held=new Promise(resolve=>{unblockFirst=resolve;});
  const started=new Promise(resolve=>{signalFirst=resolve;});
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes("/api/target-staging/inbox/c3b?")){
      const taskId=new URL(url,"http://localhost").searchParams.get("taskId");
      order.push("rules:"+taskId);
      if(taskId==="task-a"){signalFirst();await held;}
      return Response.json({taskId,source:"rule",why:"Deterministic rule",
        actionTargetName:null,restoreGeneration:"123e4567-e89b-42d3-a456-426614174000",
        token:"c3b1."+"A".repeat(48),
        changes:{whenOn:"unchanged",projectId:"unchanged",
          taskAreaId:"unchanged",effectiveAreaId:"unchanged"}});
    }
    order.push("detail");
    return Response.json({ok:true});
  };
  try{
    const first=fetchC3bProposal("task-a",undefined,"rules");
    const second=fetchC3bProposal("task-b",undefined,"rules");
    await started;
    // The detail request enters the existing shared read queue while the
    // first preview is held. A second rule preview must NOT queue ahead of it.
    const detail=targetAppFetch("/api/target-staging/details/task-a");
    unblockFirst();
    const [one,two,response]=await Promise.all([first,second,detail]);
    assert.equal(one.ok,true);
    assert.equal(two.ok,true);
    assert.equal(response.ok,true);
    assert.deepEqual(order,["rules:task-a","detail","rules:task-b"]);
  }finally{
    unblockFirst();
    globalThis.fetch=originalFetch;
  }
});
