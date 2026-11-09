import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {queuedTargetFetch,targetReadQueueState} from "../lib/target-read-queue.ts";

const read=file=>readFileSync(path.join(import.meta.dirname,"..",file),"utf8");
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

function slowFetch(){
  let running=0,peak=0;
  const releases=[];
  const order=[];
  const impl=async url=>{
    order.push(String(url));
    running++;peak=Math.max(peak,running);
    await new Promise(resolve=>releases.push(resolve));
    running--;
    return new Response("{}");
  };
  return {impl,peak:()=>peak,release:()=>releases.shift()?.(),order,pending:()=>releases.length};
}

test("reads go one at a time in arrival order, so the server's 2-child limit is never exceeded",async()=>{
  const f=slowFetch();
  const q=queuedTargetFetch(f.impl);
  const all=[q("/a"),q("/b"),q("/c")];
  await tick();
  assert.deepEqual(f.order,["/a"]);
  assert.deepEqual(targetReadQueueState(),{active:1,waiting:2});
  f.release();await tick();
  assert.deepEqual(f.order,["/a","/b"]);
  f.release();await tick();f.release();
  await Promise.all(all);
  assert.deepEqual(f.order,["/a","/b","/c"]);
  assert.equal(f.peak(),1);
  assert.deepEqual(targetReadQueueState(),{active:0,waiting:0});
});

test("a newcomer cannot jump the queue while the slot is handed over",async()=>{
  const f=slowFetch();
  const q=queuedTargetFetch(f.impl);
  const first=q("/a"),second=q("/b");
  await tick();
  f.release();
  const third=q("/c"); // arrives exactly when /a finished
  await tick();
  assert.deepEqual(f.order,["/a","/b"]);
  f.release();await tick();f.release();
  await Promise.all([first,second,third]);
  assert.deepEqual(f.order,["/a","/b","/c"]);
});

test("a request aborted while waiting never reaches the network and frees its place",async()=>{
  const f=slowFetch();
  const q=queuedTargetFetch(f.impl);
  const first=q("/a");
  const controller=new AbortController();
  const waiting=q("/b",{signal:controller.signal});
  const after=q("/c");
  await tick();
  controller.abort();
  await assert.rejects(waiting);
  assert.deepEqual(targetReadQueueState(),{active:1,waiting:1});
  f.release();await tick();f.release();
  await Promise.all([first,after]);
  assert.deepEqual(f.order,["/a","/c"]);
  await assert.rejects(q("/d",{signal:controller.signal}),"an already aborted signal never starts");
  assert.deepEqual(targetReadQueueState(),{active:0,waiting:0});
});

test("a failing request releases the slot",async()=>{
  const q=queuedTargetFetch(async()=>{throw new TypeError("offline");});
  await assert.rejects(q("/a"));
  await assert.rejects(q("/b"));
  assert.deepEqual(targetReadQueueState(),{active:0,waiting:0});
});

test("detail, list and sidebar reads all share the queue",()=>{
  for(const file of ["app/ui/target-detail-panel.tsx","app/ui/target-scope-lists.tsx","app/ui/target-sidebar-projects.tsx"]){
    const source=read(file);
    assert.match(source,/const readFetch=queuedTargetFetch\(\);/,file);
    assert.match(source,/readFetch\)/,file);
  }
});
