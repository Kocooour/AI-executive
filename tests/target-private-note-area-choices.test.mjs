import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {parsePrivateNoteAreaChoices,loadPrivateNoteAreaChoices} from
  "../lib/target-private-note-area-client.ts";
import {targetPrivateNoteAreaUiEnabled,TARGET_PRIVATE_NOTE_AREA_UI_FLAGS} from
  "../lib/target-private-note-area-ui-gate.ts";
const response=(body,status=200,h={"content-type":"application/json","cache-control":"no-store"})=>
  new Response(JSON.stringify(body),{status,headers:h});
const areas=[{id:"area-a",title:"Osobní"},{id:"area-b",title:"Rodina"}];

test("the Area catalog accepts only bounded, ordered, precisely shaped private choices",()=>{
  assert.deepEqual(parsePrivateNoteAreaChoices({areas}),areas);
  for(const invalid of [
    {},{areas:[],owner:"alice"},{areas:null},
    {areas:[areas[1],areas[0]]},{areas:[areas[0],areas[0]]},
    {areas:[{...areas[0],role:"admin"}]},
    {areas:[{id:" area-a",title:"F"}]},
    {areas:[{id:"area-a",title:"\0"}]},
    {areas:[{id:"area-a",title:"\ud800"}]},
    {areas:Array.from({length:101},(_,i)=>({id:"area-"+i,title:"X"}))},
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
