import assert from "node:assert/strict";
import {test} from "node:test";
import {
  buildNoteDeleteCommand,buildNoteEditCommand,buildTaskDeleteCommand,buildTaskTitleCommand,
  checkTaskTitleReceipt,dispatchNoteDelete,dispatchNoteEdit,dispatchTaskDelete,dispatchTaskTitle,
  readNoteWriteContext,readTaskWriteContext,validTaskTitle,validNoteTitle,validNoteBody,
  validWriteContext,validEditId,
}from "../lib/target-staging-edit-clients.ts";
import {
  ctx,fakeServer,json,GEN,REV,TASK,NOTE,STATUS_PREFLIGHT,TITLE,TITLE_RECEIPT,TASK_DELETE,
  TASK_DELETE_RECEIPT,NOTE_PREFLIGHT,NOTE_EDIT,NOTE_EDIT_RECEIPT,NOTE_DELETE,NOTE_DELETE_RECEIPT,
}from "./support/edit-fake-server.mjs";

test("preflight: GET, same-origin credentials, no-store, strict body, Area equality",async()=>{
  const server=fakeServer({[STATUS_PREFLIGHT]:()=>json(ctx())});
  const result=await readTaskWriteContext(TASK,"area1",server.fetchFake);
  assert.deepEqual(result,{ok:true,context:ctx()});
  const call=server.calls[0];
  assert.equal(call.method,"GET");
  assert.equal(call.search,"?taskId=task-1");
  assert.equal(call.init.credentials,"same-origin");
  assert.equal(call.init.cache,"no-store");
  assert.equal(call.init.redirect,"error");
  assert.equal(call.init.body,undefined);
});

test("preflight: wrong Area is a conflict; extra/missing keys, bad hex and bad uuid are invalid-response",async()=>{
  const run=(body)=>readTaskWriteContext(TASK,"area1",fakeServer({[STATUS_PREFLIGHT]:()=>json(body)}).fetchFake);
  assert.deepEqual(await run(ctx({writeAreaId:"other"})),{ok:false,reason:"conflict"});
  assert.deepEqual(await run({...ctx(),extra:1}),{ok:false,reason:"invalid-response"});
  assert.deepEqual(await run({expectedRevision:REV,writeAreaId:"area1"}),{ok:false,reason:"invalid-response"});
  assert.deepEqual(await run(ctx({expectedRevision:"xyz"})),{ok:false,reason:"invalid-response"});
  assert.deepEqual(await run(ctx({restoreGeneration:"nope"})),{ok:false,reason:"invalid-response"});
  assert.equal(validWriteContext(ctx()),true);
});

test("preflight: status codes map to calm reasons; 404 is 'not-available' (viewer, foreign, off)",async()=>{
  const map={401:"signed-out",403:"signed-out",404:"not-available",409:"conflict",429:"rate-limited",400:"invalid-request",503:"unavailable",500:"unavailable"};
  for(const [status,reason] of Object.entries(map)){
    const server=fakeServer({[STATUS_PREFLIGHT]:()=>json({error:"x"},Number(status))});
    assert.deepEqual(await readTaskWriteContext(TASK,"area1",server.fetchFake),{ok:false,reason},status);
  }
  const redirected=fakeServer({[STATUS_PREFLIGHT]:()=>{const r=json(ctx());Object.defineProperty(r,"redirected",{value:true});return r;}});
  assert.equal((await readTaskWriteContext(TASK,"area1",redirected.fetchFake)).reason,"invalid-response");
  const noStore=fakeServer({[STATUS_PREFLIGHT]:()=>new Response(JSON.stringify(ctx()),{headers:{"content-type":"application/json"}})});
  assert.equal((await readTaskWriteContext(TASK,"area1",noStore.fetchFake)).reason,"invalid-response");
  const network=async()=>{throw new TypeError("offline");};
  assert.equal((await readTaskWriteContext(TASK,"area1",network)).reason,"offline");
  const controller=new AbortController();controller.abort();
  assert.equal((await readTaskWriteContext(TASK,"area1",network,controller.signal)).reason,"aborted");
  assert.equal((await readTaskWriteContext("bad/id","area1",network)).reason,"invalid-request");
});

test("task title: exact request shape (PATCH, protocol header, six-field body without taskId)",async()=>{
  const server=fakeServer({[TITLE]:()=>json({ok:true})});
  const command=buildTaskTitleCommand(TASK,"New title",ctx(),"22222222-2222-4222-8222-222222222222");
  assert.ok(command);
  const result=await dispatchTaskTitle(command,server.fetchFake);
  assert.equal(result.kind,"committed");
  assert.equal(server.calls.length,1,"exactly one dispatch");
  const call=server.calls[0];
  assert.equal(call.method,"PATCH");
  assert.equal(call.path,"/api/target-staging/tasks/task-1/title");
  assert.equal(call.headers["x-lumi-target-protocol"],"1");
  assert.equal(call.headers["content-type"],"application/json");
  assert.equal(call.init.credentials,"same-origin");
  assert.equal(call.init.redirect,"error");
  assert.deepEqual(Object.keys(call.body).sort(),["commandId","expectedRevision","restoreGeneration","title","writeAreaId"]);
  assert.equal(call.body.expectedRevision,REV);
  assert.equal(call.body.commandId,"22222222-2222-4222-8222-222222222222");
  assert.equal(call.headers.origin,undefined,"Origin is set by the browser, never by the client");
});

test("dispatch: 409 and 400 are definitive refusals, 429 too; nothing is resent",async()=>{
  for(const [status,reason] of [[409,"conflict"],[400,"invalid-request"],[429,"rate-limited"]]){
    const server=fakeServer({[TITLE]:()=>json({error:"x"},status)});
    const command=buildTaskTitleCommand(TASK,"T",ctx());
    const result=await dispatchTaskTitle(command,server.fetchFake);
    assert.deepEqual(result,{kind:"rejected",reason},String(status));
    assert.equal(server.count(TITLE),1);
    assert.equal(server.count(TITLE_RECEIPT),0,"a definitive refusal needs no receipt");
  }
});

test("dispatch: ambiguous outcomes (network, 503, late 401/404, malformed 200) check the receipt and never resend",async()=>{
  const cases={
    network:()=>{throw new TypeError("net");},
    s503:()=>json({error:"x"},503),
    s401:()=>json({error:"x"},401),
    s404:()=>json({error:"x"},404),
    malformed:()=>new Response("not json",{status:200,headers:{"cache-control":"no-store","content-type":"application/json"}}),
    unknownBody:()=>json({ok:false}),
  };
  for(const [name,handler] of Object.entries(cases)){
    const server=fakeServer({[TITLE]:handler,[TITLE_RECEIPT]:()=>json({status:"committed"})});
    const command=buildTaskTitleCommand(TASK,"T",ctx());
    const result=await dispatchTaskTitle(command,server.fetchFake);
    assert.equal(result.kind,"committed",name+" confirmed by receipt");
    assert.equal(server.count(TITLE),1,name+" dispatched once");
    assert.equal(server.count(TITLE_RECEIPT),1,name);
    const receipt=server.calls.at(-1);
    assert.deepEqual(receipt.body,server.calls[0].body,"the receipt carries the exact original command");
  }
  for(const body of [{status:"not_recorded"},{status:"weird"},{extra:1}]){
    const server=fakeServer({[TITLE]:()=>json({error:"x"},503),[TITLE_RECEIPT]:()=>json(body)});
    const result=await dispatchTaskTitle(buildTaskTitleCommand(TASK,"T",ctx()),server.fetchFake);
    assert.equal(result.kind,"uncertain",JSON.stringify(body));
    assert.equal(server.count(TITLE),1);
  }
  const denied=fakeServer({[TITLE]:()=>json({error:"x"},503),[TITLE_RECEIPT]:()=>json({error:"x"},404)});
  assert.equal((await dispatchTaskTitle(buildTaskTitleCommand(TASK,"T",ctx()),denied.fetchFake)).kind,"uncertain");
});

test("dispatch: replayed success is committed; strict success body",async()=>{
  const replayed=fakeServer({[TITLE]:()=>json({ok:true,replayed:true})});
  const result=await dispatchTaskTitle(buildTaskTitleCommand(TASK,"T",ctx()),replayed.fetchFake);
  assert.deepEqual([result.kind,result.replayed],["committed",true]);
  const odd=fakeServer({[TITLE]:()=>json({ok:true,replayed:false}),[TITLE_RECEIPT]:()=>json({status:"not_recorded"})});
  assert.equal((await dispatchTaskTitle(buildTaskTitleCommand(TASK,"T",ctx()),odd.fetchFake)).kind,"uncertain");
});

test("an aborted dispatch is uncertain and never resent; an aborted-before dispatch is a rejection",async()=>{
  const controller=new AbortController();
  const server=fakeServer({[TITLE]:()=>{controller.abort();throw new DOMException("x","AbortError");}});
  const command=buildTaskTitleCommand(TASK,"T",ctx());
  assert.equal((await dispatchTaskTitle(command,server.fetchFake,controller.signal)).kind,"uncertain");
  assert.equal(server.count(TITLE),1);
  assert.equal(server.count(TITLE_RECEIPT),0);
  const done=new AbortController();done.abort();
  assert.deepEqual(await dispatchTaskTitle(command,server.fetchFake,done.signal),{kind:"rejected",reason:"aborted"});
});

test("receipt: POST with the original command; strict body",async()=>{
  const server=fakeServer({[TITLE_RECEIPT]:()=>json({status:"committed"})});
  const command=buildTaskTitleCommand(TASK,"T",ctx());
  assert.deepEqual(await checkTaskTitleReceipt(command,server.fetchFake),{kind:"committed"});
  assert.equal(server.calls[0].headers["x-lumi-target-protocol"],"1");
});

test("task delete: POST with a four-field body; note edit and note delete shapes",async()=>{
  const s1=fakeServer({[TASK_DELETE]:()=>json({ok:true}),[TASK_DELETE_RECEIPT]:()=>json({status:"committed"})});
  const del=buildTaskDeleteCommand(TASK,ctx());
  assert.equal((await dispatchTaskDelete(del,s1.fetchFake)).kind,"committed");
  assert.deepEqual(Object.keys(s1.calls[0].body).sort(),["commandId","expectedRevision","restoreGeneration","writeAreaId"]);
  assert.equal(s1.calls[0].method,"POST");

  const s2=fakeServer({[NOTE_EDIT]:()=>json({ok:true})});
  const edit=buildNoteEditCommand(NOTE,"Title","Body\nline",ctx());
  assert.equal((await dispatchNoteEdit(edit,s2.fetchFake)).kind,"committed");
  assert.equal(s2.calls[0].method,"PATCH");
  assert.deepEqual(Object.keys(s2.calls[0].body).sort(),["body","commandId","expectedRevision","restoreGeneration","title","writeAreaId"]);

  const s3=fakeServer({[NOTE_DELETE]:()=>json({ok:true})});
  const nd=buildNoteDeleteCommand(NOTE,ctx());
  assert.equal((await dispatchNoteDelete(nd,s3.fetchFake)).kind,"committed");
  assert.equal(s3.calls[0].method,"DELETE");
  assert.equal(s3.calls[0].path,"/api/target-staging/notes/note-1");

  const s4=fakeServer({[NOTE_PREFLIGHT]:()=>json(ctx())});
  assert.equal((await readNoteWriteContext(NOTE,"area1",s4.fetchFake)).ok,true);
  void NOTE_EDIT_RECEIPT;void NOTE_DELETE_RECEIPT;
});

test("ids are percent-encoded in paths; the body never carries the item id",async()=>{
  const id="task é/x";
  assert.equal(validEditId(id),false,"a path separator is refused");
  const ok="task é 1";
  const server=fakeServer({});
  const command=buildTaskTitleCommand(ok,"T",ctx());
  await dispatchTaskTitle(command,server.fetchFake);
  assert.match(server.calls[0].path,/\/tasks\/task é 1\/title$/);
  assert.equal("taskId" in server.calls[0].body,false);
});

test("validation: title and note rules mirror the routes; invalid commands are never built",()=>{
  assert.equal(validTaskTitle("ok"),true);
  for(const bad of ["","  pad ","a\0b","x".repeat(4097),"\ud800"])assert.equal(validTaskTitle(bad),false,JSON.stringify(bad).slice(0,10));
  assert.equal(validNoteTitle("  x"),true);
  assert.equal(validNoteTitle("   "),false);
  assert.equal(validNoteBody(""),true);
  assert.equal(validNoteBody("č".repeat(65536)),true);
  assert.equal(validNoteBody("č".repeat(65537)),false);
  assert.equal(buildTaskTitleCommand(TASK,"",ctx()),null);
  assert.equal(buildTaskTitleCommand("../x","T",ctx()),null);
  assert.equal(buildTaskTitleCommand(TASK,"T",{...ctx(),expectedRevision:"short"}),null);
  assert.equal(buildNoteEditCommand(NOTE,"T","b\0",ctx()),null);
  assert.equal(buildTaskDeleteCommand(TASK,{...ctx(),writeAreaId:"bad area"}),null);
});
