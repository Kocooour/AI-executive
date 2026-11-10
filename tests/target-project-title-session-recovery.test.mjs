import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {
  projectTitleReloadMarker,reserveProjectTitleReload,
  confirmProjectTitleReload,rejectFirstProjectTitleReload,
} from "../lib/target-project-title-reload.ts";
import {
  hasSealedProjectTitleEdit,resumeSealedProjectTitleEdit,forgetSealedProjectTitleEdit,
  runTrackedProjectTitleEdit,trackedProjectTitleEdit,
} from "../lib/target-project-title-edit-recovery.ts";
import {
  recoverProjectTitleReceipt,PROJECT_TITLE_RECEIPT_TIMEOUT_MS,
} from "../lib/target-project-title-receipt-client.ts";
import {
  saveProjectTitleEdit,
} from "../lib/target-staging-project-title-edit-client.ts";

const A="A".repeat(43),B="B".repeat(43),OTHER="C".repeat(43);
const CMD="f3d18d63-9073-48f7-8d25-6c81f23b9a01";
const PROJECT="project";
const STAGE="b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa";
const command={
  commandId:CMD,expectedRevision:"a".repeat(64),
  restoreGeneration:STAGE,writeAreaId:"owner-private",
  title:"Secret private project",
};
const preview={expectedRevision:command.expectedRevision,
  restoreGeneration:STAGE,writeAreaId:command.writeAreaId,principalBinding:A};
const data=new Map();
const original=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{
  getItem:key=>data.has(key)?data.get(key):null,
  setItem:(key,value)=>data.set(key,String(value)),
  removeItem:key=>data.delete(key),
}});
function runtime(){
  let generation=A,known=true,cleared=0;
  const disposables=new Set(),security=new Set();
  const clean=(reason)=>{
    for(const item of [...disposables])item.dispose(reason);
    disposables.clear();
  };
  return {
    generation:()=>generation,known:()=>known,
    register(item){disposables.add(item);return ()=>disposables.delete(item);},
    subscribeSecurityClear(fn){security.add(fn);return ()=>security.delete(fn);},
    expire(){generation="unknown-expired";known=false;clean("expired");},
    relogin(value){generation=value;known=true;clean("rotation");},
    securityReset(){generation="unknown-revoked";known=false;clean("reset");
      cleared++;for(const fn of [...security])fn();},
    reportRefusal(kind){if(kind!=="session_expired")throw Error("wrong refusal");
      this.expire();return Promise.resolve("signed_out");},
    get clearCount(){return cleared;},
  };
}
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(body,status=200)=>Response.json(body,{status,headers});
function clean(){data.clear();}
test("a project rename tab lock stores only UUID and opaque binding; no private content",()=>{
  clean();
  assert.deepEqual(projectTitleReloadMarker(A),{kind:"clear"});
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  assert.equal(reserveProjectTitleReload(B,CMD,A),true);
  assert.equal(reserveProjectTitleReload(B,"b3333333-3333-4333-8333-333333333333",A),false);
  const payload=[...data.values()].map(JSON.parse);
  assert.deepEqual(payload,[{generation:A,commandId:CMD,principalBinding:A}]);
  for(const forbidden of [command.title,PROJECT,command.writeAreaId,"expectedRevision"])
    assert.equal(JSON.stringify(payload).includes(forbidden),false);
  assert.deepEqual(projectTitleReloadMarker(B),{kind:"blocked",commandId:CMD,principalBinding:A},
    "new login must NEVER silently clear an unresolved write");
  assert.equal(confirmProjectTitleReload(CMD,OTHER),false);
  assert.equal(confirmProjectTitleReload(CMD,A),true);
  assert.deepEqual(projectTitleReloadMarker(B),{kind:"clear"});
});
test("expired in-flight command is sealed until fresh SERVER actor proof matches",async()=>{
  clean();const rt=runtime();
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  let sent;
  const first=runTrackedProjectTitleEdit(rt,A,PROJECT,command,
    async()=>{sent=true;return {outcome:"expired"};},100,A);
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.equal(sent,true);
  assert.equal(rt.known(),false);
  assert.equal(trackedProjectTitleEdit(rt,A,PROJECT),null);
  assert.equal(hasSealedProjectTitleEdit(rt,PROJECT),true);
  // New login rotates opaque auth generation but the actor proof can still
  // attest the SAME actor, same project and restore era.
  rt.relogin(B);
  assert.equal(resumeSealedProjectTitleEdit(rt,B,PROJECT,{...preview,principalBinding:OTHER}),"blocked");
  assert.equal(hasSealedProjectTitleEdit(rt,PROJECT),false);
  assert.deepEqual(projectTitleReloadMarker(B),{kind:"blocked",commandId:CMD,principalBinding:A});
  clean();
});
test("same actor may replay only exact old command after reauthentication",async()=>{
  clean();const rt=runtime();
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  await runTrackedProjectTitleEdit(rt,A,PROJECT,command,async()=>({outcome:"expired"}),100,A);
  rt.relogin(B);
  assert.equal(resumeSealedProjectTitleEdit(rt,B,PROJECT,preview),"resumed");
  assert.deepEqual(trackedProjectTitleEdit(rt,B,PROJECT),{command,phase:"uncertain"});
  const calls=[];
  assert.deepEqual(await runTrackedProjectTitleEdit(rt,B,PROJECT,
    {...command,commandId:"b3333333-3333-4333-8333-333333333333"},
    async()=>({outcome:"saved",replayed:false}),100,A),{outcome:"conflict"});
  assert.deepEqual(await runTrackedProjectTitleEdit(rt,B,PROJECT,command,
    async(id,original)=>{calls.push({id,original});return {outcome:"saved",replayed:true};},
    100,A),{outcome:"saved",replayed:true});
  assert.deepEqual(calls,[{id:PROJECT,original:command}]);
  assert.deepEqual(projectTitleReloadMarker(B),{kind:"clear"});
});
test("explicit revocation erases memory without unblocking an uncertain write",async()=>{
  clean();const rt=runtime();
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  await runTrackedProjectTitleEdit(rt,A,PROJECT,command,async()=>({outcome:"expired"}),100,A);
  assert.equal(hasSealedProjectTitleEdit(rt,PROJECT),true);
  rt.securityReset();
  assert.equal(hasSealedProjectTitleEdit(rt,PROJECT),false);
  rt.relogin(B);
  assert.equal(resumeSealedProjectTitleEdit(rt,B,PROJECT,preview),"missing");
  assert.deepEqual(projectTitleReloadMarker(B),{kind:"blocked",commandId:CMD,principalBinding:A});
  clean();
});
test("ACL downgrade and restore-generation mismatch cannot disclose the sealed title",async()=>{
  for(const invalid of [{...preview,writeAreaId:"another-area"},
     {...preview,restoreGeneration:"c169f26b-07a4-49c5-a4ca-3eb2d00c6f32"}]){
    clean();const rt=runtime();reserveProjectTitleReload(A,CMD,A);
    await runTrackedProjectTitleEdit(rt,A,PROJECT,command,async()=>({outcome:"expired"}),100,A);
    rt.relogin(B);
    assert.equal(resumeSealedProjectTitleEdit(rt,B,PROJECT,invalid),"blocked");
    assert.equal(hasSealedProjectTitleEdit(rt,PROJECT),false);
    assert.equal(projectTitleReloadMarker(B).kind,"blocked");
  }
  clean();
});
test("content-free receipt only clears on exact positive SAME-actor confirmation",async()=>{
  clean();reserveProjectTitleReload(A,CMD,A);
  const observed=[];
  const fetcher=async(url,opts)=>{
    observed.push({url,method:opts.method,body:opts.body,cache:opts.cache});
    return reply({status:"committed",principalBinding:A});
  };
  assert.deepEqual(await recoverProjectTitleReceipt(CMD,new AbortController().signal,fetcher),
    {status:"committed",principalBinding:A});
  assert.equal(confirmProjectTitleReload(CMD,OTHER),false);
  assert.equal(confirmProjectTitleReload(CMD,A),true);
  assert.deepEqual(observed,[{url:"/api/target-staging/project-title/recovery",method:"POST",
    body:JSON.stringify({commandId:CMD}),cache:"no-store"}]);
});
test("not-recorded, missing ACL, and malformed acknowledgements cannot clear a tab lock",async()=>{
  clean();reserveProjectTitleReload(A,CMD,A);
  for(const [expected,handler] of [
    ["not_recorded",async()=>reply({status:"not_recorded"})],
    ["denied",async()=>reply({error:"Not found"},404)],
    ["unavailable",async()=>reply({status:"committed",principalBinding:"broken"})],
    ["unavailable",async()=>reply({status:"committed",principalBinding:A,title:"secret"})],
  ]){
    const got=await recoverProjectTitleReceipt(CMD,new AbortController().signal,handler);
    assert.equal(got.status,expected);
    assert.equal(projectTitleReloadMarker(B).kind,"blocked");
  }
  clean();
});
test("receipt lookup timeout aborts even a fetch that ignores abort",async()=>{
  const start=Date.now();
  let signal;
  const got=await recoverProjectTitleReceipt(CMD,new AbortController().signal,
    async(_,opts)=>{signal=opts.signal;return new Promise(()=>{});},12);
  assert.deepEqual(got,{status:"unavailable"});
  assert.equal(signal.aborted,true);assert.ok(Date.now()-start<2000);
  assert.equal(PROJECT_TITLE_RECEIPT_TIMEOUT_MS,8000);
});
test("coded session_expired is not generic denial; malformed or wrong codes are denied",async()=>{
  const responses=[
    [{error:"Authentication required",code:"session_expired"},"expired"],
    [{error:"Authentication required",code:"session_revoked"},"denied"],
    [{error:"Authentication required",code:"session_restored"},"denied"],
    [{error:"Authentication required"},"denied"],
    [{error:"Authentication required",code:"session_expired",extra:"x"},"denied"],
  ];
  for(const [body,expected] of responses){
    const outcome=await saveProjectTitleEdit(PROJECT,command,new AbortController().signal,
      async()=>reply(body,401));
    assert.equal(outcome.outcome,expected);
  }
});
test("UI does not send principal proof as a command token and remains default-off",()=>{
  const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
  const editor=read("app/ui/target-project-title-editor.tsx");
  const gate=read("lib/target-project-title-edit-ui-gate.ts");
  assert.match(editor,/reserveProjectTitleReload\(bound\.current,command\.commandId,d\.preview\.principalBinding\)/);
  assert.match(editor,/resumeSealedProjectTitleEdit\(runtime,bound\.current,project\.id,result\.preview\)/);
  assert.match(editor,/confirmProjectTitleReload\(marker\.commandId,marker\.principalBinding\)/);
  assert.match(editor,/const command=d\.command\?\?\{expectedRevision:/);
  assert.match(gate,/return false;/);
  assert.doesNotMatch(editor,/sessionStorage\.setItem/);
});
