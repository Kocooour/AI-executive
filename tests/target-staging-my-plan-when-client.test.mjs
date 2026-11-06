import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  validMyPlanWhenDate,myPlanWhenTarget,validMyPlanWhenCommand,
  prepareMyPlanWhen,checkMyPlanWhenReceipt,
  dispatchMyPlanWhen,changeMyPlanWhen,
} from "../lib/target-staging-my-plan-when-client.ts";

const id="123e4567-e89b-42d3-a456-426614174000";
const newId="123e4567-e89b-42d3-a456-426614174001";
const restore="765e4567-e89b-42d3-a456-426614174000";
const taskId="  č plán  ";
const areaId="family-area";
const revision="a".repeat(64);
const preview={
  expectedRevision:revision,expectedPrivateEpoch:5,
  expectedPlanRevision:null,whenOn:null,
  writeAreaId:areaId,restoreGeneration:restore,
};
const command={commandId:id,taskId,whenOn:"2026-11-07",
  expectedRevision:revision,expectedPrivateEpoch:5,
  expectedPlanRevision:null,writeAreaId:areaId,restoreGeneration:restore};
const input={taskId,areaId,whenOn:"2026-11-07",commandId:id};
const good=body=>Response.json(body,{headers:{"cache-control":"no-store"}});
const failure=status=>Response.json({error:"no"},{status,
  headers:{"cache-control":"no-store"}});

test("personal calendar dates match writer's Gregorian domain, not UTC elapsed seconds",()=>{
  for(const day of ["2024-02-29","2026-11-07","0001-01-01","9999-12-31"])
    assert.equal(validMyPlanWhenDate(day),true,day);
  for(const day of ["0000-01-01","2026-02-29","2026-04-31",
    "2026-13-01","2026-00-01","2026-01-00","2026-1-1",
    " 2026-11-07","2026-11-07T00:00:00Z","abcdefghij"])
    assert.equal(validMyPlanWhenDate(day),false,day);
  assert.equal(validMyPlanWhenDate(null),true,"null clears only own plan");
  assert.equal(myPlanWhenTarget("2026-03-28","tomorrow"),"2026-03-29");
  assert.equal(myPlanWhenTarget("2026-10-24","tomorrow"),"2026-10-25");
  assert.equal(myPlanWhenTarget("2024-02-28","tomorrow"),"2024-02-29");
  assert.equal(myPlanWhenTarget("2026-12-31","tomorrow"),"2027-01-01");
  assert.equal(myPlanWhenTarget("2026-11-06","today"),"2026-11-06");
  assert.equal(myPlanWhenTarget("9999-12-31","tomorrow"),null);
  assert.equal(myPlanWhenTarget("2026-02-29","today"),null);
  assert.equal(myPlanWhenTarget("2026-11-06","other"),null);
});

test("preview reads the exact task and builds exactly eight CAS fields",async()=>{
  let count=0;
  const prepared=await prepareMyPlanWhen(input,async(url,options)=>{
    count++;
    const req=new URL("https://example.test"+url);
    assert.equal(req.pathname,
      "/api/target-staging/task-temporal/personal-when/command");
    assert.deepEqual([...req.searchParams.keys()],["taskId"]);
    assert.equal(req.searchParams.get("taskId"),taskId);
    assert.equal(options.method,"GET");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.cache,"no-store");
    assert.equal(options.redirect,"error");
    assert.deepEqual(options.headers,{accept:"application/json"});
    return good(preview);
  });
  assert.equal(count,1);
  assert.deepEqual(prepared,{ok:true,command,previousWhenOn:null});
  assert.equal(validMyPlanWhenCommand(command),true);
});

test("preview rejects stale Area, foreign actor fields and invalid private CAS/plan snapshots",async()=>{
  for(const [name,snapshot] of [
    ["extra actor",{...preview,actorId:"bob"}],
    ["private epoch out of range",{...preview,expectedPrivateEpoch:-1}],
    ["private epoch decimal",{...preview,expectedPrivateEpoch:1.25}],
    ["private epoch unsafe",{...preview,expectedPrivateEpoch:Number.MAX_SAFE_INTEGER+1}],
    ["plan epoch invalid",{...preview,expectedPlanRevision:"2"}],
    ["plan epoch unsafe",{...preview,expectedPlanRevision:Number.MAX_SAFE_INTEGER+1}],
    ["foreign Area",{...preview,writeAreaId:"foreign-area"}],
    ["unexpected revision",{...preview,expectedRevision:"short"}],
    ["bad restore",{...preview,restoreGeneration:"missing"}],
    ["invalid previous date",{...preview,whenOn:"2026-02-29"}],
    ["missing property",{...preview,whenOn:undefined}],
  ]){
    const result=await prepareMyPlanWhen(input,async()=>good(snapshot));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},name);
  }
  assert.deepEqual(await prepareMyPlanWhen(input,async()=>Response.json(preview)),
    {ok:false,reason:"invalid-response"},"no-store is mandatory");
  assert.deepEqual(await prepareMyPlanWhen(input,async()=>new Response(
    JSON.stringify(preview),{headers:{"cache-control":"no-store"}})),
    {ok:false,reason:"invalid-response"},"JSON content type is mandatory");
  for(const [status,reason] of [[400,"invalid-request"],
    [401,"signed-out"],[403,"signed-out"],[404,"unavailable"],
    [409,"stale"],[429,"unavailable"],[503,"unavailable"]]){
    assert.deepEqual(await prepareMyPlanWhen(input,async()=>failure(status)),
      {ok:false,reason},String(status));
  }
});

test("invalid target, malformed task ID and foreign client-provided extras never make a request",async()=>{
  for(const v of [
    {...input,taskId:"x\0y"},{...input,taskId:"\ud800"},
    {...input,taskId:"é".repeat(5000)},
    {...input,whenOn:"2026-02-29"},
    {...input,areaId:"a space"},
    {...input,commandId:"bad-uuid"},
  ])assert.deepEqual(await prepareMyPlanWhen(v,async()=>{
    throw Error("must not request");
  }),{ok:false,reason:"invalid-request"});
  assert.equal(validMyPlanWhenCommand({...command,actorId:"alice"}),false);
  assert.equal(validMyPlanWhenCommand({...command,expectedPlanRevision:NaN}),false);
  assert.equal(validMyPlanWhenCommand({...command,whenOn:"2026-02-29"}),false);
  assert.equal(validMyPlanWhenCommand({...command,expectedPrivateEpoch:1.5}),false);
  assert.equal(validMyPlanWhenCommand({...command,taskId:""}),false);
});

test("same whenOn is a no-op, including null clear with no plan",async()=>{
  const result=await prepareMyPlanWhen(input,async()=>good({...preview,whenOn:input.whenOn}));
  assert.deepEqual(result,{ok:false,reason:"unchanged"});
  const cleared=await prepareMyPlanWhen({...input,whenOn:null},
    async()=>good(preview));
  assert.deepEqual(cleared,{ok:false,reason:"unchanged"});
  assert.deepEqual(await changeMyPlanWhen(input,async(url,options)=>{
    assert.equal(options.method,"GET");
    return good({...preview,whenOn:input.whenOn});
  }),{kind:"rejected",reason:"unchanged"});
});

test("single deliberate PATCH preserves private epochs, strict body and same-origin protocol",async()=>{
  const methods=[];
  const result=await changeMyPlanWhen(input,async(url,options)=>{
    methods.push(options.method);
    if(options.method==="GET")return good(preview);
    assert.equal(url,"/api/target-staging/task-temporal/personal-when/command");
    assert.equal(options.method,"PATCH");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.cache,"no-store");
    assert.equal(options.redirect,"error");
    assert.equal(options.headers["x-lumi-target-protocol"],"1");
    assert.equal(options.headers["content-type"],"application/json");
    assert.deepEqual(JSON.parse(options.body),command);
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),Object.keys(command).sort());
    return good({ok:true});
  });
  assert.deepEqual(methods,["GET","PATCH"]);
  assert.deepEqual(result,{kind:"committed",command});
});

test("ambiguous network loss looks up ONLY the original read-only receipt",async()=>{
  const calls=[];
  const result=await dispatchMyPlanWhen(command,async(url,options)=>{
    calls.push([options.method,url,options.body]);
    if(options.method==="PATCH")throw Error("connection lost after write");
    assert.equal(options.method,"POST");
    assert.equal(url,
      "/api/target-staging/task-temporal/personal-when/command/receipt");
    assert.deepEqual(JSON.parse(options.body),command);
    assert.equal(options.headers["x-lumi-target-protocol"],"1");
    return good({status:"committed"});
  });
  assert.deepEqual(result,{kind:"committed",command});
  assert.deepEqual(calls.map(x=>x[0]),["PATCH","POST"]);
});

test("not_recorded, 503, corrupt success and post-PATCH 401 remain uncertain without a retry",async()=>{
  for(const patch of [
    failure(503),good({ok:true,debug:"private"}),
    failure(401),failure(403),failure(404),
  ]){
    const calls=[];
    const result=await dispatchMyPlanWhen(command,async(url,opts)=>{
      calls.push(opts.method);
      return opts.method==="PATCH"?patch:good({status:"not_recorded"});
    });
    assert.deepEqual(result,{kind:"uncertain",command});
    assert.deepEqual(calls,["PATCH","POST"]);
  }
  const lateCommitted=await dispatchMyPlanWhen(command,async(_url,opts)=>
    opts.method==="PATCH"?failure(401):good({status:"committed"}));
  assert.deepEqual(lateCommitted,{kind:"committed",command});
});

test("400/409 pre-commit refusal returns a conflict without querying receipt",async()=>{
  for(const [status,reason] of [[400,"invalid-request"],[409,"stale"]]){
    let count=0;
    const result=await dispatchMyPlanWhen(command,async()=>{
      count++;return failure(status);
    });
    assert.deepEqual(result,{kind:"rejected",reason});
    assert.equal(count,1);
  }
});

test("receipt accepts only exact status, and abort cannot initiate an automatic resend",async()=>{
  assert.deepEqual(await checkMyPlanWhenReceipt(command,
    async()=>good({status:"committed"})),{kind:"committed"});
  assert.deepEqual(await checkMyPlanWhenReceipt(command,
    async()=>good({status:"not_recorded"})),{kind:"not-recorded"});
  for(const body of [{status:"committed",actor:"bob"}, {status:"pending"},
    {ok:true},{status:"not_recorded",revision:3}]){
    assert.deepEqual(await checkMyPlanWhenReceipt(command,
      async()=>good(body)),{kind:"unknown",reason:"invalid-response"});
  }
  assert.deepEqual(await checkMyPlanWhenReceipt(command,
    async()=>failure(401)),{kind:"unknown",reason:"signed-out"});
  const before=new AbortController();before.abort();
  let count=0;
  assert.deepEqual(await prepareMyPlanWhen({...input,signal:before.signal},
    async()=>{count++;throw Error("must not GET");}),
  {ok:false,reason:"aborted"});
  assert.equal(count,0);
  const after=new AbortController();
  const ambiguous=await dispatchMyPlanWhen(command,async(_url,opts)=>{
    count++;after.abort();return good({ok:true});
  },after.signal);
  assert.deepEqual(ambiguous,{kind:"uncertain",command});
  assert.equal(count,1,"aborted PATCH must not initiate receipt or second PATCH");
});

test("clear or Undo is another fully authorized CAS with new UUID, never original replay",async()=>{
  const first=await prepareMyPlanWhen(input,async()=>good(preview));
  const reverse=await prepareMyPlanWhen({...input,
    whenOn:null,commandId:newId},async()=>good({
      ...preview,whenOn:"2026-11-07",
      expectedPrivateEpoch:6,expectedPlanRevision:1,
    }));
  assert.equal(first.ok,true);assert.equal(reverse.ok,true);
  assert.notEqual(first.command.commandId,reverse.command.commandId);
  assert.equal(reverse.command.whenOn,null);
  assert.equal(reverse.command.expectedPlanRevision,1);
  assert.equal(reverse.command.expectedPrivateEpoch,6);
  assert.equal(reverse.previousWhenOn,"2026-11-07");
});

test("transport is inactive in staging UI, not imported in production, and never persists actor data",()=>{
  const root=path.join(import.meta.dirname,"..");
  const code=readFileSync(path.join(root,"lib/target-staging-my-plan-when-client.ts"),"utf8");
  const stage=readFileSync(path.join(root,
    "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  const prod=readFileSync(path.join(root,"app/page.tsx"),"utf8");
  assert.doesNotMatch(stage,/target-staging-my-plan-when-client|changeMyPlanWhen/);
  assert.doesNotMatch(prod,/target-staging-my-plan-when-client|changeMyPlanWhen/);
  assert.doesNotMatch(code,/localStorage|sessionStorage|indexedDB|serviceWorker|actorId|userId/);
  assert.match(code,/method:"GET",credentials:"same-origin",cache:"no-store"/);
  assert.match(code,/method:"PATCH"\|"POST"/);
});
