import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  c2AddDays,c2SevenDayGroups,parseC2Day,parseC2Summary,
  fetchC2Day,fetchC2HomeSummary,
} from "../lib/target-upcoming-home-client.ts";

const tomorrow="2026-11-20";
const task=(id,whenOn,dueOn=null)=>({
  taskId:id,title:"Task "+id,projectId:null,areaId:"area",
  areaKind:"private",dueOn,whenOn,attentionOn:[whenOn,dueOn].filter(Boolean).sort()[0],
});
const params={window:"upcoming",evaluationDate:"2026-11-19",
  throughDate:"2026-11-26",areaFilter:"personal",limit:50};
const page=(tasks,hasMore=false,nextCursor=null)=>({
  ...params,tasks,hasMore,nextCursor,
});
const headers={"cache-control":"private, no-store","content-type":"application/json"};
const respond=(body,status=200,extra={})=>new Response(JSON.stringify(body),
  {status,headers:{...headers,...extra}});

test("C-2 calendar days include tomorrow through day seven across DST and leap day",()=>{
  assert.equal(c2AddDays("2026-11-19",7),"2026-11-26");
  assert.equal(c2AddDays("2028-02-28",1),"2028-02-29");
  assert.equal(c2AddDays("2028-02-28",2),"2028-03-01");
  assert.equal(c2AddDays("2026-03-28",1),"2026-03-29");
  assert.equal(c2AddDays("2026-10-24",1),"2026-10-25");
  assert.equal(c2AddDays("2026-02-30",1),null);
  const groups=c2SevenDayGroups([task("tomorrow",tomorrow),task("later","2026-11-26"),
    task("past","2026-11-18"),task("undated",null,null),
    task("beyond","2026-11-27")],"2026-11-19");
  assert.deepEqual(groups.map(g=>g.day),["2026-11-20","2026-11-21","2026-11-22",
    "2026-11-23","2026-11-24","2026-11-25","2026-11-26"]);
  assert.deepEqual(groups.flatMap(g=>g.tasks.map(t=>t.taskId)),["tomorrow","later"]);
});

test("C-2 page parser enforces target dates, order, cursor and actor-private filter",()=>{
  const a=task("a",tomorrow,"2026-11-22");
  assert.deepEqual(parseC2Day(page([a]),params)?.tasks,[a]);
  assert.equal(parseC2Day(page([a,a]),params),null);
  assert.equal(parseC2Day(page([task("a","2026-11-27")]),params),null);
  assert.equal(parseC2Day(page([task("a","2026-11-19")]),params),null);
  assert.equal(parseC2Day(page([task("b","2026-11-22"),a]),params),null);
  assert.equal(parseC2Day(page([task("a",null,null)]),params),null);
  assert.equal(parseC2Day(page([{...a,attentionOn:"2026-11-22"}]),params),null);
  assert.equal(parseC2Day(page([{...a,areaKind:"shared",assignedToMe:true}]),params),null);
  assert.equal(parseC2Day(page([{...a,areaKind:"shared"}]),params),null);
  assert.equal(parseC2Day(page([a],true,null),params),null);
  assert.equal(parseC2Day(page([],true,"abc.def"),params),null);
  assert.ok(parseC2Day(page([a],true,"abc.def"),params));
  assert.equal(parseC2Day({...page([a]),window:"today"},params),null);
});

test("C-2 summary accepts only authorized bounded totals, never attention",()=>{
  const body={scope:"my-plan",counts:{tasks:8,projects:3},
    truncated:{tasks:false,projects:false}};
  assert.deepEqual(parseC2Summary(body,"my-plan"),body);
  assert.equal(parseC2Summary(body,"shared"),null);
  assert.equal(parseC2Summary({...body,counts:{tasks:-1,projects:3}},"my-plan"),null);
  assert.equal(parseC2Summary({...body,counts:{tasks:1001,projects:3}},"my-plan"),null);
});

test("C-2 clients request only server-authorized target endpoints and fail closed on refused reads",async()=>{
  const seen=[];
  const fetchImpl=async(url,init)=>{
    seen.push({url,init});
    if(url.includes("home/summary"))return respond({
      scope:"my-plan",counts:{tasks:4,projects:1},
      truncated:{tasks:false,projects:false}});
    return respond(page([task("a",tomorrow)]));
  };
  const result=await fetchC2Day({...params,signal:new AbortController().signal},fetchImpl);
  assert.equal(result.ok,true);
  assert.match(seen[0].url,/^\/api\/target-staging\/task-temporal\/my-plan-day\?/);
  assert.equal(seen[0].init.cache,"no-store");
  assert.equal(seen[0].init.credentials,"same-origin");
  const home=await fetchC2HomeSummary("my-plan",undefined,fetchImpl);
  assert.equal(home.ok,true);
  assert.equal(seen[1].url,"/api/target-staging/home/summary?scope=my-plan");
  for(const status of [401,403,409,503]){
    const refused=await fetchC2Day(params,async()=>respond({error:"refused"},status));
    assert.equal(refused.ok,false);
    assert.equal(refused.reason,status===401||status===403?"signed-out":status===409?"stale":"unavailable");
  }
  const invalid=await fetchC2Day(params,async()=>respond(page([task("a",tomorrow)]),200,{"cache-control":"public"}));
  assert.deepEqual(invalid,{ok:false,reason:"invalid-response"});
  const abort=new AbortController();abort.abort();
  assert.deepEqual(await fetchC2Day({...params,signal:abort.signal},fetchImpl),{ok:false,reason:"aborted"});
});


test("C-2 response budget rejects oversized Content-Length without decoding",async()=>{
  const response=await fetchC2Day(params,async()=>respond(page([task("a",tomorrow)]),200,
    {"content-length":"350001"}));
  assert.deepEqual(response,{ok:false,reason:"invalid-response"});
  const invalidLength=await fetchC2HomeSummary("my-plan",undefined,async()=>respond({
    scope:"my-plan",counts:{tasks:1,projects:0},truncated:{tasks:false,projects:false}
  },200,{"content-length":"3.5e5"}));
  assert.deepEqual(invalidLength,{ok:false,reason:"invalid-response"});
});

test("C-2 streaming reader cancels oversized unannounced chunks before accumulation",async()=>{
  let canceled=false,pulls=0;
  const body=new ReadableStream({
    pull(controller){
      pulls++;
      controller.enqueue(new Uint8Array(180_000));
    },
    cancel(){canceled=true;},
  });
  const response=await fetchC2Day(params,async()=>new Response(body,{headers}));
  assert.deepEqual(response,{ok:false,reason:"invalid-response"});
  assert.equal(canceled,true,"stream is canceled on the second over-budget chunk");
  assert.ok(pulls<=4,"reader stops requesting further chunks");
});

test("C-2 rejects malformed UTF-8 and fake no-store while failing closed",async()=>{
  const malformed=await fetchC2Day(params,async()=>new Response(
    new Uint8Array([0xc3,0x28]),{headers}));
  assert.deepEqual(malformed,{ok:false,reason:"invalid-response"});
  const quoted=await fetchC2Day(params,async()=>respond(page([task("a",tomorrow)]),
    200,{"cache-control":'private, "no-store"'}));
  assert.deepEqual(quoted,{ok:false,reason:"invalid-response"});
});

test("C-2 abort cancels a stalled streaming body and returns no record",async()=>{
  let canceled=false;
  const controller=new AbortController();
  const body=new ReadableStream({
    start(stream){stream.enqueue(new TextEncoder().encode('{"tasks":'));},
    cancel(){canceled=true;},
  });
  const pending=fetchC2Day({...params,signal:controller.signal},
    async()=>new Response(body,{headers}));
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending,{ok:false,reason:"aborted"});
  assert.equal(canceled,true);
});

test("C-2 abort settles even if the fetch adapter ignores its signal",async()=>{
  const controller=new AbortController();
  let release;
  const deferred=new Promise(resolve=>{release=resolve;});
  const pending=fetchC2Day({...params,signal:controller.signal},()=>deferred);
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending,{ok:false,reason:"aborted"});
  release(respond(page([task("a",tomorrow)])));
  await new Promise(resolve=>setImmediate(resolve));
});


test("C-2 overview subscribes to verified ACL ticks and fail-closed wake lifecycle",()=>{
  const ui=readFileSync(new URL("../app/ui/target-overview.tsx",import.meta.url),"utf8");
  const dayReader=readFileSync(new URL("../lib/target-my-plan-day-task-read-model.ts",import.meta.url),"utf8");
  assert.match(ui,/useTargetTick\(reload\)/,"membership can change while the generation remains valid");
  assert.match(ui,/useTargetWake\(\{/);
  assert.match(ui,/hide\(reason\)\{/);
  assert.match(ui,/readAbort\.current\?\.abort\(\);moreAbort\.current\?\.abort\(\)/);
  assert.match(ui,/setPrivacyHidden\(true\)/);
  assert.match(ui,/signedOut\(\)\{/);
  assert.match(ui,/setPrivacyHidden\(false\)/);
  assert.match(ui,/markHidden\(\)/,"initial hidden or offline mount must require a fresh wake");
  assert.match(ui,/privacyHidden\|\|document\.visibilityState==="hidden"\|\|!navigator\.onLine/);
  assert.match(ui,/state\.status==="loading"\|\|\(!privacyHidden&&state\.key!==viewKey\)/);
  assert.match(dayReader,/m\.role IN \('editor','admin'\) AND t\.assignee_user_id=actor\.id/,
    "each verified tick re-reads the server-authorized actor assignment");
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|legacyTasks/);
});
