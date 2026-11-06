import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  changeMyPlanStatus,prepareMyPlanStatus,dispatchMyPlanStatus,
  checkMyPlanStatusReceipt,validStatusTaskId,validStatusCommand,
} from "../lib/target-staging-my-plan-status-client.ts";

const uuidA="123e4567-e89b-42d3-a456-426614174000";
const uuidB="123e4567-e89b-42d3-a456-426614174001";
const generation="765e4567-e89b-42d3-a456-426614174000";
const revision="a".repeat(64);
const taskId="  č pad  ";
const areaId="family-area";
const preview={expectedRevision:revision,writeAreaId:areaId,restoreGeneration:generation};
const command={commandId:uuidA,taskId,status:"completed",
  expectedRevision:revision,writeAreaId:areaId,restoreGeneration:generation};
const good=body=>Response.json(body,{headers:{"cache-control":"no-store"}});
const failures=status=>new Response(JSON.stringify({error:"failed"}),{
  status,headers:{"cache-control":"no-store","content-type":"application/json"},
});
const validRead={taskId,areaId,status:"completed",commandId:uuidA};

test("CAS preflight uses same-origin, no-store read and exact six fields",async()=>{
  let calls=0;
  const result=await prepareMyPlanStatus(validRead,async(url,options)=>{
    calls++;
    const u=new URL("https://example.test"+url);
    assert.equal(u.pathname,"/api/target-staging/task-temporal/status");
    assert.deepEqual([...u.searchParams.keys()],["taskId"]);
    assert.equal(u.searchParams.get("taskId"),taskId);
    assert.equal(options.method,"GET");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.cache,"no-store");
    assert.equal(options.redirect,"error");
    assert.deepEqual(options.headers,{accept:"application/json"});
    return good(preview);
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{ok:true,command});
  assert.equal(validStatusCommand(result.command),true);
});

test("wrong Area, malformed CAS and unauthorized snapshots never prepare writes",async()=>{
  for(const [name,body] of [
    ["extra actor info",{...preview,userId:"alice"}],
    ["foreign Area",{...preview,writeAreaId:"foreign-area"}],
    ["bad revision",{...preview,expectedRevision:"stale"}],
    ["bad restore generation",{...preview,restoreGeneration:"generation"}],
    ["missing key",{...preview,writeAreaId:undefined}],
  ]){
    const result=await prepareMyPlanStatus(validRead,async()=>good(body));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},name);
  }
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],
    [404,"unavailable"],[409,"stale"],[400,"invalid-request"],[503,"unavailable"]]){
    assert.deepEqual(await prepareMyPlanStatus(validRead,async()=>failures(status)),
      {ok:false,reason},String(status));
  }
  assert.deepEqual(await prepareMyPlanStatus(validRead,async()=>Response.json(preview)),
    {ok:false,reason:"invalid-response"});
  assert.deepEqual(await prepareMyPlanStatus(validRead,async()=>{throw Error("offline");}),
    {ok:false,reason:"offline"});
});

test("invalid client task IDs cannot reach preview, PATCH or receipt",async()=>{
  for(const id of ["","x\0y","\ud800","é".repeat(3000)]){
    assert.equal(validStatusTaskId(id),false);
    const attempt=await prepareMyPlanStatus({...validRead,taskId:id},
      async()=>{throw Error("must not fetch");});
    assert.deepEqual(attempt,{ok:false,reason:"invalid-request"});
  }
  for(const extra of [{...command,actor:"alice"}, {...command,commandId:"no-uuid"},
    {...command,status:"pending"}, {...command,restoreGeneration:"invalid"}])
    assert.equal(validStatusCommand(extra),false);
  assert.deepEqual(await dispatchMyPlanStatus({...command,actor:"alice"},
    async()=>{throw Error("must not fetch");}),
  {kind:"rejected",reason:"invalid-request"});
});

test("successful complete invokes a single PATCH, no optimistic success",async()=>{
  const requests=[];
  const result=await changeMyPlanStatus(validRead,async(url,options)=>{
    requests.push({url,options});
    if(options.method==="GET")return good(preview);
    assert.equal(options.method,"PATCH");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.cache,"no-store");
    assert.equal(options.redirect,"error");
    assert.equal(options.headers["x-lumi-target-protocol"],"1");
    assert.equal(options.headers["content-type"],"application/json");
    assert.deepEqual(JSON.parse(options.body),command);
    return good({ok:true});
  });
  assert.deepEqual(result,{kind:"committed",command});
  assert.deepEqual(requests.map(x=>x.options.method),["GET","PATCH"]);
});

test("network loss after PATCH confirms only original command via read-only receipt",async()=>{
  const calls=[];
  const result=await dispatchMyPlanStatus(command,async(url,options)=>{
    calls.push([options.method,url,options.body]);
    if(options.method==="PATCH")throw Error("network lost after commit");
    assert.equal(options.method,"POST");
    assert.equal(url,"/api/target-staging/task-temporal/status/receipt");
    assert.deepEqual(JSON.parse(options.body),command);
    assert.equal(options.headers["x-lumi-target-protocol"],"1");
    return good({status:"committed"});
  });
  assert.deepEqual(result,{kind:"committed",command});
  assert.equal(calls.filter(([method])=>method==="PATCH").length,1);
  assert.deepEqual(calls.map(x=>x[0]),["PATCH","POST"]);
});

test("503 or malformed success never triggers an automatic retry",async()=>{
  for(const patch of [failures(503),good({ok:true,other:"leak"})]){
    const methods=[];
    const result=await dispatchMyPlanStatus(command,async(_url,options)=>{
      methods.push(options.method);
      return options.method==="PATCH"?patch:good({status:"not_recorded"});
    });
    assert.deepEqual(result,{kind:"uncertain",command});
    assert.deepEqual(methods,["PATCH","POST"]);
  }
  assert.deepEqual(await checkMyPlanStatusReceipt(command,
    async()=>good({status:"not_recorded"})),{kind:"not-recorded"});
  assert.deepEqual(await checkMyPlanStatusReceipt(command,
    async()=>good({status:"committed"})),{kind:"committed"});
  assert.deepEqual(await checkMyPlanStatusReceipt(command,
    async()=>good({status:"other"})),{kind:"unknown",reason:"invalid-response"});
});

test("409 CAS and malformed request are definitive refusals without retry",async()=>{
  for(const [status,reason] of [[409,"stale"],[400,"invalid-request"]]){
    let calls=0;
    const result=await dispatchMyPlanStatus(command,async()=>{calls++;return failures(status);});
    assert.deepEqual(result,{kind:"rejected",reason},String(status));
    assert.equal(calls,1);
  }
});

test("revocation after commit is uncertain until an authorized receipt confirms",async()=>{
  for(const status of [401,403,404]){
    const methods=[];
    const result=await dispatchMyPlanStatus(command,async(_url,opts)=>{
      methods.push(opts.method);
      return failures(status);
    });
    assert.deepEqual(result,{kind:"uncertain",command},String(status));
    assert.deepEqual(methods,["PATCH","POST"]);
  }
  const lost=await dispatchMyPlanStatus(command,async(_url,opts)=>{
    if(opts.method==="PATCH")throw Error("lost");
    return failures(401);
  });
  assert.deepEqual(lost,{kind:"uncertain",command});
  const confirmed=await dispatchMyPlanStatus(command,async(_url,opts)=>{
    if(opts.method==="PATCH")return failures(401);
    return good({status:"committed"});
  });
  assert.deepEqual(confirmed,{kind:"committed",command});
});

test("aborted PATCH is uncertain, aborted preview never writes",async()=>{
  const before=new AbortController();before.abort();
  assert.deepEqual(await prepareMyPlanStatus({...validRead,signal:before.signal},
    async()=>{throw Error("aborted");}),{ok:false,reason:"aborted"});
  let calls=0;
  const after=new AbortController();
  const attempt=await dispatchMyPlanStatus(command,async(_url,opts)=>{
    calls++;
    assert.equal(opts.signal,after.signal);
    after.abort();
    return good({ok:true});
  },after.signal);
  assert.deepEqual(attempt,{kind:"uncertain",command});
  assert.equal(calls,1,"aborted transport must not query receipt until explicit user action");
});

test("Undo uses a fresh preview and new idempotency key instead of PATCH replay",async()=>{
  const first=await prepareMyPlanStatus(validRead,async()=>good(preview));
  const undo=await prepareMyPlanStatus({
    ...validRead,status:"open",commandId:uuidB,
  },async()=>good({...preview,expectedRevision:"b".repeat(64)}));
  assert.equal(first.ok,true);assert.equal(undo.ok,true);
  assert.equal(undo.command.status,"open");
  assert.notEqual(undo.command.commandId,first.command.commandId);
  assert.notEqual(undo.command.expectedRevision,first.command.expectedRevision);
});

test("transport has no persistent cache and is only used by server-gated staging UI",()=>{
  const root=path.join(import.meta.dirname,"..");
  const code=readFileSync(path.join(root,
    "lib/target-staging-my-plan-status-client.ts"),"utf8");
  const preview=readFileSync(path.join(root,
    "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  assert.doesNotMatch(code,/indexedDB|localStorage|sessionStorage|serviceWorker/);
  assert.doesNotMatch(code,/\bwindow\.location\b|\bfetch\("https?:/);
  const page=readFileSync(path.join(root,
    "app/target-staging/my-plan/preview/page.tsx"),"utf8");
  const productionPage=readFileSync(path.join(root,"app/page.tsx"),"utf8");
  assert.match(preview,/statusWriteEnabled=false/);
  assert.match(preview,/dispatchMyPlanStatus/);
  assert.match(page,/myPlanStagingWriteUiEnabled\(process\.env\)/);
  assert.doesNotMatch(productionPage,/target-staging-my-plan-status-client/);
  assert.match(code,/method:"GET",credentials:"same-origin",cache:"no-store"/);
  assert.match(code,/No retries/);
});
