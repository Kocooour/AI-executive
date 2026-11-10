import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  parseNoteEditPreview,validNoteEditText,validNoteEditCommand,
  loadNoteEditPreview,saveNoteEdit,
} from "../lib/target-staging-note-edit-client.ts";
import {targetNoteEditUiEnabled,TARGET_NOTE_EDIT_UI_FLAGS} from "../lib/target-note-edit-ui-gate.ts";

const generation="b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa";
const preview={
  expectedRevision:"a".repeat(64),restoreGeneration:generation,writeAreaId:"personal-area",
};
const id="1dbe798b-8ae4-46a8-98ae-51ac73dd31b8";
const command={...preview,commandId:"f3d18d63-9073-48f7-8d25-6c81f23b9a01",
  title:"A note",body:"Some text"};
const reply=(data,status=200)=>Response.json(data,{
  status,headers:{"cache-control":"no-store"},
});
const signal=()=>new AbortController().signal;
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("R3-FE-4b: note edit is independently default-off even with enabled detail read",()=>{
  const flags=Object.fromEntries(TARGET_NOTE_EDIT_UI_FLAGS.map(name=>[name,"true"]));
  assert.equal(targetNoteEditUiEnabled({}),false);
  assert.equal(targetNoteEditUiEnabled(flags),true);
  for(const name of TARGET_NOTE_EDIT_UI_FLAGS){
    for(const value of [undefined,"1","TRUE","false",""]){
      assert.equal(targetNoteEditUiEnabled({...flags,[name]:value}),false,name);
    }
  }
  assert.match(read("app/page.tsx"),/targetNoteEditUiEnabled\(process\.env\)/);
  assert.match(read("app/ui/lumi-app-root.tsx"),/noteEdit=\{targetNoteEdit && detailGates\.note\}/);
  assert.match(read("app/ui/target-detail-panel.tsx"),/\(noteEdit\|\|Boolean\(edit\?\.flags\.noteEdit\)\)&&!edit\?\.deleted&&/);
  assert.match(read("app/ui/target-detail-panel.tsx"),/<TargetNoteEditor note=\{note\}/);
  assert.match(read("app/ui/target-note-editor.tsx"),/onCommitted\(\)/);
  assert.match(read("app/ui/target-note-editor.tsx"),/draft\.command\?\?/);
});

test("the preflight parser and command reject extra fields, forged values and unsafe content",()=>{
  assert.deepEqual(parseNoteEditPreview(preview),preview);
  assert.equal(parseNoteEditPreview({...preview,actorId:"bob"}),null);
  assert.equal(parseNoteEditPreview({...preview,expectedRevision:"wrong"}),null);
  assert.equal(parseNoteEditPreview({...preview,restoreGeneration:"bad"}),null);
  assert.equal(validNoteEditCommand(command),true);
  assert.equal(validNoteEditCommand({...command,writeAreaId:""}),false);
  assert.equal(validNoteEditCommand({...command,commandId:"a"}),false);
  assert.equal(validNoteEditCommand({...command,projectId:"shared"}),false);
  assert.equal(validNoteEditText("Test",""),true);
  assert.equal(validNoteEditText(" ","text"),false);
  assert.equal(validNoteEditText("OK","x".repeat(131073)),false);
  assert.equal(validNoteEditText("\uD800","body"),false);
});

test("GET preview is no-store, same-origin, exact-response-only and never trusts URL IDs",async()=>{
  const requests=[];
  const fetchImpl=async(url,init)=>{
    requests.push({url,init});
    return reply(preview);
  };
  assert.deepEqual(await loadNoteEditPreview(id,signal(),fetchImpl),{ok:true,preview});
  assert.deepEqual(requests.map(x=>x.url),["/api/target-staging/notes/"+id+"/edit"]);
  assert.equal(requests[0].init.method,"GET");
  assert.equal(requests[0].init.cache,"no-store");
  assert.equal(requests[0].init.credentials,"same-origin");
  assert.equal(requests[0].init.redirect,"error");
  assert.deepEqual(await loadNoteEditPreview("..",signal(),fetchImpl),{ok:false,reason:"denied"});
  assert.equal(requests.length,1);
  assert.deepEqual(await loadNoteEditPreview(id,signal(),async()=>reply({...preview,leak:"x"})),
    {ok:false,reason:"invalid-response"});
  assert.deepEqual(await loadNoteEditPreview(id,signal(),async()=>reply({error:"Not found"},404)),
    {ok:false,reason:"denied"});
  assert.deepEqual(await loadNoteEditPreview(id,signal(),async()=>new Response("{}",{
    headers:{"content-type":"application/json"},
  })),{ok:false,reason:"invalid-response"});
});

test("PATCH uses the exact command; ambiguous outcomes never count as success",async()=>{
  let seen;
  const fetchImpl=async(url,init)=>{
    seen={url,init};
    return reply({ok:true});
  };
  assert.deepEqual(await saveNoteEdit(id,command,signal(),fetchImpl),
    {outcome:"saved",replayed:false});
  assert.equal(seen.url,"/api/target-staging/notes/"+id+"/edit");
  assert.equal(seen.init.method,"PATCH");
  assert.equal(seen.init.credentials,"same-origin");
  assert.equal(seen.init.cache,"no-store");
  assert.equal(seen.init.headers["x-lumi-target-protocol"],"1");
  assert.deepEqual(JSON.parse(seen.init.body),command);
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>reply({ok:true,replayed:true})),
    {outcome:"saved",replayed:true});
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>reply({error:"Revision conflict"},409)),
    {outcome:"conflict"});
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>reply({error:"Not found"},404)),
    {outcome:"denied"});
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>reply({error:"Staging unavailable"},503)),
    {outcome:"uncertain"});
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>{throw Error("offline");}),
    {outcome:"uncertain"});
  assert.deepEqual(await saveNoteEdit(id,command,signal(),async()=>reply({ok:true,extra:"unexpected"})),
    {outcome:"uncertain"});
  assert.deepEqual(await saveNoteEdit(id,{...command,body:"\0"},signal(),fetchImpl),
    {outcome:"conflict"});
});
