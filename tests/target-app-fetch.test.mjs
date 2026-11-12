import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {targetAppFetch} from "../lib/target-app-fetch.ts";
import {isTargetReadRequest} from "../lib/target-edit-fetch.ts";
import {targetReadQueueState} from "../lib/target-read-queue.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";
import {prepareMyPlanStatus} from "../lib/target-staging-my-plan-status-client.ts";
import {prepareMyPlanWhen} from "../lib/target-staging-my-plan-when-client.ts";
import {loadPrivateNoteAreaChoices} from "../lib/target-private-note-area-client.ts";
import {privateNoteCreatePreflight} from "../lib/target-private-note-create-client.ts";
import {sendPrivateTaskCreate,checkPrivateTaskCreateRecovery,checkPrivateTaskCreateReceipt}
  from "../lib/target-private-task-create-client.ts";

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const root=path.join(import.meta.dirname,"..");
const uuid="123e4567-e89b-42d3-a456-426614174000";

/** Replaces the browser global (resolved lazily by targetAppFetch) with a slow server that records
 * how many requests ran at once, like the 2-child limit of the staging server. */
function slowServer(){
  const original=globalThis.fetch;
  const state={running:0,peak:0,urls:[],releases:[]};
  globalThis.fetch=async(input,init)=>{
    state.urls.push((init?.method??"GET")+" "+String(input).replace(/\?.*/,""));
    state.running++;state.peak=Math.max(state.peak,state.running);
    await new Promise(resolve=>state.releases.push(resolve));
    state.running--;
    return new Response("{}",{status:503});
  };
  state.restore=()=>{globalThis.fetch=original;};
  state.drain=async()=>{for(let i=0;i<30;i++){state.releases.shift()?.();await tick();}};
  return state;
}

test("routing: create-preview/create-recovery/status/receipt are reads, writes are not",()=>{
  const post=url=>isTargetReadRequest(url,{method:"POST"});
  assert.equal(isTargetReadRequest("/api/target-staging/my-plan/slice?x=1"),true);
  for(const p of ["notes/create-preview","tasks/create-recovery","notes/create-recovery",
    "tasks/create-status","task-temporal/status/receipt"])
    assert.equal(post("/api/target-staging/"+p),true,p);
  for(const p of ["tasks","notes","tasks/create-cancel"])
    assert.equal(post("/api/target-staging/"+p),false,p);
  assert.equal(isTargetReadRequest("/api/target-staging/task-temporal/status",{method:"PATCH"}),false);
});

test("My Plan, Area catalog and create-preview reads with the DEFAULT fetch share one queue slot",async()=>{
  const server=slowServer();
  try{
    const signal=new AbortController().signal;
    const reads=[
      fetchMyPlanSlice({evaluationDate:"2026-11-12",areaFilter:"personal",signal}),
      loadPrivateNoteAreaChoices(signal),
      privateNoteCreatePreflight("area:x",signal),
      prepareMyPlanStatus({taskId:"t1",areaId:"a1",status:"completed",signal}),
      prepareMyPlanWhen({taskId:"t1",areaId:"a1",whenOn:"2026-11-13",signal}),
      checkPrivateTaskCreateRecovery(uuid,signal),
    ];
    await tick();
    assert.equal(server.urls.length,1,"only the first read reached the network: "+server.urls);
    assert.deepEqual(targetReadQueueState(),{active:1,waiting:5});
    await server.drain();
    await Promise.all(reads);
    assert.equal(server.peak,1);
    assert.equal(server.urls.length,6);
  }finally{server.restore();}
});

test("POST-shaped reads overlap neither each other nor a GET read: one slot, counted by the shared predicate",async()=>{
  const server=slowServer();
  try{
    const signal=new AbortController().signal;
    const command={taskId:uuid,commandId:uuid,areaId:"a",restoreGeneration:uuid,title:"x"};
    const reads=[
      privateNoteCreatePreflight("area:x",signal),            // POST notes/create-preview
      checkPrivateTaskCreateReceipt(command,signal),          // POST tasks/create-status
      checkPrivateTaskCreateRecovery(uuid,signal),            // POST tasks/create-recovery
      fetchMyPlanSlice({evaluationDate:"2026-11-12",areaFilter:"personal",signal}), // GET
    ];
    await tick();
    assert.deepEqual(targetReadQueueState(),{active:1,waiting:3});
    await server.drain();
    await Promise.all(reads);
    assert.equal(server.peak,1,"three POST reads and one GET never ran together");
    assert.equal(server.urls.length,4);
    // The browser acceptance counts reads with this same predicate; every request above must be counted.
    for(const entry of server.urls){
      const [method,url]=entry.split(" ");
      assert.equal(isTargetReadRequest(url,{method}),true,entry);
    }
    assert.equal(server.urls.filter(entry=>entry.startsWith("POST ")).length,3);
  }finally{server.restore();}
});

test("a write never occupies or waits for the read slot",async()=>{
  const server=slowServer();
  try{
    const signal=new AbortController().signal;
    const read=fetchMyPlanSlice({evaluationDate:"2026-11-12",areaFilter:"personal",signal});
    await tick();
    const write=sendPrivateTaskCreate({taskId:uuid,commandId:uuid,areaId:"a",
      restoreGeneration:uuid,title:"x"},signal);
    await tick();
    assert.equal(server.urls.length,2,"the POST ran while the read held the slot");
    assert.match(server.urls[1],/^POST \/api\/target-staging\/tasks$/);
    await server.drain();await Promise.all([read,write]);
  }finally{server.restore();}
});

test("the default fetch of the main-app target clients is the shared routed fetch",()=>{
  for(const file of ["lib/target-staging-my-plan-client.ts","lib/target-staging-my-plan-status-client.ts",
    "lib/target-staging-my-plan-when-client.ts","lib/target-private-note-area-client.ts",
    "lib/target-private-note-create-client.ts","lib/target-private-task-create-client.ts"]){
    const source=readFileSync(path.join(root,file),"utf8");
    assert.doesNotMatch(source,/fetchImpl:typeof fetch=fetch\b/,file);
    assert.match(source,/fetchImpl:typeof fetch=targetAppFetch/,file);
  }
  const plan=readFileSync(path.join(root,"app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  assert.doesNotMatch(plan,/[(,]fetch[,)]/,"My Plan passes the shared routed fetch explicitly");
  assert.equal(typeof targetAppFetch,"function");
});
