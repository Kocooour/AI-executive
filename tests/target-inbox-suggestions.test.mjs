import test from "node:test";
import assert from "node:assert/strict";
import {
  foldInboxMatchText,validInboxSuggestionSnapshot,
  suggestInboxByRules,inboxAIAllowedInput,resolveInboxAIChoice,
  validInboxAIAllowedInput,validInboxAIChoice,parseInboxAIChoice,
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
const noChanges = {whenOn:"unchanged",projectId:"unchanged",
  taskAreaId:"unchanged",effectiveAreaId:"unchanged"};

test("C-3b local Today is actor-private and composes with exact project match",async()=>{
  const {suggestInboxWithLocalToday}=await import("../lib/target-inbox-suggestions.ts");
  const base=snapshot();
  const combined={...base,taskTitle:"Dnes připravit rekonstrukce"};
  const suggestion=suggestInboxWithLocalToday(combined,"2026-11-22");
  assert.equal(suggestion.changes.whenOn,"2026-11-22");
  assert.equal(suggestion.changes.projectId,"renovation");
  assert.equal(suggestion.changes.taskAreaId,null);
  assert.equal(suggestion.source,"rule");
  assert.equal(suggestInboxWithLocalToday(
    {...combined,taskTitle:"Dneska připravit rekonstrukce"},"2026-11-22")
    .changes.whenOn,"unchanged");
  assert.equal(suggestInboxWithLocalToday(combined,"2026-02-31")
    .changes.whenOn,"unchanged");
});

test("C-3b rules: stable NFC, case-insensitive whole-word matching without stripping accents",()=>{
  assert.equal(foldInboxMatchText("KUChYŇ"),"kuchyň");
  const s=snapshot({taskTitle:"připravit KUCHYŇ;"});
  assert.deepEqual(suggestInboxByRules(s).changes,
    {whenOn:"unchanged",projectId:"unchanged",
      taskAreaId:"kitchen",effectiveAreaId:"kitchen"});
  assert.deepEqual(suggestInboxByRules(snapshot({taskTitle:"kuchyňský nábytek"})).changes,noChanges);
  assert.deepEqual(suggestInboxByRules(snapshot({taskTitle:"Kuchyn"})).changes,noChanges);
  assert.deepEqual(suggestInboxByRules(snapshot()).changes,noChanges,
    "two matching Areas must not be selected by arbitrary order");
});

test("C-3b full Unicode case folding: German sharp S, NFC, Greek sigma and Cherokee",()=>{
  assert.equal(foldInboxMatchText("Straße"),foldInboxMatchText("STRASSE"));
  assert.equal(foldInboxMatchText("café"),foldInboxMatchText("café"));
  assert.equal(foldInboxMatchText("ΟΣ"),foldInboxMatchText("ος"));
  assert.equal(foldInboxMatchText("Ꭰ"),foldInboxMatchText("ꭰ"));
  assert.notEqual(foldInboxMatchText("Kuchyň"),foldInboxMatchText("Kuchyn"),
    "do not discard diacritics");
  assert.equal(suggestInboxByRules(snapshot({
    taskTitle:"připrav STRASSE",
    privateAreas:[
      {id:"personal",name:"Osobní",revision:1},
      {id:"street",name:"Straße",revision:2},
    ],privateOpenProjects:[],
  })).changes.taskAreaId,"street");
});

test("C-3b rules: an exact project match inherits only its authorized private Area",()=>{
  const s=snapshot({taskTitle:"REKONSTRUKCE: připravit nabídky"});
  const result=suggestInboxByRules(s);
  assert.equal(result.source,"rule");
  assert.deepEqual(result.changes,{whenOn:"unchanged",projectId:"renovation",
    taskAreaId:null,effectiveAreaId:"kitchen"});
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

test("C-3b shared AI validator rejects cross-kind and Unicode-equivalent labels",()=>{
  const acrossKinds=snapshot({
    taskTitle:"Oblast Kuchyň",
    privateOpenProjects:[
      {id:"same-project",name:"Kuchyň",areaId:"personal",revision:0},
    ],
  });
  const prompt=inboxAIAllowedInput(acrossKinds);
  assert.equal(validInboxAIAllowedInput(prompt),true);
  const projectChoice={action:"project",targetName:"Kuchyň",reason:"test"};
  assert.equal(validInboxAIChoice(prompt,projectChoice),false);
  assert.equal(parseInboxAIChoice(JSON.stringify(projectChoice),prompt),null);
  assert.equal(resolveInboxAIChoice(acrossKinds,projectChoice).source,"rule");

  const folded=snapshot({
    taskTitle:"STRASSE",
    privateAreas:[
      {id:"personal",name:"Osobní",revision:1},
      {id:"street",name:"Straße",revision:0},
    ],
    privateOpenProjects:[{id:"road",name:"STRASSE",areaId:"personal",revision:0}],
  });
  const foldedPrompt=inboxAIAllowedInput(folded);
  const foldedChoice={action:"area",targetName:"Straße",reason:"collision"};
  assert.equal(validInboxAIChoice(foldedPrompt,foldedChoice),false);
  assert.equal(resolveInboxAIChoice(folded,foldedChoice).source,"rule");
  assert.deepEqual(suggestInboxByRules(folded).changes,noChanges);
  assert.equal(validInboxAIAllowedInput({...prompt,metadata:"not permitted"}),false);
});

test("C-3b AI keep explains its decision independently of rule availability",()=>{
  const s=snapshot({taskTitle:"Kuchyň"});
  assert.equal(suggestInboxByRules(s).changes.taskAreaId,"kitchen");
  const ai=resolveInboxAIChoice(s,{action:"keep",targetName:null,reason:"untrusted provider prose"});
  assert.equal(ai.source,"ai");
  assert.deepEqual(ai.changes,noChanges);
  assert.match(ai.why,/AI doporučila ponechat/);
  assert.equal(ai.why.includes("untrusted provider prose"),false);
  assert.equal(ai.why.includes("nebyl nalezen"),false);
});

test("C-3b AI choices: names must resolve to one allowlisted target only",()=>{
  const s=snapshot({taskTitle:"Do zítřka nákup"});
  assert.deepEqual(resolveInboxAIChoice(s,{
    action:"project",targetName:"Rekonstrukce",reason:"suggestion",
  }).changes,{whenOn:"unchanged",projectId:"renovation",
    taskAreaId:null,effectiveAreaId:"kitchen"});
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

function openAIResponse(choice, status = 200, responseStatus = "completed",
    messageStatus = "completed") {
  return new Response(JSON.stringify({status:responseStatus,output:[{
    type:"message",role:"assistant",status:messageStatus,
    content:[{type:"output_text",text:JSON.stringify(choice)}],
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
    assert.equal(payload.store,false,"prevent OpenAI response-object persistence");
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
    const crossKind={...input,privateOpenProjectNames:["Kuchyň"]};
    globalThis.fetch=async()=>openAIResponse({
      action:"project",targetName:"Kuchyň",reason:"cross-kind collision",
    });
    assert.equal(await completeInboxOpenAIOnly(crossKind,new AbortController().signal),null);
    const folded={
      taskTitle:"check",
      privateAreaNames:["Straße"],
      privateOpenProjectNames:["STRASSE"],
    };
    globalThis.fetch=async()=>openAIResponse({
      action:"area",targetName:"Straße",reason:"Unicode fold collision",
    });
    assert.equal(await completeInboxOpenAIOnly(folded,new AbortController().signal),null);
    const duplicate={...input,privateOpenProjectNames:["Kuchyň","Kuchyň"]};
    globalThis.fetch=async()=>openAIResponse({
      action:"project",targetName:"Kuchyň",reason:"ambiguous",
    });
    assert.equal(await completeInboxOpenAIOnly(duplicate,new AbortController().signal),null);
  });
});

test("C-3b provider rejects incomplete, failed, cancelled and non-final Responses output",async()=>{
  await withMockProvider(async()=>{
    const input=inboxAIAllowedInput(snapshot());
    const validChoice={action:"project",targetName:"Rekonstrukce",reason:"exact"};
    const signal=new AbortController().signal;
    // A valid JSON classification inside HTTP 200 must never override an
    // incomplete, queued, cancelled or otherwise non-completed response.
    for(const responseStatus of ["incomplete","failed","cancelled","queued",
      "in_progress",null]) {
      globalThis.fetch=async()=>openAIResponse(validChoice,200,responseStatus);
      assert.equal(await completeInboxOpenAIOnly(input,signal),null,
        "response.status="+String(responseStatus));
    }
    // The parent response may be completed while its message is only partial.
    for(const messageStatus of ["incomplete","in_progress","failed",null]) {
      globalThis.fetch=async()=>openAIResponse(validChoice,200,"completed",messageStatus);
      assert.equal(await completeInboxOpenAIOnly(input,signal),null,
        "message.status="+String(messageStatus));
    }
    // Missing assistant role, missing status, or multiple messages are invalid.
    const completeMessage={type:"message",role:"assistant",status:"completed",
      content:[{type:"output_text",text:JSON.stringify(validChoice)}]};
    for(const malformed of [
      {output:[completeMessage]},
      {status:"completed",output:[{...completeMessage,role:"user"}]},
      {status:"completed",output:[{...completeMessage,role:undefined}]},
      {status:"completed",output:[completeMessage,completeMessage]},
      {status:"completed",output:[{...completeMessage,
        content:[...completeMessage.content,...completeMessage.content]}]},
    ]) {
      globalThis.fetch=async()=>new Response(JSON.stringify(malformed),
        {status:200,headers:{"content-type":"application/json"}});
      assert.equal(await completeInboxOpenAIOnly(input,signal),null);
    }
    // Completion can include a separate reasoning element but exactly one
    // final assistant message must supply the structured JSON.
    globalThis.fetch=async()=>new Response(JSON.stringify({
      status:"completed",output:[{type:"reasoning"},completeMessage],
    }),{status:200,headers:{"content-type":"application/json"}});
    assert.deepEqual(await completeInboxOpenAIOnly(input,signal),validChoice);
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
