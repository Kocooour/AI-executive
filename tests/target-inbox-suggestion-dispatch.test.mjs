import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {provisionInboxAIFenceSchema,recordExplicitInboxAIGrant,
  revokeInboxAIConsent,inboxAIRevokeDrained,readInboxAIFenceGrant}
  from "../lib/target-inbox-ai-consent-fence.ts";
import {dispatchAuthorizedInboxOpenAIOnly}
  from "../lib/target-inbox-suggestion-dispatch.ts";

const GEN="123e4567-e89b-42d3-a456-426614174000";
const scope="c3b:v1",actor="alice";
const choice={action:"project",targetName:"Rekonstrukce",reason:"mock"}; // no network
function fixture(){
  const db=new DatabaseSync(":memory:");
  assert.equal(provisionInboxAIFenceSchema(db),true);
  assert.equal(recordExplicitInboxAIGrant(db,actor,actor,GEN,scope,
    "owner-approved-v1")?.active,true);
  const state={actorUserId:actor,sessionAlive:true,
    consent:{version:1,actorUserId:actor,enabled:true,epoch:1,
      restoreGeneration:GEN,dataScopeVersion:scope,
      ownerDecision:"owner-approved-v1",decisionSource:"2026-11-19:#471",
      updatedAtMs:Date.now()},
    privateSnapshot:{taskId:"task1",taskRevision:1,triageRevision:0,
      restoreGeneration:GEN,taskWriteRevision:"a".repeat(64),
      candidateFingerprint:"b".repeat(64),
      personalWhenOn:null,personalWhenRevision:null,personalPlanEpoch:0,
      timeZone:"Europe/Prague",notificationEpoch:0,
      snapshot:{taskTitle:"Připravit Rekonstrukce",currentAreaId:"personal",
        currentProjectId:null,privateAreas:[
          {id:"personal",name:"Osobní",revision:0},
          {id:"kitchen",name:"Kuchyň",revision:0}],
        privateOpenProjects:[
          {id:"renovation",name:"Rekonstrukce",areaId:"kitchen",revision:0}]},
    },
  };
  return {db,state,close(){db.close();}};
}
const run=(x,provider,read=async()=>x.state)=>
  dispatchAuthorizedInboxOpenAIOnly({fenceDb:x.db,initial:x.state,
    deps:{freshAuthorizedState:read,complete:provider}});

test("C-3b dispatch: exact minimized prompt, OpenAI-only mock, no extra data",async()=>{
  const x=fixture();
  try{
    let called=0,reads=0;
    const out=await run(x,async(input,signal)=>{
      called++;
      assert.equal(signal.aborted,false);
      assert.deepEqual(input,{
        taskTitle:"Připravit Rekonstrukce",
        privateAreaNames:["Osobní","Kuchyň"],
        privateOpenProjectNames:["Rekonstrukce"]});
      return choice;
    },async()=>{reads++;return x.state;});
    assert.equal(out.source,"ai");
    assert.equal(out.changes.projectId,"renovation");
    assert.equal(called,1);
    assert.equal(reads,2,"session/ACL checked before dispatch and after response");
  }finally{x.close();}
});

test("C-3b dispatch: no consent or stale target snapshot => no provider request",async()=>{
  const x=fixture();
  try{
    let calls=0;
    const provider=async()=>{calls++;return choice;};
    x.state.consent.enabled=false;
    assert.equal((await run(x,provider)).source,"rule");
    x.state.consent.enabled=true;
    const original=x.state;
    assert.equal((await run(x,provider,async()=>({
      ...original,sessionAlive:false,
    })),null,"revoked session cannot release old private names");
    assert.equal((await run(x,provider,async()=>({
      ...original,privateSnapshot:{...original.privateSnapshot,
        candidateFingerprint:"c".repeat(64)},
    })),null,"stale actor-private snapshot cannot be released");
    assert.equal(calls,0);
  }finally{x.close();}
});

test("C-3b dispatch: revoke during provider stalls confirmation and discards late AI",async()=>{
  const x=fixture();
  try{
    let during;
    const out=await run(x,async()=>{
      during=revokeInboxAIConsent(x.db,actor);
      assert.equal(during.drained,false,
        "cannot confirm revoke while pending outbound ticket exists");
      assert.equal(inboxAIRevokeDrained(x.db,actor,during.epoch),false);
      return choice;
    });
    assert.equal(out.source,"rule");
    assert.equal(inboxAIRevokeDrained(x.db,actor,during.epoch),true);
    assert.equal(readInboxAIFenceGrant(x.db,actor).active,false);
  }finally{x.close();}
});

test("C-3b dispatch: concurrent per-actor backpressure and provider failure => rules",async()=>{
  const x=fixture();
  try{
    let start;
    const entered=new Promise(resolve=>{start=resolve;});
    let done;
    const pending=new Promise(resolve=>{done=resolve;});
    const first=run(x,async()=>{
      start();
      await pending;
      return choice;
    });
    await entered;
    let secondCalls=0;
    const second=await run(x,async()=>{secondCalls++;return choice;});
    assert.equal(second.source,"rule");
    assert.equal(secondCalls,0);
    done();
    assert.equal((await first).source,"ai");
    assert.equal((await run(x,async()=>{throw Error("mock 5xx");})).source,
      "rule");
  }finally{x.close();}
});

test("C-3b: explicit Today composes with AI success, 5xx and safe fallback",async()=>{
  const x=fixture();
  try{
    x.state.privateSnapshot.snapshot.taskTitle="Dnes připravit Rekonstrukce";
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Prague",
      year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const {inboxLocalDate}=await import("../lib/target-inbox-suggestion-commitment.ts");
    const date=inboxLocalDate(Date.now(),"Europe/Prague");
    const ai=await run(x,async()=>choice);
    assert.equal(ai.source,"ai");
    assert.equal(ai.changes.whenOn,date);
    const failed=await run(x,async()=>{throw Error("mock 5xx");});
    assert.equal(failed.source,"rule");
    assert.equal(failed.changes.whenOn,date);
    const invalid=await run(x,async()=>null);
    assert.equal(invalid.source,"rule");
    assert.equal(invalid.changes.whenOn,date);
    assert.equal(typeof today,"string");
  }finally{x.close();}
});

test("C-3b: failed post-provider authorization returns NO stale private suggestion",async()=>{
  const x=fixture();
  try{
    let reads=0;
    const out=await run(x,async()=>choice,async()=>{
      reads++;
      return reads===1?x.state:{...x.state,sessionAlive:false};
    });
    assert.equal(out,null);
    const changedActor=await run(x,async()=>{throw Error("mock fail");},
      async()=>({...x.state,actorUserId:"other"}));
    assert.equal(changedActor,null);
  }finally{x.close();}
});

test("C-3b: actor timezone or its revision changes during provider wait => no stale result",async()=>{
  const x=fixture();
  try{
    let reads=0;
    const out=await run(x,async()=>choice,async()=>{
      reads++;
      return reads===1?x.state:{...x.state,
        privateSnapshot:{...x.state.privateSnapshot,
          timeZone:"Europe/London",notificationEpoch:1}};
    });
    assert.equal(out,null);
  }finally{x.close();}
});
