import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {parsePrivateNoteAreaChoices,loadPrivateNoteAreaChoices} from
  "../lib/target-private-note-area-client.ts";
import {targetPrivateNoteAreaUiEnabled,TARGET_PRIVATE_NOTE_AREA_UI_FLAGS} from
  "../lib/target-private-note-area-ui-gate.ts";
import {MAX_SCOPED_READ_AREAS,MAX_PRIVATE_NOTE_AREA_CATALOG_BYTES} from
  "../lib/target-staging-read-limits.ts";
const response=(body,status=200,h={"content-type":"application/json","cache-control":"no-store"})=>
  new Response(JSON.stringify(body),{status,headers:h});
const areas=[{id:"area-a",title:"Osobní"},{id:"area-b",title:"Rodina"}];

test("the Area catalog accepts only bounded, ordered, precisely shaped private choices",()=>{
  assert.deepEqual(parsePrivateNoteAreaChoices({areas}),areas);
  const large=Array.from({length:101},(_,i)=>({
    id:"area-"+String(i).padStart(4,"0"),title:"X".repeat(4096),
  }));
  assert.deepEqual(parsePrivateNoteAreaChoices({areas:large}),large);
  const all=Array.from({length:MAX_SCOPED_READ_AREAS},(_,i)=>({
    id:"area-"+String(i).padStart(4,"0"),title:'"'.repeat(4096),
  }));
  assert.deepEqual(parsePrivateNoteAreaChoices({areas:all}),all);
  for(const invalid of [
    {},{areas:[],owner:"alice"},{areas:null},
    {areas:[areas[1],areas[0]]},{areas:[areas[0],areas[0]]},
    {areas:[{...areas[0],role:"admin"}]},
    {areas:[{id:" area-a",title:"F"}]},
    {areas:[{id:"area-a",title:"\0"}]},
    {areas:[{id:"area-a",title:"\ud800"}]},
    {areas:[{id:"area-a",title:"X".repeat(4097)}]},
    {areas:Array.from({length:MAX_SCOPED_READ_AREAS+1},(_,i)=>({
      id:"area-"+String(i).padStart(4,"0"),title:"X",
    }))},
  ])assert.equal(parsePrivateNoteAreaChoices(invalid),null,JSON.stringify(invalid).slice(0,150));
});

test("fetch is same-origin no-store and fails closed on response and network errors",async()=>{
  const abort=new AbortController();
  let count=0;
  const fetchImpl=async(url,options)=>{
    count++;assert.equal(url,"/api/target-staging/notes/create-targets");
    assert.equal(options.method,"GET");assert.equal(options.cache,"no-store");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.redirect,"error");assert.equal(options.signal,abort.signal);
    return response({areas});
  };
  assert.deepEqual(await loadPrivateNoteAreaChoices(abort.signal,fetchImpl),
    {ok:true,areas});
  assert.equal(count,1);
  const largeBody=Array.from({length:250},(_,i)=>({
    id:"area-"+String(i).padStart(4,"0"),title:"X".repeat(4096),
  }));
  assert.ok(JSON.stringify({areas:largeBody}).length>600_000);
  assert.deepEqual(await loadPrivateNoteAreaChoices(abort.signal,
    async()=>response({areas:largeBody})),{ok:true,areas:largeBody});
  const overCap=new Response("{}",{
    headers:{"content-type":"application/json","cache-control":"no-store",
      "content-length":String(MAX_PRIVATE_NOTE_AREA_CATALOG_BYTES+1)},
  });
  assert.deepEqual(await loadPrivateNoteAreaChoices(abort.signal,async()=>overCap),
    {ok:false,reason:"unavailable"});
  for(const [result,expected] of [
    [response({areas},401),"signed-out"],
    [response({areas},409),"stale"],
    [response({areas},404),"unavailable"],
    [response({areas},200,{"content-type":"text/plain","cache-control":"no-store"}),"invalid-response"],
    [response({areas},200,{"content-type":"application/json","cache-control":"private"}),"invalid-response"],
    [response({areas:[areas[1],areas[0]]}),"invalid-response"],
  ]){
    assert.deepEqual(await loadPrivateNoteAreaChoices(abort.signal,async()=>result),
      {ok:false,reason:expected});
  }
  abort.abort();
  assert.deepEqual(await loadPrivateNoteAreaChoices(abort.signal,fetchImpl),
    {ok:false,reason:"aborted"});
});

test("private chooser is separately default-off, and wires no note writes",()=>{
  const all=Object.fromEntries(TARGET_PRIVATE_NOTE_AREA_UI_FLAGS.map(flag=>[flag,"true"]));
  assert.equal(targetPrivateNoteAreaUiEnabled(all),true);
  for(const flag of TARGET_PRIVATE_NOTE_AREA_UI_FLAGS){
    assert.equal(targetPrivateNoteAreaUiEnabled({...all,[flag]:"TRUE"}),false,flag);
    assert.equal(targetPrivateNoteAreaUiEnabled({...all,[flag]:undefined}),false,flag);
  }
  const page=readFileSync("app/page.tsx","utf8");
  const root=readFileSync("app/ui/lumi-app-root.tsx","utf8");
  const chooser=readFileSync("app/ui/target-private-note-area-chooser.tsx","utf8");
  assert.match(page,/targetPrivateNoteAreas=/);
  assert.match(root,/scopeList==="note"&&targetPrivateNoteAreas/);
  assert.match(root,/TargetPrivateNoteAreaChooser/);
  assert.match(chooser,/useTargetGeneration|useTargetRuntime/);
  assert.match(chooser,/reportRefusal/);
  assert.doesNotMatch(chooser,/method:"POST"|sessionStorage|localStorage|indexedDB|submitCapture|createNote/);
});
