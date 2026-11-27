import assert from "node:assert/strict";
import {test} from "node:test";
import {prepareTaskDueOn,dispatchTaskDueOn,checkTaskDueOnReceipt} from "../lib/target-staging-task-due-on-client.ts";
import {executeWrite} from "../lib/target-detail-write.ts";
const url="/api/target-staging/task-temporal/due-on";
const taskId="task-1",areaId="area-1";
const preview={expectedRevision:"a".repeat(64),dueOn:"2026-11-28",writeAreaId:areaId,restoreGeneration:"b1e6d193-0ea5-4db4-b0c6-31971c3709ed"};
const json=(data,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
test("deadline set/change/remove use exactly six CAS fields and refuse unchanged or moved Area",async()=>{
  for(const dueOn of [null,"2026-12-02"]){
    const prepared=await prepareTaskDueOn({taskId,areaId,dueOn},async(input,init)=>{
      assert.equal(input,url+"?taskId="+taskId);assert.equal(init.method,"GET");
      return json(preview);
    });
    assert.equal(prepared.ok,true);
    assert.deepEqual(Object.keys(prepared.command).sort(),["commandId","dueOn","expectedRevision","restoreGeneration","taskId","writeAreaId"]);
    assert.equal(prepared.command.dueOn,dueOn);
    assert.equal(prepared.previousDueOn,preview.dueOn);
    const dispatch=await dispatchTaskDueOn(prepared.command,async(input,init)=>{
      assert.equal(input,url);assert.equal(init.method,"PATCH");
      assert.deepEqual(JSON.parse(init.body),prepared.command);
      return json({ok:true});
    });
    assert.equal(dispatch.kind,"committed");
  }
  assert.deepEqual(await prepareTaskDueOn({taskId,areaId,dueOn:preview.dueOn},async()=>json(preview)),{ok:false,reason:"unchanged"});
  assert.equal((await prepareTaskDueOn({taskId,areaId,dueOn:null},async()=>json({...preview,writeAreaId:"other"}))).ok,false);
  assert.equal((await prepareTaskDueOn({taskId,areaId,dueOn:"2026-02-30"},async()=>{throw Error("must not fetch");})).reason,"invalid-request");
});
test("uncertain deadline never retries the PATCH, receipt uses original command",async()=>{
  const {command}=await prepareTaskDueOn({taskId,areaId,dueOn:null},async()=>json(preview));
  const calls=[];
  const fetch=async(input,init)=>{
    calls.push([input,init.method,JSON.parse(init.body)]);
    if(init.method==="PATCH")throw Error("lost response");
    return json({status:"not_recorded"});
  };
  assert.equal((await dispatchTaskDueOn(command,fetch)).kind,"uncertain");
  assert.deepEqual(calls,[[url,"PATCH",command],[url+"/receipt","POST",command]]);
  assert.equal((await checkTaskDueOnReceipt(command,async()=>json({status:"committed"}))).kind,"committed");
});
test("deadline controller does not overwrite an intervening date or write without server preflight",async()=>{
  const input={kind:"taskDueOn",taskId,areaId,dueOn:null,baseDueOn:"2026-11-27"};
  for(const [response,expected] of [[json(preview),"conflict"],[json({error:"Not found"},404),"error"]]){
    let calls=0;
    const outcome=await executeWrite(input,{fetch:async()=>{calls++;return response;},
      signal:new AbortController().signal,hooks:{onDispatch:()=>assert.fail("no dispatch")}});
    assert.equal(outcome.t,expected);assert.equal(calls,1);
  }
});
