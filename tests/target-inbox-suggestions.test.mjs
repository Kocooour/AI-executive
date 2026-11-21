import test from "node:test";
import assert from "node:assert/strict";
import {
  foldInboxMatchText,validInboxSuggestionSnapshot,
  suggestInboxByRules,inboxAIAllowedInput,resolveInboxAIChoice,
} from "../lib/target-inbox-suggestions.ts";
import {completeInboxOpenAIOnly} from "../lib/server-ai-provider.ts";

const snapshot = (overrides = {}) => ({
  taskTitle:"Zkontrolovat Kuchyň a Zahrada",
  currentAreaId:"personal",
  currentProjectId:null,
  privateAreas:[
    {id:"personal",name:"Osobní",revision:1},
    {id:"kitchen",name:"Kuchyň",revision:2},
    {id:"garden",name:"Zahrada",revision:3},
  ],
  privateOpenProjects:[
    {id:"renovation",name:"Rekonstrukce",areaId:"kitchen",revision:4},
  ],
  ...overrides,
});
const noChanges = {whenOn:"unchanged",projectId:"unchanged",areaId:"unchanged"};

test("C-3b rules: stable NFC, case-insensitive whole-word matching without stripping accents",()=>{
  assert.equal(foldInboxMatchText("KUChYŇ"),"kuchyň");
  const s=snapshot({taskTitle:"připravit KUCHYŇ;"});
  assert.deepEqual(suggestInboxByRules(s).changes,
    {whenOn:"unchanged",projectId:"unchanged",areaId:"kitchen"});
  assert.deepEqual(suggestInboxByRules(snapshot({taskTitle:"kuchyňský nábytek"})).changes,noChanges);
  assert.deepEqual(suggestInboxByRules(snapshot({taskTitle:"Kuchyn"})).changes,noChanges);
  assert.deepEqual(suggestInboxByRules(snapshot()).changes,noChanges,
    "two matching Areas must not be selected by arbitrary order");
});

test("C-3b rules: an exact project match inherits only its authorized private Area",()=>{
  const s=snapshot({taskTitle:"REKONSTRUKCE: připravit nabídky"});
  const result=suggestInboxByRules(s);
  assert.equal(result.source,"rule");
  assert.deepEqual(result.changes,{whenOn:"unchanged",projectId:"renovation",areaId:"kitchen"});
  assert.match(result.why,/Rekonstrukce/);
  assert.deepEqual(suggestInboxByRules(snapshot({
    taskTitle:"Kuchyň",
    currentProjectId:"renovation",
    currentAreaId:"kitchen",
  })).changes,noChanges,"do not implicitly detach a task from its project");
});

test("C-3b rules: duplicate names, bad revisions and unknown project Area fail safe",()=>{
  assert.deepEqual(suggestInboxByRules(snapshot({
    taskTitle:"Kuchyň",
    privateAreas:[...snapshot().privateAreas,{id:"other",name:"Kuchyň",revision:3}],
  })).changes,noChanges);
  assert.equal(validInboxSuggestionSnapshot(snapshot({
    privateOpenProjects:[{id:"foreign",name:"Foreign",areaId:"shared",revision:0}],
  })),false);
  assert.deepEqual(suggestInboxByRules(snapshot({
    privateOpenProjects:[{id:"foreign",name:"Foreign",areaId:"shared",revision:0}],
  })).changes,noChanges);
  assert.equal(validInboxSuggestionSnapshot(snapshot({privateAreas:[]})),false);
});

test("C-3b AI inputs contain only task title and actor-private Area/open-project names",()=>{
  const input=inboxAIAllowedInput(snapshot());
  assert.deepEqual(Object.keys(input),[
    "taskTitle","privateAreaNames","privateOpenProjectNames",
  ]);
  assert.deepEqual(input.privateAreaNames,["Osobní","Kuchyň","Zahrada"]);
  assert.deepEqual(input.privateOpenProjectNames,["Rekonstrukce"]);
  assert.equal(JSON.stringify(input).includes("renovation"),false);
  assert.equal(JSON.stringify(input).includes("personal"),false);
  assert.equal(inboxAIAllowedInput(snapshot({privateAreas:[]})),null);
});

test("C-3b: punctuated or emoji project names remain valid AI candidates but are not fuzzy rule matches",()=>{
  const s=snapshot({
    taskTitle:"Panthers Praha",
    privateOpenProjects:[
      {id:"club",name:"Panthers/Praha",areaId:"personal",revision:1},
      {id:"weather",name:"Zahrada ☀",areaId:"garden",revision:1},
    ],
  });
  assert.equal(validInboxSuggestionSnapshot(s),true);
  assert.deepEqual(inboxAIAllowedInput(s).privateOpenProjectNames,["Panthers/Praha","Zahrada ☀"]);
  assert.deepEqual(suggestInboxByRules(s).changes,noChanges);
  assert.equal(resolveInboxAIChoice(s,{
    action:"project",targetName:"Panthers/Praha",reason:"exact allowlist",
  }).changes.projectId,"club");
});

test("C-3b AI choices: names must resolve to one allowlisted target only",()=>{
  const s=snapshot({taskTitle:"Do zítřka nákup"});
  assert.deepEqual(resolveInboxAIChoice(s,{
    action:"project",targetName:"Rekonstrukce",reason:"suggestion",
  }).changes,{whenOn:"unchanged",projectId:"renovation",areaId:"kitchen"});
  for(const targetName of ["Foreign","reKonstrukce",null]) {
    assert.equal(resolveInboxAIChoice(s,{
      action:"project",targetName,reason:"suggestion",
    }).source,"rule");
  }
  assert.equal(resolveInboxAIChoice(s,{
    action:"keep",targetName:null,reason:"safe",
  }).source,"ai");
  assert.equal(resolveInboxAIChoice(s,{
    action:"area",targetName:"Osobní",reason:"safe",
  }).source,"rule","do not manufacture an update to the current Area");
  const duplicate=snapshot({
    taskTitle:"Other",
    privateOpenProjects:[
      {id:"a",name:"Dup",areaId:"personal",revision:0},
      {id:"b",name:"Dup",areaId:"garden",revision:0},
    ],
  });
  assert.equal(resolveInboxAIChoice(duplicate,{
    action:"project",targetName:"Dup",reason:"duplicate",
  }).source,"rule");
});

function openAIResponse(choice, status = 200) {
  return new Response(JSON.stringify({output:[{
    type:"message",content:[{type:"output_text",text:JSON.stringify(choice)}],
  }]}),{status,headers:{"content-type":"application/json"}});
}
async function withMockProvider(handler) {
  const oldFetch=globalThis.fetch;
  const oldKey=process.env.OPENAI_API_KEY;
  const oldProvider=process.env.AI_PROVIDER;
  const oldModel=process.env.OPENAI_MODEL;
  try {
    process.env.OPENAI_API_KEY="fake-test-key";
    process.env.AI_PROVIDER="hermes";
    process.env.OPENAI_MODEL="test-model";
    return await handler();
  } finally {
    globalThis.fetch=oldFetch;
    if(oldKey===undefined)delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=oldKey;
    if(oldProvider===undefined)delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER=oldProvider;
    if(oldModel===undefined)delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL=oldModel;
  }
}

test("C-3b OpenAI-only ignores AI_PROVIDER=hermes; sends strictly minimized prompt",async()=>{
  await withMockProvider(async()=>{
    const calls=[];
    globalThis.fetch=async(url,options)=>{
      calls.push({url,options});
      return openAIResponse({action:"project",targetName:"Rekonstrukce",reason:"exact"});
    };
    const input=inboxAIAllowedInput(snapshot());
    const result=await completeInboxOpenAIOnly(input,new AbortController().signal);
    assert.deepEqual(result,{action:"project",targetName:"Rekonstrukce",reason:"exact"});
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,"https://api.openai.com/v1/responses");
    assert.equal(calls[0].options.signal.aborted,false);
    const payload=JSON.parse(calls[0].options.body);
    assert.equal(payload.model,"test-model");
    assert.equal(payload.text.format.type,"json_schema");
    assert.equal(payload.text.format.strict,true);
    assert.deepEqual(JSON.parse(payload.input[1].content),{
      taskTitle:input.taskTitle,
      privateAreaNames:input.privateAreaNames,
      privateOpenProjectNames:input.privateOpenProjectNames,
    });
    assert.equal(payload.input[1].content.includes("renovation"),false);
    assert.equal(payload.input[1].content.includes("personal"),false);
  });
});

test("C-3b provider rejects out-of-list, ambiguous, malformed and failed responses",async()=>{
  await withMockProvider(async()=>{
    const input=inboxAIAllowedInput(snapshot());
    for(const reply of [
      {action:"project",targetName:"Shared",reason:"no"},
      {action:"area",targetName:"Rekonstrukce",reason:"wrong kind"},
      {action:"keep",targetName:"Kuchyň",reason:"bad"},
      {action:"project",targetName:"Rekonstrukce",reason:"ok",secret:"extra"},
    ]) {
      globalThis.fetch=async()=>openAIResponse(reply);
      assert.equal(await completeInboxOpenAIOnly(input,new AbortController().signal),null);
    }
    globalThis.fetch=async()=>openAIResponse({action:"keep",targetName:null,reason:"safe"},503);
    assert.equal(await completeInboxOpenAIOnly(input,new AbortController().signal),null);
    globalThis.fetch=async()=>new Response("{not-json",{status:200});
    assert.equal(await completeInboxOpenAIOnly(input,new AbortController().signal),null);
    const duplicate={...input,privateOpenProjectNames:["Kuchyň","Kuchyň"]};
    globalThis.fetch=async()=>openAIResponse({
      action:"project",targetName:"Kuchyň",reason:"ambiguous",
    });
    assert.equal(await completeInboxOpenAIOnly(duplicate,new AbortController().signal),null);
  });
});

test("C-3b missing key / already revoked or cancelled signals never dispatch",async()=>{
  await withMockProvider(async()=>{
    let count=0;
    globalThis.fetch=async()=>{count++;throw Error("should not reach provider");};
    const input=inboxAIAllowedInput(snapshot());
    delete process.env.OPENAI_API_KEY;
    assert.equal(await completeInboxOpenAIOnly(input,new AbortController().signal),null);
    process.env.OPENAI_API_KEY="fake-test-key";
    const cancelled=new AbortController();cancelled.abort();
    assert.equal(await completeInboxOpenAIOnly(input,cancelled.signal),null);
    assert.equal(count,0);
  });
});

test("C-3b in-flight cancellation discards a late provider result",async()=>{
  await withMockProvider(async()=>{
    const controller=new AbortController();
    let reached=false;
    globalThis.fetch=async(_url,options)=>{
      reached=true;
      return await new Promise((_resolve,reject)=>{
        options.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});
      });
    };
    const result=completeInboxOpenAIOnly(inboxAIAllowedInput(snapshot()),controller.signal);
    controller.abort();
    assert.equal(await result,null);
    assert.equal(reached,true);
  });
});
