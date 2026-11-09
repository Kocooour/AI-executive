import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {createTargetDetailSession,detailFailure} from "../lib/target-detail-session.ts";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const json=(body,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
const task=(over={})=>({id:"t1",title:"Task one",projectId:"p1",areaId:"a1",areaKind:"private",
  status:"open",completedAtMs:null,dueOn:"2026-11-10",...over});
const projectPage=(over={},tasks=[{id:"t1",title:"Task one",projectId:"p1",areaId:"a1",effectiveAreaId:"a1",areaKind:"private"}],more=null)=>({
  project:{id:"p1",title:"Project one",areaId:"a1",areaKind:"private",...over},
  tasks,hasMore:more!==null,nextCursor:more});
const note=(over={})=>({id:"n1",title:"Note one",body:"Line 1\nLine 2",projectId:null,areaId:"a1",areaKind:"private",revision:3,...over});

function server(handler){
  const calls=[];
  const fetchFake=async(url,init)=>{calls.push(String(url));return handler(new URL(String(url),"https://lumi.test"),init);};
  return {fetchFake,calls};
}
const generationBox=(value="G1")=>{const box={value};box.read=()=>box.value;return box;};
const make=(kind,id,fake,box=generationBox())=>createTargetDetailSession({kind,id,contextVersion:box.read},fake.fetchFake);

test("task: reads the detail route once and the parent title best effort",async()=>{
  const fake=server(url=>url.pathname==="/api/target-staging/task-temporal/detail"
    ?json({task:task()})
    :json(projectPage()));
  const result=await make("task","t1",fake).load();
  assert.equal(result.ok,true);
  assert.equal(result.content.kind,"task");
  assert.equal(result.content.task.title,"Task one");
  assert.equal(result.content.parentTitle,"Project one");
  assert.equal(fake.calls.length,2);
  assert.match(fake.calls[0],/task-temporal\/detail\?taskId=t1$/);
  assert.match(fake.calls[1],/projects\/p1\/tasks\?limit=1$/);
});

test("task: an unauthorized parent leaves only the title out, never an error or its existence",async()=>{
  const fake=server(url=>url.pathname.includes("task-temporal")?json({task:task()}):json({error:"Not found"},404));
  const result=await make("task","t1",fake).load();
  assert.equal(result.ok,true);
  assert.equal(result.content.parentTitle,null);
});

test("task without a project makes no parent request",async()=>{
  const fake=server(()=>json({task:task({projectId:null})}));
  const result=await make("task","t1",fake).load();
  assert.equal(result.ok,true);
  assert.equal(fake.calls.length,1);
});

test("project: first page, then loadMore appends with the cursor chain",async()=>{
  const row=id=>({id,title:"T "+id,projectId:"p1",areaId:"a1",effectiveAreaId:"a1",areaKind:"private"});
  const cursor="abc.def";
  const fake=server(url=>url.searchParams.get("cursor")===null
    ?json(projectPage({},Array.from({length:25},(_,i)=>row("t"+String(i).padStart(2,"0"))),cursor))
    :json(projectPage({},[row("t90")],null)));
  const session=make("project","p1",fake);
  const first=await session.load();
  assert.equal(first.ok,true);
  assert.equal(first.content.page.tasks.length,25);
  assert.equal(first.content.page.hasMore,true);
  const second=await session.loadMore();
  assert.equal(second.ok,true);
  assert.equal(second.content.page.tasks.length,26);
  assert.equal(second.content.page.hasMore,false);
  assert.match(fake.calls[1],/cursor=abc\.def/);
});

test("note: title and body come only from the strict note reader",async()=>{
  const fake=server(()=>json({note:note()}));
  const result=await make("note","n1",fake).load();
  assert.equal(result.ok,true);
  assert.equal(result.content.note.body,"Line 1\nLine 2");
  const wrongId=server(()=>json({note:note({id:"other"})}));
  assert.deepEqual(await make("note","n1",wrongId).load(),{ok:false,reason:"invalid-response"});
  const extra=server(()=>json({note:{...note(),secret:"x"}}));
  assert.deepEqual(await make("note","n1",extra).load(),{ok:false,reason:"invalid-response"});
});

test("missing, foreign, revoked, malformed and disabled are one indistinguishable answer",async()=>{
  for(const kind of ["task","project","note"]){
    const answers=new Set();
    for(const status of [404,400]){
      const fake=server(()=>json({error:"x"},status));
      answers.add(JSON.stringify(await make(kind,"x1",fake).load()));
    }
    assert.deepEqual([...answers],[JSON.stringify({ok:false,reason:"not-available"})],kind);
  }
  // An id the client refuses to send never reaches the network.
  const fake=server(()=>json({}));
  assert.deepEqual(await make("note","a\u0001b",fake).load(),{ok:false,reason:"not-available"});
  assert.equal(fake.calls.length,0);
  assert.equal(detailFailure("disabled"),"not-available");
  assert.equal(detailFailure("not-found"),"not-available");
  assert.equal(detailFailure("invalid-request"),"not-available");
});

test("401/403 is signed-out (feeds the refusal budget), 409 stale, 429 and 5xx distinct",async()=>{
  const expect={401:"signed-out",403:"signed-out",409:"stale",429:"rate-limited",503:"unavailable"};
  for(const [status,reason] of Object.entries(expect)){
    const fake=server(()=>json({error:"x"},Number(status)));
    assert.deepEqual(await make("note","n1",fake).load(),{ok:false,reason},status);
  }
  const offline=server(()=>{throw new TypeError("network");});
  assert.deepEqual(await make("project","p1",offline).load(),{ok:false,reason:"offline"});
});

test("a generation change makes the session terminal; A -> B -> A does not revive it",async()=>{
  const fake=server(()=>json({note:note()}));
  const box=generationBox("G1");
  const session=make("note","n1",fake,box);
  assert.equal((await session.load()).ok,true);
  box.value="G2";
  assert.deepEqual(await session.load(),{ok:false,reason:"stale"});
  box.value="G1";
  assert.deepEqual(await session.load(),{ok:false,reason:"stale"});
  assert.equal(fake.calls.length,1,"no read after the change");
});

test("a response that arrives after a generation change is dropped, not rendered",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const fake=server(async()=>{await gate;return json({note:note()});});
  const box=generationBox("G1");
  const pending=make("note","n1",fake,box).load();
  box.value="G2";
  release();
  assert.deepEqual(await pending,{ok:false,reason:"stale"});
});

test("an unknown generation never reads: empty or throwing context is refused up front",async()=>{
  const fake=server(()=>json({note:note()}));
  const empty=createTargetDetailSession({kind:"note",id:"n1",contextVersion:()=>""},fake.fetchFake);
  assert.deepEqual(await empty.load(),{ok:false,reason:"stale"});
  const throwing=createTargetDetailSession({kind:"note",id:"n1",contextVersion:()=>{throw new Error("x");}},fake.fetchFake);
  assert.deepEqual(await throwing.load(),{ok:false,reason:"stale"});
  assert.equal(fake.calls.length,0);
});

test("suspend (hidden/offline) aborts, refuses reads until an explicit resume, then re-reads",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let first=true;
  const fake=server(async(_url,init)=>{
    if(first){first=false;await gate;}
    return json({note:note()});
  });
  const session=make("note","n1",fake);
  const inFlight=session.load();
  session.suspend();
  release();
  assert.deepEqual(await inFlight,{ok:false,reason:"superseded"});
  assert.deepEqual(await session.load(),{ok:false,reason:"not-ready"});
  assert.equal(session.resume(),true);
  assert.equal((await session.load()).ok,true);
  assert.equal(fake.calls.length,2,"a new open is a new server read");
});

test("dispose is final: later calls read nothing",async()=>{
  const fake=server(()=>json({note:note()}));
  const session=make("note","n1",fake);
  session.dispose();
  assert.equal((await session.load()).ok,false);
  assert.equal(session.resume(),false);
  assert.equal(fake.calls.length,0);
});

test("a newer load supersedes the older one: only the latest response is returned",async()=>{
  const releases=[];
  const fake=server(()=>new Promise(resolve=>releases.push(()=>resolve(json({note:note()})))));
  const session=make("note","n1",fake);
  const older=session.load();
  const newer=session.load();
  releases[0]?.();releases[1]?.();
  assert.deepEqual(await older,{ok:false,reason:"superseded"});
  assert.equal((await newer).ok,true);
});

test("every request is a no-store same-origin GET and nothing is persisted or logged",async()=>{
  const seen=[];
  const fake=server((_url,init)=>{seen.push(init);return json({note:note()});});
  await make("note","n1",fake).load();
  assert.equal(seen[0].method,"GET");
  assert.equal(seen[0].cache,"no-store");
  assert.equal(seen[0].credentials,"same-origin");
  assert.equal(seen[0].redirect,"error");
  for(const file of ["lib/target-detail-session.ts","lib/target-detail-route.ts","app/ui/target-detail-panel.tsx",
    "app/ui/target-detail-state.ts","app/ui/target-sidebar-projects.tsx"]){
    const source=read(file);
    assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|IndexedDB|document\.cookie|console\./,file);
    assert.doesNotMatch(source,/\bmethod:\s*"(POST|PUT|PATCH|DELETE)"/,file);
  }
});
