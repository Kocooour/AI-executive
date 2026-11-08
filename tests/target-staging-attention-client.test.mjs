import assert from "node:assert/strict";
import {test} from "node:test";
import {
  appendAttentionPage,fetchAttentionCommandPreview,fetchAttentionCommandReceipt,
  fetchAttentionPage,parseAttentionPage,sendAttentionCommand,
  validAttentionCommand,
} from "../lib/target-staging-attention-client.ts";

const KEY="tatt1:"+"a".repeat(64);
const REV="b".repeat(64);
const GEN="123e4567-e89b-42d3-a456-426614174000";
const CMD_ID="223e4567-e89b-42d3-a456-426614174001";
const params={areaFilter:"all",view:"active",timeZone:"Europe/Prague",limit:2};
const item=(taskId="t1",over={})=>({
  attentionKey:KEY.slice(0,-1)+taskId.slice(-1),subjectType:"task",taskId,
  title:"Secret "+taskId,projectId:null,areaId:"area-private",areaKind:"private",
  ruleId:"deadline_overdue",ruleVersion:1,severity:1,reasonCode:"deadline_overdue",
  relevantOn:"2026-11-01",relevantAt:1793000000000,dueOn:"2026-11-01",whenOn:null,
  thresholdHours:0,sourceRevision:3,lifecycle:"active",snoozedUntilMs:null,
  lifecycleRevision:null,...over,
});
const pageBody=(items=[item()],over={})=>({
  items,hasMore:false,nextCursor:null,areaFilter:"all",view:"active",
  timeZone:"Europe/Prague",evaluationDate:"2026-11-08",soonThroughDate:"2026-11-10",
  evaluatedAtMs:1794000000000,attentionEpoch:4,...over,
});
const hdr={"cache-control":"no-store"};
const json=(body,status=200,h=hdr)=>Response.json(body,{status,headers:h});
const command=(over={})=>({
  commandId:CMD_ID,taskId:"t1",ruleId:"deadline_overdue",occurrenceOn:"2026-11-01",
  action:"dismiss",snoozedUntilMs:null,expectedRevision:REV,expectedAttentionEpoch:4,
  expectedStateRevision:null,writeAreaId:"area-private",restoreGeneration:GEN,
  timeZone:"Europe/Prague",...over,
});
const previewBody=(over={})=>({
  expectedRevision:REV,expectedAttentionEpoch:4,expectedStateRevision:null,
  writeAreaId:"area-private",restoreGeneration:GEN,lifecycle:"active",
  snoozedUntilMs:null,...over,
});
const recorder=(answer)=>{
  const calls=[];
  const fetcher=async(url,init)=>{calls.push({url:String(url),init});return answer(calls.length);};
  fetcher.calls=calls;return fetcher;
};

test("page transport: same-origin no-store GET with exact query and no extra headers",async()=>{
  const f=recorder(()=>json(pageBody()));
  const r=await fetchAttentionPage({...params,cursor:"aA.bB"},f);
  assert.equal(r.status,"ok");
  const {url,init}=f.calls[0];
  const u=new URL(url,"http://x");
  assert.equal(u.pathname,"/api/target-staging/attention");
  assert.deepEqual([...u.searchParams.keys()].sort(),
    ["areaFilter","cursor","limit","timeZone","view"]);
  assert.equal(u.searchParams.get("timeZone"),"Europe/Prague");
  assert.equal(init.method,"GET");assert.equal(init.credentials,"same-origin");
  assert.equal(init.cache,"no-store");assert.equal(init.redirect,"error");
  assert.deepEqual(init.headers,{accept:"application/json"});
  assert.equal(init.body,undefined);
});

test("page transport refuses invalid requests without any network call",async()=>{
  const f=recorder(()=>json(pageBody()));
  for(const bad of [{areaFilter:"mine"},{view:"x"},{timeZone:"../etc"},
    {timeZone:"Nope/Zone"},{limit:0},{limit:101},{limit:1.5},{cursor:"bad cursor"},
    {cursor:"a.b".padEnd(5000,"a")}])
    assert.deepEqual(await fetchAttentionPage({...params,...bad},f),{status:"invalid"});
  assert.equal(f.calls.length,0);
});

test("page status mapping is content-free and never retries",async()=>{
  for(const [code,status] of [[401,"unauthorized"],[403,"unauthorized"],
    [409,"stale"],[400,"invalid"],[404,"not_found"],[429,"unavailable"],
    [500,"unavailable"],[503,"unavailable"]]){
    const f=recorder(()=>json({error:"Secret title leak"},code));
    assert.deepEqual(await fetchAttentionPage(params,f),{status});
    assert.equal(f.calls.length,1);
  }
  const net=recorder(()=>{throw Error("boom Secret");});
  assert.deepEqual(await fetchAttentionPage(params,net),{status:"unavailable"});
  assert.equal(net.calls.length,1);
});

test("page response envelope: redirect, cache, content-type, size and malformed JSON",async()=>{
  const bad=[
    ()=>json(pageBody(),200,{}),
    ()=>json(pageBody(),200,{"cache-control":"private"}),
    ()=>new Response(JSON.stringify(pageBody()),{headers:{...hdr,"content-type":"text/html"}}),
    ()=>new Response("{not json",{headers:{...hdr,"content-type":"application/json"}}),
    ()=>json(pageBody(),200,{...hdr,"content-length":String(3*1024*1024)}),
    ()=>new Response(new Uint8Array(2*1024*1024+1),
      {headers:{...hdr,"content-type":"application/json"}}),
  ];
  for(const make of bad)
    assert.deepEqual(await fetchAttentionPage(params,recorder(make)),{status:"invalid_response"});
  const redirected=json(pageBody());
  Object.defineProperty(redirected,"redirected",{value:true});
  assert.deepEqual(await fetchAttentionPage(params,recorder(()=>redirected)),
    {status:"invalid_response"});
});

test("page DTO strict rejection matrix",()=>{
  const reject=(body,p=params)=>assert.equal(parseAttentionPage(body,p),null);
  assert.ok(parseAttentionPage(pageBody(),params));
  assert.ok(parseAttentionPage(pageBody([item("t1"),item("t2")]),params));
  reject(null);reject([]);reject("x");
  for(const k of ["items","hasMore","nextCursor","evaluatedAtMs","attentionEpoch",
    "evaluationDate","soonThroughDate","timeZone","view","areaFilter"]){
    const b=pageBody();delete b[k];reject(b);
  }
  for(const extra of ["privateEpoch","linearization","areaEpochs","revision","actorUserId","ok"])
    reject({...pageBody(),[extra]:1});
  reject(pageBody([],{areaFilter:"personal"}));reject(pageBody([],{view:"hidden"}));
  reject(pageBody([],{timeZone:"UTC"}));
  reject(pageBody([item(),item("t2"),item("t3")]));//over limit
  reject(pageBody([item()],{hasMore:true,nextCursor:"a.b"}));//short page
  reject(pageBody([item(),item("t2")],{hasMore:true,nextCursor:null}));
  reject(pageBody([item(),item("t2")],{hasMore:true,nextCursor:"bad cursor"}));
  reject(pageBody([],{nextCursor:"a.b"}));
  reject(pageBody([],{attentionEpoch:-1}));reject(pageBody([],{attentionEpoch:"4"}));
  reject(pageBody([],{attentionEpoch:1.5}));reject(pageBody([],{evaluatedAtMs:"1"}));
  reject(pageBody([],{evaluationDate:"2026-02-30"}));
  reject(pageBody([],{soonThroughDate:"2026-11-07"}));
  reject(pageBody([],{soonThroughDate:"nope"}));
  // item level
  reject(pageBody([{...item(),extra:1}]));
  reject(pageBody([{...item(),actorUserId:"u"}]));
  const missing=item();delete missing.title;reject(pageBody([missing]));
  for(const over of [{taskId:""},{taskId:1},{title:1},{areaId:""},{projectId:3},
    {areaKind:"other"},{subjectType:"note"},{ruleId:"x"},{ruleVersion:2},
    {severity:2},{reasonCode:"deadline_soon"},{relevantOn:"2026-11-02"},
    {dueOn:"2026-13-01"},{whenOn:"2026-13-01"},{relevantAt:-1},{thresholdHours:48},
    {sourceRevision:-1},{sourceRevision:"1"},{attentionKey:"tatt1:short"},
    {attentionKey:1},{lifecycle:"snoozed",snoozedUntilMs:1794000000001,lifecycleRevision:0},
    {lifecycle:"dismissed",lifecycleRevision:0},{snoozedUntilMs:5},
    {lifecycleRevision:-1},{assignedToMe:true},
    // rule disagrees with the window: due in the future is not overdue
    {dueOn:"2026-12-31",relevantOn:"2026-12-31"}])
    reject(pageBody([item("t1",over)]));
  reject(pageBody([item("t1",{areaKind:"shared"})]));//assignedToMe missing
  reject(pageBody([item("t1",{areaKind:"shared",assignedToMe:false})]));
  reject(pageBody([item("t1",{areaKind:"shared",assignedToMe:true})]),
    {...params,areaFilter:"personal"});
  reject(pageBody([item()],{areaFilter:"shared"}),{...params,areaFilter:"shared"});
  // duplicates, order, area kind clash
  reject(pageBody([item("t1"),item("t1")]));
  reject(pageBody([item("t2"),item("t1")]));
  reject(pageBody([item("t1",{areaId:"x"}),
    item("t2",{areaId:"x",areaKind:"shared",assignedToMe:true})]));
});

test("page DTO accepts hidden views with consistent lifecycle only",()=>{
  const hp={...params,view:"hidden"};
  const snoozed=item("t1",{lifecycle:"snoozed",snoozedUntilMs:1794000000001,
    lifecycleRevision:0});
  const dismissed=item("t2",{lifecycle:"dismissed",lifecycleRevision:1});
  const body=over=>pageBody(over,{view:"hidden"});
  assert.ok(parseAttentionPage(body([snoozed,dismissed]),hp));
  assert.equal(parseAttentionPage(body([item()]),hp),null,"active in hidden");
  assert.equal(parseAttentionPage(body([item("t1",{lifecycle:"snoozed",
    snoozedUntilMs:1794000000000,lifecycleRevision:0})]),hp),null,"expired snooze");
});

test("planned_date_passed and deadline_soon follow the issued window",()=>{
  const planned=item("t1",{ruleId:"planned_date_passed",reasonCode:"planned_date_passed",
    severity:5,relevantOn:"2026-11-05",dueOn:null,whenOn:"2026-11-05"});
  const soon=item("t0",{ruleId:"deadline_soon",reasonCode:"deadline_soon",severity:2,
    relevantOn:"2026-11-09",dueOn:"2026-11-09",thresholdHours:48});
  assert.ok(parseAttentionPage(pageBody([soon,planned]),params));
  assert.equal(parseAttentionPage(pageBody([soon],{soonThroughDate:null}),params),null);
  assert.equal(parseAttentionPage(pageBody([planned,soon]),params),null,"order");
});

test("appendAttentionPage keeps the pinned instant, epoch and strict order",()=>{
  const first=parseAttentionPage(pageBody([item("t1"),item("t2")],
    {hasMore:true,nextCursor:"a.b"}),params);
  const next=over=>parseAttentionPage(pageBody([item("t3")],over),params);
  assert.equal(appendAttentionPage(first,next({})).items.length,3);
  for(const over of [{evaluatedAtMs:1794000000001},{attentionEpoch:5},
    {evaluationDate:"2026-11-09"},{soonThroughDate:null}])
    assert.equal(appendAttentionPage(first,next(over)),null);
  const again=parseAttentionPage(pageBody([item("t3")],
    {hasMore:true,nextCursor:"a.b",items:undefined}),params);
  assert.equal(again,null);
  assert.equal(appendAttentionPage(first,parseAttentionPage(
    pageBody([item("t2")]),params)),null,"duplicate");
  assert.equal(appendAttentionPage(first,parseAttentionPage(
    pageBody([item("t0")]),params)),null,"disorder");
  assert.equal(appendAttentionPage(next({}),next({})),null,"no cursor to follow");
});

test("page abort: before headers, during body, and before start",async()=>{
  const pre=new AbortController();pre.abort();
  const never=recorder(()=>json(pageBody()));
  assert.deepEqual(await fetchAttentionPage({...params,signal:pre.signal},never),{status:"aborted"});
  assert.equal(never.calls.length,0);
  const c=new AbortController();let release;
  const stalled=recorder(()=>new Promise(r=>{release=r;}));
  const pending=fetchAttentionPage({...params,signal:c.signal},stalled);
  c.abort();
  assert.deepEqual(await pending,{status:"aborted"});
  let cancelled;const seen=new Promise(r=>{cancelled=r;});
  release(new Response(new ReadableStream({cancel(){cancelled();}},{highWaterMark:0}),
    {headers:{...hdr,"content-type":"application/json"}}));
  await Promise.race([seen,new Promise((_,j)=>setTimeout(()=>j(Error("late body kept")),2000))]);
  const d=new AbortController();
  const body=new ReadableStream({start(ctl){ctl.enqueue(new TextEncoder().encode("{"));}});
  const mid=fetchAttentionPage({...params,signal:d.signal},
    recorder(()=>new Response(body,{headers:{...hdr,"content-type":"application/json"}})));
  await new Promise(r=>setTimeout(r,10));d.abort();
  assert.deepEqual(await mid,{status:"aborted"});
});

test("preview transport: exact query, headers and strict DTO",async()=>{
  const f=recorder(()=>json(previewBody()));
  const r=await fetchAttentionCommandPreview({taskId:"t 1/é",ruleId:"deadline_overdue",
    occurrenceOn:"2026-11-01"},f);
  assert.deepEqual(r,{status:"ok",preview:previewBody()});
  const u=new URL(f.calls[0].url,"http://x");
  assert.equal(u.pathname,"/api/target-staging/attention/command");
  assert.deepEqual([...u.searchParams.entries()].sort(),
    [["occurrenceOn","2026-11-01"],["ruleId","deadline_overdue"],["taskId","t 1/é"]]);
  assert.equal(f.calls[0].init.method,"GET");
  assert.equal(f.calls[0].init.credentials,"same-origin");
  assert.equal(f.calls[0].init.cache,"no-store");
  const bad=[{extra:1},{expectedRevision:"x"},{expectedAttentionEpoch:-1},
    {expectedStateRevision:"1"},{writeAreaId:"bad area"},{restoreGeneration:"nope"},
    {lifecycle:"x"},{lifecycle:"snoozed"},{snoozedUntilMs:5},
    {lifecycle:"dismissed"},{lifecycle:"snoozed",snoozedUntilMs:0,expectedStateRevision:0},
    {actorUserId:"u"}];
  for(const over of bad)
    assert.deepEqual(await fetchAttentionCommandPreview({taskId:"t",ruleId:"deadline_soon",
      occurrenceOn:"2026-11-01"},recorder(()=>json(previewBody(over)))),
      {status:"invalid_response"},JSON.stringify(over));
  const missing=previewBody();delete missing.lifecycle;
  assert.deepEqual(await fetchAttentionCommandPreview({taskId:"t",ruleId:"deadline_soon",
    occurrenceOn:"2026-11-01"},recorder(()=>json(missing))),{status:"invalid_response"});
  const snoozed=previewBody({lifecycle:"snoozed",snoozedUntilMs:9,expectedStateRevision:0});
  assert.equal((await fetchAttentionCommandPreview({taskId:"t",ruleId:"deadline_soon",
    occurrenceOn:"2026-11-01"},recorder(()=>json(snoozed)))).status,"ok");
});

test("preview refuses bad input locally and maps statuses",async()=>{
  const f=recorder(()=>json(previewBody()));
  for(const bad of [{taskId:""},{taskId:"a\0b"},{taskId:"\ud800"},{ruleId:"x"},
    {occurrenceOn:"2026-02-30"},{occurrenceOn:"0000-01-01"}])
    assert.deepEqual(await fetchAttentionCommandPreview({taskId:"t",
      ruleId:"deadline_overdue",occurrenceOn:"2026-11-01",...bad},f),{status:"invalid"});
  assert.equal(f.calls.length,0);
  for(const [code,status] of [[401,"unauthorized"],[404,"not_found"],[409,"conflict"],
    [400,"invalid"],[503,"unavailable"]])
    assert.deepEqual(await fetchAttentionCommandPreview({taskId:"t",
      ruleId:"deadline_overdue",occurrenceOn:"2026-11-01"},
      recorder(()=>json({error:"x"},code))),{status});
});

test("command validator is exactly the writer's twelve fields",()=>{
  assert.equal(validAttentionCommand(command()),true);
  assert.equal(validAttentionCommand(command({action:"snooze",snoozedUntilMs:5})),true);
  assert.equal(validAttentionCommand(command({action:"restore",expectedStateRevision:0})),true);
  assert.equal(validAttentionCommand({...command(),actor:"u"}),false);
  const m=command();delete m.timeZone;assert.equal(validAttentionCommand(m),false);
  for(const over of [{commandId:"x"},{taskId:""},{ruleId:"x"},{occurrenceOn:null},
    {action:"x"},{action:"snooze"},{action:"snooze",snoozedUntilMs:0},
    {snoozedUntilMs:5},{expectedRevision:"short"},{expectedAttentionEpoch:-1},
    {expectedStateRevision:-1},{writeAreaId:""},{restoreGeneration:"x"},
    {timeZone:"Nope/Zone"}])
    assert.equal(validAttentionCommand(command(over)),false,JSON.stringify(over));
  assert.equal(validAttentionCommand(null),false);
  assert.equal(validAttentionCommand([]),false);
});

test("PATCH sends protocol header, exact body, same-origin, once",async()=>{
  const f=recorder(()=>json({ok:true}));
  assert.deepEqual(await sendAttentionCommand(command(),undefined,f),
    {status:"ok",replayed:false});
  const {url,init}=f.calls[0];
  assert.equal(url,"/api/target-staging/attention/command");
  assert.equal(init.method,"PATCH");assert.equal(init.credentials,"same-origin");
  assert.equal(init.cache,"no-store");assert.equal(init.redirect,"error");
  assert.equal(init.headers["x-lumi-target-protocol"],"1");
  assert.equal(init.headers["content-type"],"application/json");
  assert.deepEqual(JSON.parse(init.body),command());
  assert.equal(Object.keys(JSON.parse(init.body)).length,12);
  assert.deepEqual(await sendAttentionCommand(command(),undefined,
    recorder(()=>json({ok:true,replayed:true}))),{status:"ok",replayed:true});
});

test("PATCH never sends a command carrying extra keys",async()=>{
  const f=recorder(()=>json({ok:true}));
  assert.deepEqual(await sendAttentionCommand({...command(),actorUserId:"u"},undefined,f),
    {status:"invalid"});
  assert.equal(f.calls.length,0);
});

test("PATCH status mapping: definitive vs uncertain, never retried",async()=>{
  const table=[[400,"invalid"],[401,"unauthorized"],[403,"unauthorized"],
    [404,"not_found"],[409,"conflict"],[429,"unavailable"],
    [500,"uncertain"],[502,"uncertain"],[503,"uncertain"],[418,"uncertain"]];
  for(const [code,status] of table){
    const f=recorder(()=>json({error:"x"},code));
    assert.deepEqual(await sendAttentionCommand(command(),undefined,f),{status},String(code));
    assert.equal(f.calls.length,1,"no automatic retry");
  }
  const net=recorder(()=>{throw Error("offline Secret");});
  assert.deepEqual(await sendAttentionCommand(command(),undefined,net),{status:"uncertain"});
  assert.equal(net.calls.length,1);
  // a malformed or foreign 200 may still follow a commit
  for(const body of [{ok:false},{ok:true,replayed:false},{ok:true,extra:1},[],"x",null])
    assert.deepEqual(await sendAttentionCommand(command(),undefined,
      recorder(()=>json(body))),{status:"uncertain"},JSON.stringify(body));
  assert.deepEqual(await sendAttentionCommand(command(),undefined,
    recorder(()=>json({ok:true},200,{}))),{status:"uncertain"});
  assert.deepEqual(await sendAttentionCommand(command(),undefined,
    recorder(()=>new Response("{",{headers:{...hdr,"content-type":"application/json"}}))),
    {status:"uncertain"});
});

test("PATCH abort: before send is aborted, after send is uncertain",async()=>{
  const pre=new AbortController();pre.abort();
  const none=recorder(()=>json({ok:true}));
  assert.deepEqual(await sendAttentionCommand(command(),pre.signal,none),{status:"aborted"});
  assert.equal(none.calls.length,0);
  const c=new AbortController();
  const stalled=recorder(()=>new Promise(()=>{}));
  const pending=sendAttentionCommand(command(),c.signal,stalled);
  c.abort();
  assert.deepEqual(await pending,{status:"uncertain"});
  assert.equal(stalled.calls.length,1);
});

test("receipt: read-only POST with same command, strict body, status mapping",async()=>{
  const f=recorder(()=>json({status:"committed"}));
  assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,f),
    {status:"ok",receipt:"committed"});
  assert.equal(f.calls[0].url,"/api/target-staging/attention/command/receipt");
  assert.equal(f.calls[0].init.method,"POST");
  assert.equal(f.calls[0].init.headers["x-lumi-target-protocol"],"1");
  assert.deepEqual(JSON.parse(f.calls[0].init.body),command());
  assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,
    recorder(()=>json({status:"not_recorded"}))),{status:"ok",receipt:"not_recorded"});
  for(const body of [{status:"maybe"},{status:"committed",extra:1},{},[],null])
    assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,
      recorder(()=>json(body))),{status:"invalid_response"});
  for(const [code,status] of [[401,"unauthorized"],[404,"not_found"],[409,"conflict"],
    [400,"invalid"],[503,"unavailable"]]){
    const g=recorder(()=>json({error:"x"},code));
    assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,g),{status});
    assert.equal(g.calls.length,1);
  }
  assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,
    recorder(()=>{throw Error("x");})),{status:"unavailable"});
  assert.deepEqual(await fetchAttentionCommandReceipt({...command(),x:1},undefined,f),
    {status:"invalid"});
});

test("write/receipt bodies are bounded",async()=>{
  const big=()=>new Response(new Uint8Array(20*1024),
    {headers:{...hdr,"content-type":"application/json"}});
  assert.deepEqual(await sendAttentionCommand(command(),undefined,recorder(big)),
    {status:"uncertain"});
  assert.deepEqual(await fetchAttentionCommandReceipt(command(),undefined,recorder(big)),
    {status:"invalid_response"});
  assert.deepEqual(await fetchAttentionCommandPreview({taskId:"t",
    ruleId:"deadline_overdue",occurrenceOn:"2026-11-01"},recorder(big)),
    {status:"invalid_response"});
});

test("PR #328: accept all backend-valid nonempty IDs in a bounded Attention read",async()=>{
  const longId="task-"+"ž".repeat(600);
  const longArea="area-"+"x".repeat(900);
  const longProject="project-"+"y".repeat(900);
  const row=item(longId,{
    attentionKey:KEY,title:"Valid long ID task",
    areaId:longArea,projectId:longProject,
  });
  const data=pageBody([row]);
  const parsed=parseAttentionPage(data,params);
  assert.ok(parsed,"the server accepts these nonempty ID strings");
  assert.equal(parsed.items[0].taskId,longId);
  assert.equal(parsed.items[0].areaId,longArea);
  assert.equal(parsed.items[0].projectId,longProject);
  const fetcher=recorder(()=>json(data));
  assert.equal((await fetchAttentionPage(params,fetcher)).status,"ok");
  // The server's read contract also permits nonempty IDs containing control
  // characters. The reader must not substitute the stricter mutation policy.
  assert.ok(parseAttentionPage(pageBody([item("a\\nb",{
    attentionKey:KEY,areaId:"area\\nwith-linebreak",projectId:"project\\twith-tab",
  })]),params));
  assert.equal(parseAttentionPage(pageBody([item("",{attentionKey:KEY})]),params),null);
});
