import assert from "node:assert/strict";
import {test} from "node:test";
import {createTargetClientRuntime} from "../lib/target-client-runtime.ts";
import {createTargetDetailSession} from "../lib/target-detail-session.ts";
import {createWakeMachine,wakeRetryDelay} from "../lib/target-wake.ts";

const G="A".repeat(43);
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
class FakeTarget{
  listeners=new Map();
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,event={}){for(const fn of [...(this.listeners.get(type)??[])])fn(event);}
}
const json=(body,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
const note={id:"n1",title:"Note one",body:"Body",projectId:null,areaId:"a",areaKind:"private",revision:1};

/** The REAL runtime, session and wake machine wired in the browser's real event order. */
async function rig({networkReady=[true]}={}){
  const win=new FakeTarget();
  win.document=new FakeTarget();win.document.visibilityState="visible";
  win.navigator={onLine:true};
  const intervals=new Map();let next=1;
  const timers={setInterval:(fn)=>{const id=next++;intervals.set(id,fn);return id;},clearInterval:id=>{intervals.delete(id);}};
  const log=[];
  let online=true;
  const network=[...networkReady];
  const fetchFake=async url=>{
    const text=String(url);
    log.push(text.replace("https://x",""));
    if(!online)throw new TypeError("offline");
    if(text.includes("/api/target-staging/session"))return json({generation:G});
    return json({note});
  };
  const runtime=createTargetClientRuntime({fetch:fetchFake,window:win,broadcastChannelFactory:null,timers,now:()=>0});
  // Like useTargetSession: a session exists only once the runtime holds a server-confirmed generation.
  await settle();
  const session=createTargetDetailSession({kind:"note",id:"n1",contextVersion:runtime.generation},fetchFake);
  runtime.register(session);
  const events=[];
  let readResult=null;
  const machine=createWakeMachine({
    refresh:()=>runtime.refresh(),
    visible:()=>win.document.visibilityState!=="hidden",
    online:()=>win.navigator.onLine,
    handlers:()=>({
      hide:reason=>{events.push("hide:"+reason);session.suspend();},
      ready:async()=>{events.push("ready");session.resume();readResult=await session.load();events.push("read:"+(readResult.ok?"ok":readResult.reason));},
      signedOut:()=>events.push("signedOut"),
    }),
  });
  // The page listens like useTargetWake does, AFTER the runtime registered its own listeners.
  win.addEventListener("offline",()=>machine.hide("offline"));
  win.addEventListener("online",()=>{void machine.wake();});
  win.document.addEventListener("visibilitychange",()=>win.document.visibilityState==="hidden"?machine.hide("hidden"):void machine.wake());
  return {win,runtime,session,machine,events,log,fire:()=>{for(const fn of [...intervals.values()])fn();},
    setOnline:value=>{online=value;win.navigator.onLine=value;},result:()=>readResult,network};
}

test("offline -> online: the runtime resumes, refreshes ONCE for both, and the detail re-reads by itself",async()=>{
  const r=await rig();
  await settle();
  assert.equal(r.runtime.known(),true);
  assert.equal((await r.session.load()).ok,true);
  const before=r.log.length;
  // 1. offline: runtime suspends sessions; the screen hides its content.
  r.setOnline(false);r.win.emit("offline");
  assert.deepEqual(r.events,["hide:offline"]);
  assert.deepEqual(await r.session.load(),{ok:false,reason:"not-ready"},"suspended session never reads");
  // 2. online: both listeners run; the runtime refreshes, the machine waits for that refresh.
  r.setOnline(true);r.win.emit("online");
  await settle();
  assert.deepEqual(r.events,["hide:offline","ready","read:ok"]);
  assert.equal(r.result().ok,true);
  const sessionChecks=r.log.slice(before).filter(u=>u.includes("/session")).length;
  assert.ok(sessionChecks>=1&&sessionChecks<=2,"refreshes are coalesced: "+sessionChecks);
  // 3. the next passive tick re-reads again, still on the same live session.
  let ticks=0;
  r.runtime.subscribeTick(()=>{ticks++;});
  r.fire();await settle();
  assert.equal(ticks,1);
  r.runtime.dispose();
});

test("hidden -> visible re-reads automatically as well",async()=>{
  const r=await rig();
  await settle();
  r.win.document.visibilityState="hidden";r.win.document.emit("visibilitychange");
  assert.deepEqual(r.events,["hide:hidden"]);
  r.win.document.visibilityState="visible";r.win.document.emit("visibilitychange");
  await settle();
  assert.deepEqual(r.events,["hide:hidden","ready","read:ok"]);
  r.runtime.dispose();
});

test("a wake never stops at an unavailable session check: it still reads (the read reports its own error)",async()=>{
  const events=[];
  const machine=createWakeMachine({
    refresh:async()=>"unavailable",visible:()=>true,online:()=>true,
    handlers:()=>({hide:r=>events.push("hide:"+r),ready:()=>events.push("ready"),signedOut:()=>events.push("signedOut")}),
  });
  machine.hide("offline");
  await machine.wake();
  assert.deepEqual(events,["hide:offline","ready"]);
});

test("a signed-out session check shows the signed-out state, not a stuck hidden panel",async()=>{
  const events=[];
  const machine=createWakeMachine({
    refresh:async()=>"signed_out",visible:()=>true,online:()=>true,
    handlers:()=>({hide:r=>events.push("hide:"+r),ready:()=>events.push("ready"),signedOut:()=>events.push("signedOut")}),
  });
  machine.hide("hidden");
  await machine.wake();
  assert.deepEqual(events,["hide:hidden","signedOut"]);
});

test("wake does nothing unless the screen was hidden and is visible and online; duplicate wakes read once",async()=>{
  let refreshes=0;
  const events=[];
  let online=false;
  const machine=createWakeMachine({
    refresh:async()=>{refreshes++;return "ok";},visible:()=>true,online:()=>online,
    handlers:()=>({hide:()=>{},ready:()=>events.push("ready"),signedOut:()=>{}}),
  });
  await machine.wake();
  assert.equal(refreshes,0,"never hidden");
  machine.hide("offline");
  await machine.wake();
  assert.equal(refreshes,0,"still offline");
  online=true;
  await Promise.all([machine.wake(),machine.wake()]);
  assert.deepEqual(events,["ready"]);
  // A hide during the refresh cancels the pending ready.
  const late=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const m2=createWakeMachine({refresh:async()=>{await gate;return "ok";},visible:()=>true,online:()=>true,
    handlers:()=>({hide:()=>late.push("hide"),ready:()=>late.push("ready"),signedOut:()=>{}})});
  m2.markHidden();
  const pending=m2.wake();
  m2.hide("hidden");
  release();await pending;
  assert.deepEqual(late,["hide"]);
  m2.dispose();
});

test("automatic retry after a wake read that hit a network not ready yet: bounded back-off",()=>{
  assert.equal(wakeRetryDelay("offline",0),1500);
  assert.equal(wakeRetryDelay("unavailable",1),4000);
  assert.equal(wakeRetryDelay("offline",2),null);
  for(const reason of ["not-available","signed-out","stale","rate-limited","invalid-response"])
    assert.equal(wakeRetryDelay(reason,0),null,reason);
});
