import assert from "node:assert/strict";
import {test} from "node:test";
import {
  parseNotePreview,readStagingNotePreview,validNotePreviewId,
} from "../lib/target-staging-note-preview-client.ts";

const id="note-1";
const note={
  id,title:"Poznámka",body:"Soukromý obsah",projectId:null,
  areaId:"private-area",areaKind:"private",revision:2,
};
function response(payload={note},status=200,extra={}){
  return new Response(JSON.stringify(payload),{
    status,
    headers:{"cache-control":"no-store","content-type":"application/json",...extra},
  });
}
test("UI-09d exact note DTO and IDs reject forged metadata, wrong ID and oversized bodies",()=>{
  assert.deepEqual(parseNotePreview({note},id),note);
  for(const bad of [
    {note:{...note,id:"another"}},
    {note:{...note,actorUserId:"alice"}},
    {note:{...note,areaKind:"admin"}},
    {note:{...note,revision:-1}},
    {note:{...note,body:"x".repeat(131073)}},
    {note:{...note,title:"\ud800"}},
    {note:{...note,body:"\ud800"}},
    {note:{...note,projectId:".."}},
    {note:{...note,areaId:"\n"}},
    {note,linearization:"secret"},
  ])assert.equal(parseNotePreview(bad,id),null);
  for(const bad of ["", ".", "..", " bad", "bad ", "x\n", "\ud800", "x".repeat(513)])
    assert.equal(validNotePreviewId(bad),false);
  assert.equal(validNotePreviewId("note:a/b"),true);
});
test("UI-09d only explicitly initiated same-origin no-store GET renders allowed note",async()=>{
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    calls.push({url,opts});
    return response();
  };
  const ctrl=new AbortController();
  assert.deepEqual(await readStagingNotePreview(id,ctrl.signal,fetchImpl),{ok:true,note});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"/api/target-staging/notes/note-1");
  assert.equal(calls[0].opts.method,"GET");
  assert.equal(calls[0].opts.credentials,"same-origin");
  assert.equal(calls[0].opts.cache,"no-store");
  assert.equal(calls[0].opts.redirect,"error");
  assert.equal(calls[0].opts.signal,ctrl.signal);
  assert.equal(calls[0].opts.body,undefined);
});
test("UI-09d denied or changed notes never reveal existence or stale content",async()=>{
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],
    [404,"not-found"],[409,"stale"],[429,"rate-limited"],[503,"unavailable"]]){
    const result=await readStagingNotePreview(id,new AbortController().signal,
      async()=>response({error:"secret"},status));
    assert.deepEqual(result,{ok:false,reason});
    assert.equal(JSON.stringify(result).includes("secret"),false);
  }
});
test("UI-09d strict response boundaries reject wrong MIME, cache, size and payload",async()=>{
  for(const res of [
    response({note,linearization:"secret"}),
    response({note},200,{"cache-control":"private"}),
    response({note},200,{"content-type":"text/html"}),
    response({note},200,{"content-length":"1048577"}),
    response({note:{...note,body:"x".repeat(131073)}}),
    new Response("{bad",{status:200,headers:{"cache-control":"no-store","content-type":"application/json"}}),
  ]){
    const result=await readStagingNotePreview(id,new AbortController().signal,async()=>res);
    assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  }
});
test("UI-09d abort before headers, after start and stalled body fails closed",async()=>{
  const closed=new AbortController();closed.abort();
  let called=false;
  assert.deepEqual(await readStagingNotePreview(id,closed.signal,async()=>{
    called=true;return response();
  }),{ok:false,reason:"aborted"});
  assert.equal(called,false);
  const ctrl=new AbortController();
  let resolve;
  const pending=new Promise(r=>{resolve=r;});
  const result=readStagingNotePreview(id,ctrl.signal,()=>pending);
  ctrl.abort();
  assert.deepEqual(await result,{ok:false,reason:"aborted"});
  resolve(response());
  const stalled=new AbortController();
  const raw=new Response(new ReadableStream({start(){}}),{
    status:200,headers:{"cache-control":"no-store","content-type":"application/json"},
  });
  const read=readStagingNotePreview(id,stalled.signal,async()=>raw);
  stalled.abort();
  assert.deepEqual(await read,{ok:false,reason:"aborted"});
});
