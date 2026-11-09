import assert from "node:assert/strict";
import {test} from "node:test";
const {createTargetClientRuntime,TARGET_POLL_MS}=await import("../lib/target-client-runtime.ts");

const G1="A".repeat(43),G2="B".repeat(43);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<8;i++)await tick();};
class FakeTarget{
  listeners=new Map();
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,event={}){for(const fn of [...(this.listeners.get(type)??[])])fn(event);}
}
function fakeWindow(){
  const win=new FakeTarget();
  win.document=new FakeTarget();win.document.visibilityState="visible";
  win.navigator={onLine:true};
  return win;
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{
  "content-type":"application/json","cache-control":"no-store"}});
function setup(responses){
  const win=fakeWindow();
  const calls=[];const queue=[...responses];
  const intervals=new Map();let next=1;
  const timers={
    setInterval:(fn,ms)=>{const id=next++;intervals.set(id,{fn,ms});return id;},
    clearInterval:id=>{intervals.delete(id);},
  };
  const runtime=createTargetClientRuntime({
    fetch:async url=>{calls.push(url);const r=queue.length>1?queue.shift():queue[0];return r.clone();},
    window:win,broadcastChannelFactory:null,timers,now:()=>0,
  });
  const fire=()=>{for(const {fn} of [...intervals.values()])fn();};
  return {runtime,win,calls,intervals,fire};
}

test("poll: a 60 s interval is armed while visible and online, and revalidates",async()=>{
  const {runtime,calls,intervals,fire}=setup([json({generation:G1})]);
  await settle();
  assert.equal(TARGET_POLL_MS,60_000);
  assert.equal(intervals.size,1);
  assert.equal([...intervals.values()][0].ms,60_000);
  assert.equal(calls.length,1);
  fire();await settle();
  assert.equal(calls.length,2,"a tick sends one session check");
  runtime.dispose();
});

test("poll: never while hidden or offline; resumes when visible and online again",async()=>{
  const {runtime,win,calls,intervals,fire}=setup([json({generation:G1})]);
  await settle();
  win.document.visibilityState="hidden";win.document.emit("visibilitychange");
  assert.equal(intervals.size,0);
  fire();await settle();
  assert.equal(calls.length,1,"nothing fires while hidden");
  win.document.visibilityState="visible";win.document.emit("visibilitychange");
  assert.equal(intervals.size,1);
  win.navigator.onLine=false;win.emit("offline");
  assert.equal(intervals.size,0);
  win.navigator.onLine=true;win.emit("online");
  assert.equal(intervals.size,1);
  win.emit("pagehide");
  assert.equal(intervals.size,0);
  win.emit("pageshow",{persisted:false});
  assert.equal(intervals.size,1);
  runtime.dispose();
});

test("poll: a tick that finds the page hidden does not fetch and disarms",async()=>{
  const {runtime,win,calls,intervals,fire}=setup([json({generation:G1})]);
  await settle();
  win.document.visibilityState="hidden"; // no event delivered yet
  fire();await settle();
  assert.equal(calls.length,1);
  assert.equal(intervals.size,0);
  runtime.dispose();
});

test("poll: stops on dispose and never fires afterwards",async()=>{
  const {runtime,calls,intervals,fire}=setup([json({generation:G1})]);
  await settle();
  runtime.dispose();
  assert.equal(intervals.size,0);
  fire();await settle();
  assert.equal(calls.length,1);
});

test("poll: a 401 on a tick drops the generation and disposes registered sessions",async()=>{
  const {runtime,fire}=setup([json({generation:G1}),json({},401)]);
  await settle();
  const log=[];
  runtime.register({dispose:()=>log.push("dispose")});
  assert.equal(runtime.known(),true);
  fire();await settle();
  assert.equal(runtime.known(),false);
  assert.equal(runtime.lastOutcome(),"signed_out");
  assert.deepEqual(log,["dispose"]);
  runtime.dispose();
});

test("poll: no window (tests, SSR) arms nothing",async()=>{
  let armed=0;
  const runtime=createTargetClientRuntime({
    fetch:async()=>json({generation:G1}),window:null,broadcastChannelFactory:null,
    timers:{setInterval:()=>{armed++;return 1;},clearInterval:()=>{}},
  });
  await settle();
  assert.equal(armed,0);
  runtime.dispose();
});
