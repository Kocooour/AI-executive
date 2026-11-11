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
  setProjectTitleDraft,projectTitleDraft,hasSealedProjectTitleDraft,resumeSealedProjectTitleDraft,
} from "../lib/target-project-title-edit-recovery.ts";
import {
  recoverProjectTitleReceipt,PROJECT_TITLE_RECEIPT_TIMEOUT_MS,
} from "../lib/target-project-title-receipt-client.ts";
import {
  saveProjectTitleEdit,
} from "../lib/target-staging-project-title-edit-client.ts";
import {cancelProjectTitleReload} from "../lib/target-project-title-cancel-client.ts";

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
  restoreGeneration:STAGE,writeAreaId:command.writeAreaId,principalBinding:A,currentTitle:"Before"};
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
  assert.deepEqual(projectTitleReloadMarker(A,A),{kind:"clear"});
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  assert.equal(reserveProjectTitleReload(B,CMD,A),true);
  assert.equal(reserveProjectTitleReload(B,"b3333333-3333-4333-8333-333333333333",A),false);
  const payload=[...data.values()].map(JSON.parse);
  assert.deepEqual(payload,[{version:2,entries:[{commandId:CMD,principalBinding:A}]}]);
  for(const forbidden of [command.title,PROJECT,command.writeAreaId,"expectedRevision"])
    assert.equal(JSON.stringify(payload).includes(forbidden),false);
  assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"blocked",commandId:CMD,principalBinding:A},
    "new login must NEVER silently clear an unresolved write");
  assert.equal(confirmProjectTitleReload(CMD,OTHER),false);
  assert.equal(confirmProjectTitleReload(CMD,A),true);
  assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"clear"});
});
test("legacy single-marker storage fails closed without actor proof",()=>{
 clean();data.set("lumi-target-project-title-unresolved-v1",
   JSON.stringify({generation:A,commandId:CMD,principalBinding:A}));
 assert.deepEqual(projectTitleReloadMarker(B),{kind:"unavailable"});
 assert.equal(projectTitleReloadMarker(B,OTHER).kind,"clear");
 assert.equal(projectTitleReloadMarker(B,A).kind,"blocked");
 assert.equal(confirmProjectTitleReload(CMD,A),true);
 clean();
});
test("other actor can proceed without disclosing or deleting previous actor's lock",()=>{
 clean();reserveProjectTitleReload(A,CMD,A);
 const another="b3333333-3333-4333-8333-333333333333";
 assert.deepEqual(projectTitleReloadMarker(B),{kind:"unavailable"});
 assert.deepEqual(projectTitleReloadMarker(B,OTHER),{kind:"clear"});
 assert.equal(reserveProjectTitleReload(B,another,OTHER),true);
 assert.equal(projectTitleReloadMarker(B,OTHER).kind,"blocked");
 assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"blocked",commandId:CMD,principalBinding:A});
 assert.equal(confirmProjectTitleReload(another,OTHER),true);
 assert.equal(projectTitleReloadMarker(B,A).kind,"blocked");
 assert.equal(confirmProjectTitleReload(CMD,A),true);
 clean();
});
test("canonical FIRST 404 rejection releases a tab lock and allows a different project",async()=>{
  clean();
  const rt=runtime();
  const otherId="another-project",otherCommand={...command,
    commandId:"b3333333-3333-4333-8333-333333333333",title:"Rename second project"};
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  const first=await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
    (id,cmd,signal)=>saveProjectTitleEdit(id,cmd,signal,
      async()=>reply({error:"Not found"},404)),100,A);
  assert.deepEqual(first,{outcome:"denied",definitiveNoWrite:true});
  assert.deepEqual(projectTitleReloadMarker(A,A),{kind:"clear"},
    "an authenticated, exact first pre-COMMIT refusal must not strand the tab");
  assert.equal(reserveProjectTitleReload(A,otherCommand.commandId,A),true);
  let calls=0;
  const next=await runTrackedProjectTitleEdit(rt,A,otherId,otherCommand,
    async()=>{calls++;return {outcome:"saved",replayed:false};},100,A);
  assert.deepEqual(next,{outcome:"saved",replayed:false});
  assert.equal(calls,1);
  assert.deepEqual(projectTitleReloadMarker(A,A),{kind:"clear"});
  clean();rt.securityReset();
});
test("canonical first 403 origin refusal is definitive but non-canonical denials are not",async()=>{
  for(const [status,body,expected] of [
    [403,{error:"Cross-origin request rejected"},true],
    [404,{error:"Not found"},true],
    [404,{error:"Not found",other:"extra"},false],
    [403,{error:"Authentication required"},false],
    [401,{error:"Authentication required"},false],
  ]){
    clean();const rt=runtime();
    assert.equal(reserveProjectTitleReload(A,CMD,A),true);
    const result=await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
      (id,cmd,signal)=>saveProjectTitleEdit(id,cmd,signal,
        async()=>reply(body,status)),100,A);
    assert.equal(result.outcome,"denied");
    assert.equal(projectTitleReloadMarker(A,A).kind,expected?"clear":"blocked",
      `first refusal ${status} should ${expected?"release":"retain"} the tab marker`);
    rt.securityReset();
  }
  clean();
});
test("a later 403/404/409 after an uncertain PATCH never releases its tab lock",async()=>{
  for(const [status,body] of [
    [403,{error:"Cross-origin request rejected"}],
    [404,{error:"Not found"}],
    [409,{error:"Revision conflict"}],
  ]){
    clean();const rt=runtime();
    assert.equal(reserveProjectTitleReload(A,CMD,A),true);
    assert.deepEqual(await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
      async()=>({outcome:"uncertain"}),100,A),{outcome:"uncertain"});
    const response=await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
      (id,cmd,signal)=>saveProjectTitleEdit(id,cmd,signal,
        async()=>reply(body,status)),100,A);
    assert.ok(["denied","conflict"].includes(response.outcome));
    assert.deepEqual(projectTitleReloadMarker(A,A),{kind:"blocked",commandId:CMD,principalBinding:A},
      `second ${status} must never release an earlier ambiguous commit`);
    assert.equal(reserveProjectTitleReload(A,"b3333333-3333-4333-8333-333333333333",A),false);
    rt.securityReset();
  }
  clean();
});
test("malformed first 400 cannot release an uncertain rename marker",async()=>{
 clean();const rt=runtime();
 assert.equal(reserveProjectTitleReload(A,CMD,A),true);
 assert.deepEqual(await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
   (id,cmd,signal)=>saveProjectTitleEdit(id,cmd,signal,async()=>reply({},400)),100,A),
   {outcome:"uncertain"});
 assert.equal(projectTitleReloadMarker(A,A).kind,"blocked");
 clean();rt.securityReset();
});
test("malformed first 409 cannot release an uncertain rename marker",async()=>{
  clean();const rt=runtime();
  assert.equal(reserveProjectTitleReload(A,CMD,A),true);
  const result=await runTrackedProjectTitleEdit(rt,A,PROJECT,command,
    (id,cmd,signal)=>saveProjectTitleEdit(id,cmd,signal,async()=>reply({},409)),100,A);
  assert.deepEqual(result,{outcome:"uncertain"});
  assert.equal(projectTitleReloadMarker(A,A).kind,"blocked");
  clean();rt.securityReset();
});
test("unsent draft is sealed on expiry and only resumes after same actor proof",()=>{
  clean();const rt=runtime();
  const draft={original:"Before",title:"Unsent private draft",writeAreaId:command.writeAreaId,
    expectedRevision:command.expectedRevision,restoreGeneration:STAGE,principalBinding:A};
  setProjectTitleDraft(rt,A,PROJECT,draft);
  rt.expire();
  assert.equal(projectTitleDraft(rt,A,PROJECT),null);
  assert.equal(hasSealedProjectTitleDraft(rt,PROJECT),true);
  rt.relogin(B);
  assert.equal(resumeSealedProjectTitleDraft(rt,B,PROJECT,{...preview,principalBinding:OTHER}),"blocked");
  assert.equal(hasSealedProjectTitleDraft(rt,PROJECT),false);
  const second=runtime();setProjectTitleDraft(second,A,PROJECT,draft);second.expire();second.relogin(B);
  assert.equal(resumeSealedProjectTitleDraft(second,B,PROJECT,preview),"resumed");
  assert.deepEqual(projectTitleDraft(second,B,PROJECT),draft);
  second.securityReset();clean();
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
  assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"blocked",commandId:CMD,principalBinding:A});
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
  assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"clear"});
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
  assert.deepEqual(projectTitleReloadMarker(B,A),{kind:"blocked",commandId:CMD,principalBinding:A});
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
    assert.equal(projectTitleReloadMarker(B,A).kind,"blocked");
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
    assert.equal(projectTitleReloadMarker(B,A).kind,"blocked");
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
  assert.match(gate,/TARGET_PROJECT_TITLE_EDIT_UI_FLAGS\.every\(flag=>env\[flag\]==='true'\)/);
  assert.doesNotMatch(editor,/sessionStorage\.setItem/);
});

// The browser never clears a marker from a missing receipt, a bad proxy reply,
// a denial or a truncated JSON confirmation.
test("cancel acknowledgements must be exact, bounded no-store JSON",async()=>{
  const signal=new AbortController().signal;
  const good=async()=>reply({status:"cancelled",principalBinding:A});
  assert.equal(await cancelProjectTitleReload(PROJECT,CMD,STAGE,A,signal,good),"cancelled");
  const committed=async()=>reply({status:"committed",principalBinding:A});
  assert.equal(await cancelProjectTitleReload(PROJECT,CMD,STAGE,A,signal,committed),"committed");
  for(const answer of [
    reply({status:"not_recorded",principalBinding:A}),
    reply({status:"cancelled",principalBinding:OTHER}),
    reply({status:"cancelled",principalBinding:A,extra:1}),
    Response.json({status:"cancelled",principalBinding:A},{headers:{"cache-control":"private"}}),
    Response.json({status:"cancelled",principalBinding:A},{status:503,headers}),
  ])assert.equal(await cancelProjectTitleReload(PROJECT,CMD,STAGE,A,signal,
      async()=>answer),"unavailable");
});

test("cancel transport times out and retains the unresolved marker when fetch ignores abort",async()=>{
 clean();reserveProjectTitleReload(A,CMD,A);
 let seen;
 const status=await cancelProjectTitleReload(PROJECT,CMD,STAGE,A,
   new AbortController().signal,async(_,init)=>{seen=init.signal;return new Promise(()=>{});},12);
 assert.equal(status,"unavailable");
 assert.equal(seen.aborted,true);
 assert.equal(projectTitleReloadMarker(A,A).kind,"blocked");
 clean();
});
