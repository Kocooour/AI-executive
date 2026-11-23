import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {inboxLocalDate,sealInboxDisplayedAction,unsealInboxDisplayedAction}
  from "../lib/target-inbox-suggestion-commitment.ts";

const NOW=Date.parse("2026-11-22T11:00:00Z");
const GEN="123e4567-e89b-42d3-a456-426614174000";
const KEY=randomBytes(32);
const changes={whenOn:"unchanged",projectId:"renovation",
  taskAreaId:null,effectiveAreaId:"kitchen"};
const base=(overrides={})=>({
  actorUserId:"owner",taskId:"task1",sessionTokenHash:"a".repeat(64),
  restoreGeneration:GEN,candidateFingerprint:"b".repeat(64),
  taskWriteRevision:"c".repeat(64),taskRevision:6,triageRevision:0,
  personalPlanEpoch:3,personalWhenRevision:null,notificationEpoch:2,
  consentEpoch:4,dataScopeVersion:"c3b:v1",localDate:"2026-11-22",
  timeZone:"Europe/Prague",
  suggestion:{source:"ai",changes,why:"AI navrhla soukromý projekt."},
  ...overrides,
});
const expectOf=(p)=>({
  actorUserId:p.actorUserId,taskId:p.taskId,
  sessionTokenHash:p.sessionTokenHash,restoreGeneration:p.restoreGeneration,
  displayedChanges:p.suggestion.changes,displayedWhy:p.suggestion.why,
});

test("C-3b token: one exact displayed project action is encrypted and actor/session-bound",()=>{
  const p=base();
  const token=sealInboxDisplayedAction(p,KEY,NOW);
  assert.match(token,/^c3b1\.[A-Za-z0-9_-]+$/);
  assert.equal(token.includes("renovation"),false,"not readable as plaintext");
  assert.equal(token.includes("owner"),false,"not readable as plaintext");
  const decoded=unsealInboxDisplayedAction(token,KEY,expectOf(p),NOW+1000);
  assert.ok(decoded);
  assert.deepEqual(decoded.suggestion,p.suggestion);
  assert.equal(decoded.expiresAtMs-decoded.issuedAtMs,180000);
  assert.notEqual(sealInboxDisplayedAction(p,KEY,NOW),token,
    "different proposals get different cryptographic tokens");
});

test("C-3b token: payload, other actor/task/session/restore and different proposal rejected",()=>{
  const p=base(),token=sealInboxDisplayedAction(p,KEY,NOW);
  assert.ok(token);
  for(const changes of [
    {actorUserId:"other"},
    {taskId:"other-task"},
    {sessionTokenHash:"d".repeat(64)},
    {restoreGeneration:"123e4567-e89b-42d3-a456-426614174001"},
    {displayedChanges:{...p.suggestion.changes,projectId:"different"}},
    {displayedChanges:{...p.suggestion.changes,taskAreaId:"kitchen"}},
    {displayedChanges:{...p.suggestion.changes,effectiveAreaId:"personal"}},
    {displayedWhy:"A forged reason"},
  ]){
    assert.equal(unsealInboxDisplayedAction(token,KEY,{...expectOf(p),...changes},NOW+1000),
      null,JSON.stringify(changes));
  }
  const altered=token.slice(0,-1)+(token.at(-1)==="A"?"B":"A");
  assert.equal(unsealInboxDisplayedAction(altered,KEY,expectOf(p),NOW+1000),null);
  assert.equal(unsealInboxDisplayedAction(token,randomBytes(32),expectOf(p),NOW+1000),
    null,"wrong key");
});

test("C-3b token: expiry, future issues and local midnight are fail-closed",()=>{
  const p=base(),token=sealInboxDisplayedAction(p,KEY,NOW);
  assert.ok(token);
  assert.equal(unsealInboxDisplayedAction(token,KEY,expectOf(p),NOW-1),null);
  assert.equal(unsealInboxDisplayedAction(token,KEY,expectOf(p),NOW+180000),null);
  assert.equal(unsealInboxDisplayedAction(token,KEY,expectOf(p),
    Date.parse("2026-11-23T00:00:00+01:00")),null);
  const nearMidnight=Date.parse("2026-11-22T23:59:30+01:00");
  const late=base();
  assert.equal(sealInboxDisplayedAction(late,KEY,nearMidnight)!==null,true);
  assert.equal(unsealInboxDisplayedAction(
    sealInboxDisplayedAction(late,KEY,nearMidnight),KEY,expectOf(late),
    Date.parse("2026-11-23T00:00:01+01:00")),null);
  assert.equal(inboxLocalDate(Date.parse("2026-03-29T00:59:00Z"),
    "Europe/Prague"),"2026-03-29");
  assert.equal(inboxLocalDate(Date.parse("2026-03-29T02:01:00Z"),
    "Europe/Prague"),"2026-03-29");
});

test("C-3b token: refuse bad dates, key lengths and contradictory Area/Project",()=>{
  for(const p of [
    base({localDate:"2026-11-23"}),
    base({timeZone:"Invalid/Zone"}),
    base({consentEpoch:0}),
    base({notificationEpoch:-1}),
    base({sessionTokenHash:"not-a-session"}),
    base({suggestion:{source:"ai",why:"bad project",changes:{
      ...changes,taskAreaId:"kitchen",
    }}}),
    base({suggestion:{source:"ai",why:"bad project",changes:{
      ...changes,effectiveAreaId:"unchanged",
    }}}),
  ])assert.equal(sealInboxDisplayedAction(p,KEY,NOW),null);
  assert.equal(sealInboxDisplayedAction(base(),randomBytes(20),NOW),null);
  const rules=base({consentEpoch:0,suggestion:{
    source:"rule",changes:{
      whenOn:"unchanged",projectId:"unchanged",taskAreaId:"unchanged",
      effectiveAreaId:"unchanged",
    },why:"Ponechat.",
  }});
  assert.ok(sealInboxDisplayedAction(rules,KEY,NOW),"rules require no remote consent");
});
