import assert from "node:assert/strict";
import {test} from "node:test";
const {createTargetClientRuntime,TARGET_SESSION_ENDPOINT,TARGET_SESSION_CHANNEL}=
  await import("../lib/target-client-runtime.ts");
const {createAttentionSession}=await import("../lib/target-staging-attention-session.ts");
const {createGlobalIndexReadSession}=await import("../lib/target-staging-global-index-read-session.ts");

const G1="A".repeat(43),G2="B".repeat(43),G3="C".repeat(43);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<8;i++)await tick();};

class FakeTarget{
  listeners=new Map();
  addEventListener(type,fn){
    if(!this.listeners.has(type))this.listeners.set(type,new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,event={}){for(const fn of [...(this.listeners.get(type)??[])])fn(event);}
  count(){let n=0;for(const set of this.listeners.values())n+=set.size;return n;}
}
function fakeWindow(){
  const win=new FakeTarget();
  win.document=new FakeTarget();
  win.document.visibilityState="visible";
  win.navigator={onLine:true};
  return win;
}
class FakeChannel{
  static all=[];
  constructor(name){this.name=name;this.closed=false;this.onmessage=null;FakeChannel.all.push(this);}
  post(data){this.onmessage?.({data});}
  close(){this.closed=true;}
}
function json(body,status=200,extra={}){
  return new Response(JSON.stringify(body),{status,headers:{
    "content-type":"application/json","cache-control":"no-store",...extra}});
}
function setup(responses,options={}){
  FakeChannel.all=[];
  const win=options.win??fakeWindow();
  const calls=[];
  const queue=[...responses];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});
    const next=queue.length>1?queue.shift():queue[0];
    return typeof next==="function"?next(url,init):next.clone();
  };
  let clock=1000;
  const runtime=createTargetClientRuntime({
    fetch:fetchImpl,window:win,
    broadcastChannelFactory:name=>new FakeChannel(name),
    now:()=>clock,...options.config,
  });
  return {runtime,win,calls,advance:ms=>{clock+=ms;},channel:()=>FakeChannel.all[0]};
}
const disposable=()=>{
  const log=[];
  return {log,dispose:()=>log.push("dispose"),suspend:()=>log.push("suspend"),
    resume:()=>log.push("resume")};
};

test("initial refresh is a strict same-origin no-store GET and sets the generation",async()=>{
  const {runtime,calls}=setup([json({generation:G1})]);
  assert.equal(runtime.generation(),"");
  assert.equal(runtime.known(),false);
  await settle();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,TARGET_SESSION_ENDPOINT);
  assert.equal(calls[0].url,"/api/target-staging/session");
  assert.equal(calls[0].init.method,"GET");
  assert.equal(calls[0].init.credentials,"same-origin");
  assert.equal(calls[0].init.cache,"no-store");
  assert.equal(runtime.generation(),G1);
  assert.equal(runtime.known(),true);
  runtime.dispose();
});

test("a changed generation notifies subscribers and disposes every registered session",async()=>{
  const {runtime}=setup([json({generation:G1}),json({generation:G1}),json({generation:G2})]);
  await settle();
  const a=disposable(),b=disposable();
  runtime.register(a);runtime.register(b);
  let notified=0;
  runtime.subscribe(()=>notified++);
  assert.equal(await runtime.refresh(),"ok");
  assert.deepEqual([a.log,b.log,notified],[[],[],0]);
  assert.equal(await runtime.refresh(),"ok");
  assert.equal(runtime.generation(),G2);
  assert.deepEqual(a.log,["dispose"]);
  assert.deepEqual(b.log,["dispose"]);
  assert.equal(notified,1);
  // Disposed sessions are no longer registered: no second dispose.
  const c=disposable();
  const unregister=runtime.register(c);
  unregister();
  runtime.dispose();
  assert.deepEqual(c.log,[]);
});

test("a throwing disposable does not stop the others",async()=>{
  const {runtime}=setup([json({generation:G1}),json({generation:G2})]);
  await settle();
  const ok=disposable();
  runtime.register({dispose(){throw new Error("x");}});
  runtime.register(ok);
  await runtime.refresh();
  assert.deepEqual(ok.log,["dispose"]);
  runtime.dispose();
});

test("signed-out broadcast disposes immediately and old sessions go terminal",async()=>{
  const fetches=[];
  const {runtime,channel}=setup([json({generation:G1})]);
  await settle();
  assert.equal(channel().name,TARGET_SESSION_CHANNEL);
  const attention=createAttentionSession({
    areaFilter:"all",view:"active",limit:10,contextVersion:runtime.generation,
    fetch:async(...args)=>{fetches.push(args);throw new Error("no network");},
  });
  const index=createGlobalIndexReadSession({scope:"all",contextVersion:runtime.generation},
    async(...args)=>{fetches.push(args);throw new Error("no network");});
  runtime.register(attention);runtime.register(index);
  assert.equal(attention.getSnapshot().status,"idle");
  assert.equal(index.getSnapshot().status,"idle");
  const before=runtime.generation();
  channel().post("signed-out");
  // Synchronous: no refresh needed.
  assert.notEqual(runtime.generation(),before);
  assert.match(runtime.generation(),/^unknown-/);
  assert.equal(runtime.known(),false);
  assert.equal(attention.getSnapshot().status,"disposed");
  assert.equal(index.getSnapshot().status,"disposed");
  // Sessions that were NOT registered still become terminal-stale.
  const loose=createAttentionSession({
    areaFilter:"all",view:"active",limit:10,contextVersion:()=>before});
  void loose;
  assert.deepEqual(fetches,[]);
  runtime.dispose();
});

test("unregistered sessions pinned to the old generation turn stale (A to B to A is terminal)",async()=>{
  const {runtime,channel}=setup([json({generation:G1}),json({generation:G1})]);
  await settle();
  const attention=createAttentionSession({
    areaFilter:"all",view:"active",limit:10,contextVersion:runtime.generation});
  const index=createGlobalIndexReadSession({scope:"all",contextVersion:runtime.generation},
    async()=>{throw new Error("no network");});
  channel().post("signed-out");
  assert.deepEqual(attention.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(index.getSnapshot(),{status:"failed",reason:"stale"});
  // Even if the server later reports the old value again, they stay terminal.
  await runtime.refresh();
  assert.equal(runtime.generation(),G1);
  assert.deepEqual(attention.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(index.getSnapshot(),{status:"failed",reason:"stale"});
  runtime.dispose();
});

test("an in-flight refresh started before a signed-out broadcast cannot revive the old generation",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {runtime,channel}=setup([async()=>{await gate;return json({generation:G1});}]);
  await tick();
  channel().post("signed-out");
  const unknown=runtime.generation();
  release();
  await settle();
  assert.equal(runtime.generation(),unknown);
  runtime.dispose();
});

test("hidden, pagehide and offline suspend; visible, pageshow and online resume without data fetches",async()=>{
  const {runtime,win,calls,advance}=setup([json({generation:G1})]);
  await settle();
  const item=disposable();
  runtime.register(item);
  const dataFetches=[];
  const index=createGlobalIndexReadSession({scope:"all",contextVersion:runtime.generation},
    async(...args)=>{dataFetches.push(args);throw new Error("must not fetch");});
  runtime.register(index);
  const baseline=calls.length;

  win.document.visibilityState="hidden";
  win.document.emit("visibilitychange");
  assert.deepEqual(item.log,["suspend"]);
  assert.equal(index.getSnapshot().status,"suspended");
  win.document.visibilityState="visible";
  advance(2000);
  win.document.emit("visibilitychange");
  assert.deepEqual(item.log,["suspend","resume"]);
  assert.equal(index.getSnapshot().status,"idle");

  win.emit("pagehide",{persisted:true});
  assert.equal(item.log.at(-1),"suspend");
  // pageshow resumes and verifies after BFCache restore.
  win.emit("pageshow",{persisted:true});
  assert.equal(item.log.at(-1),"resume");

  win.navigator.onLine=false;
  win.emit("offline");
  assert.equal(item.log.at(-1),"suspend");
  // Visible again but still offline: no resume.
  win.document.emit("visibilitychange");
  assert.equal(item.log.at(-1),"suspend");
  win.navigator.onLine=true;
  win.emit("online");
  assert.equal(item.log.at(-1),"resume");
  await settle();
  assert.deepEqual(dataFetches,[]);
  // Only session-endpoint requests happened.
  assert.ok(calls.length>baseline);
  assert.ok(calls.every(call=>call.url===TARGET_SESSION_ENDPOINT));
  // A session registered while suspended is suspended at once.
  win.emit("pagehide");
  const late=disposable();
  runtime.register(late);
  assert.deepEqual(late.log,["suspend"]);
  runtime.dispose();
});

test("visibility, focus, pageshow and online trigger a refresh (focus burst is throttled)",async()=>{
  const {runtime,win,calls,advance}=setup([json({generation:G1})]);
  await settle();
  assert.equal(calls.length,1);
  advance(5000);
  win.emit("focus");win.document.emit("visibilitychange");win.emit("focus");
  await settle();
  assert.equal(calls.length,2);
  advance(5000);
  win.emit("pageshow",{persisted:false});
  await settle();
  assert.equal(calls.length,3);
  win.emit("pageshow",{persisted:true});
  await settle();
  assert.equal(calls.length,4);
  win.emit("online");
  await settle();
  assert.equal(calls.length,5);
  runtime.dispose();
});

test("concurrent refreshes coalesce into at most one follow-up request",async()=>{
  let n=0;
  const {runtime,calls}=setup([async()=>{n++;await tick();return json({generation:G1});}]);
  const results=await Promise.all([runtime.refresh(),runtime.refresh(),runtime.refresh()]);
  assert.deepEqual(results,["ok","ok","ok"]);
  assert.ok(calls.length<=2,String(calls.length));
  runtime.dispose();
});

test("reportRefusal bumps to unknown, then refreshes",async()=>{
  const {runtime}=setup([json({generation:G1}),json({generation:G2})]);
  await settle();
  const item=disposable();
  runtime.register(item);
  const before=runtime.generation();
  const pending=runtime.reportRefusal("session_revoked");
  assert.match(runtime.generation(),/^unknown-/);
  assert.deepEqual(item.log,["dispose"]);
  assert.equal(await pending,"ok");
  assert.equal(runtime.generation(),G2);
  assert.notEqual(runtime.generation(),before);
  runtime.dispose();
});

test("401 and 403 refresh results are signed_out and leave an unknown generation; 404 and 5xx never keep data bound",async()=>{
  for(const status of [401,403]){
    const {runtime}=setup([json({generation:G1}),json({error:"x"},status)]);
    await settle();
    const item=disposable();runtime.register(item);
    assert.equal(await runtime.refresh(),"signed_out");
    assert.match(runtime.generation(),/^unknown-/);
    assert.deepEqual(item.log,["dispose"]);
    // Repeated refusals do not churn the value.
    const stable=runtime.generation();
    await runtime.refresh();
    assert.equal(runtime.generation(),stable);
    runtime.dispose();
  }
  const off=setup([json({generation:G1}),json({error:"Not found"},404)]);
  await settle();
  assert.equal(await off.runtime.refresh(),"unavailable");
  assert.match(off.runtime.generation(),/^unknown-/);
  off.runtime.dispose();
  const flaky=setup([json({generation:G1}),json({error:"x"},503)]);
  await settle();
  assert.equal(await flaky.runtime.refresh(),"unavailable");
  assert.equal(flaky.runtime.generation(),G1);
  flaky.runtime.dispose();
  const network=setup([json({generation:G1}),()=>{throw new TypeError("offline");}]);
  await settle();
  assert.equal(await network.runtime.refresh(),"unavailable");
  assert.equal(network.runtime.generation(),G1);
  network.runtime.dispose();
});

test("the generation DTO is strict",async()=>{
  const bad=[
    json({generation:G1,extra:1}),json({generation:"short"}),json({generation:5}),
    json({generation:G1+"="}),json([G1]),json(null),json({}),
    new Response("not json",{status:200,headers:{
      "content-type":"application/json","cache-control":"no-store"}}),
    json({generation:G1},200,{"cache-control":"max-age=60"}),
    json({generation:G1},200,{"content-type":"text/html"}),
    new Response(JSON.stringify({generation:G1,pad:"x".repeat(5000)}),{status:200,headers:{
      "content-type":"application/json","cache-control":"no-store"}}),
  ];
  for(const response of bad){
    const {runtime}=setup([response]);
    assert.equal(await runtime.refresh(),"unavailable");
    await settle();
    assert.equal(runtime.generation(),"");
    assert.equal(runtime.known(),false);
    runtime.dispose();
  }
});

test("no persistence API is touched and nothing is logged",async()=>{
  const touched=[];
  const traps=["localStorage","sessionStorage","indexedDB","caches"];
  const saved=new Map();
  for(const name of traps){
    saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,get(){touched.push(name);return undefined;}});
  }
  const logs=[];
  const realLog=console.log,realError=console.error,realWarn=console.warn;
  console.log=console.error=console.warn=(...args)=>logs.push(args);
  try{
    const {runtime,win,channel}=setup([json({generation:G1}),json({generation:G2})]);
    await settle();
    win.emit("pageshow",{persisted:true});await settle();
    channel().post("signed-out");
    runtime.dispose();
  }finally{
    console.log=realLog;console.error=realError;console.warn=realWarn;
    for(const [name,descriptor] of saved){
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  }
  assert.deepEqual(touched,[]);
  assert.deepEqual(logs,[]);
});

test("dispose removes every listener, closes the channel and stops refreshing",async()=>{
  const {runtime,win,calls,channel}=setup([json({generation:G1})]);
  await settle();
  assert.ok(win.count()+win.document.count()>=6);
  const item=disposable();
  runtime.register(item);
  runtime.dispose();
  assert.equal(win.count(),0);
  assert.equal(win.document.count(),0);
  assert.equal(channel().closed,true);
  assert.equal(channel().onmessage,null);
  assert.deepEqual(item.log,["dispose"]);
  const before=calls.length;
  win.emit("focus");win.emit("online");channel().post("signed-out");
  assert.equal(await runtime.refresh(),"unavailable");
  await settle();
  assert.equal(calls.length,before);
  // Registering after dispose disposes at once; dispose is idempotent.
  const late=disposable();
  runtime.register(late);
  assert.deepEqual(late.log,["dispose"]);
  runtime.dispose();
});

test("works without a window or BroadcastChannel",async()=>{
  const calls=[];
  const runtime=createTargetClientRuntime({
    window:null,broadcastChannelFactory:null,
    fetch:async(url)=>{calls.push(url);return json({generation:G3});},
  });
  await settle();
  assert.equal(runtime.generation(),G3);
  assert.deepEqual(calls,[TARGET_SESSION_ENDPOINT]);
  runtime.dispose();
});

test("cache-control must carry an exact no-store directive",async()=>{
  for(const cc of ["no-store-x","max-age=0, no-store-v2","nostore"]){
    const {runtime}=setup([json({generation:G1},200,{"cache-control":cc})]);
    await settle();
    assert.equal(runtime.known(),false,cc);
    runtime.dispose();
  }
  const {runtime}=setup([json({generation:G1},200,{"cache-control":"private, No-Store"})]);
  await settle();
  assert.equal(runtime.generation(),G1);
  runtime.dispose();
});
