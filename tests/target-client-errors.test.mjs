import assert from "node:assert/strict";
import {test} from "node:test";
const {mapTargetClientFailure,targetClientActionLabels}=
  await import("../lib/target-client-errors.ts");

const KINDS=["signed_out","forbidden_or_missing","stale","conflict","invalid",
  "rate_limited","unavailable","offline","uncertain"];
const ACTIONS=["sign_in","reload","verify","retry_later","none"];
const check=(input,kind,action)=>{
  const result=mapTargetClientFailure(input);
  assert.equal(result.kind,kind,JSON.stringify(input));
  assert.equal(result.action,action,JSON.stringify(input));
  return result;
};

test("attention client statuses",()=>{
  check("unauthorized","signed_out","sign_in");
  check("stale","stale","reload");
  check("conflict","conflict","reload");
  check("not_found","forbidden_or_missing","none");
  check("invalid","invalid","none");
  check("unavailable","unavailable","retry_later");
  check("uncertain","uncertain","verify");
  check("aborted","stale","reload");
  check("invalid_response","invalid","none");
  check({status:"unauthorized"},"signed_out","sign_in");
  check({status:"uncertain"},"uncertain","verify");
});

test("global-index, title-search, my-plan, project and note client reasons",()=>{
  for(const [reason,kind,action] of [
    ["signed-out","signed_out","sign_in"],["stale","stale","reload"],
    ["invalid-request","invalid","none"],["invalid-response","invalid","none"],
    ["unavailable","unavailable","retry_later"],["offline","offline","retry_later"],
    ["aborted","stale","reload"],["disabled","unavailable","retry_later"],
    ["rate-limited","rate_limited","retry_later"],["not-found","forbidden_or_missing","none"],
  ]){
    check(reason,kind,action);
    check({reason},kind,action);
  }
});

test("HTTP status codes and server texts",()=>{
  check(400,"invalid","none");
  check(401,"signed_out","sign_in");
  check(403,"forbidden_or_missing","none");
  check(404,"forbidden_or_missing","none");
  check(413,"invalid","none");
  check(429,"rate_limited","retry_later");
  check(503,"unavailable","retry_later");
  check(500,"unavailable","retry_later");
  check(409,"conflict","reload");
  check({status:409,error:"read_stale_reload"},"stale","reload");
  check({status:409,error:"Cursor stale"},"stale","reload");
  check({status:409,error:"Revision conflict"},"conflict","reload");
  check({status:401,code:"session_revoked"},"signed_out","sign_in");
  check("read_stale_reload","stale","reload");
  check("Cursor stale","stale","reload");
  check("Revision conflict","conflict","reload");
  check("session_expired","signed_out","sign_in");
  check("network","offline","retry_later");
});

test("unknown or malformed input degrades to unavailable and never throws",()=>{
  for(const input of [undefined,null,{},[],"???",NaN,1.5,{status:{}},{reason:5},Symbol.iterator,()=>1]){
    const result=mapTargetClientFailure(input);
    assert.equal(result.kind,"unavailable");
    assert.equal(result.action,"retry_later");
  }
});

test("every kind has calm Czech copy and no technical leakage",()=>{
  const seen=new Map();
  const inputs=["unauthorized","not_found","stale","conflict","invalid","rate-limited",
    "unavailable","offline","uncertain"];
  for(const input of inputs){
    const {kind,action,message}=mapTargetClientFailure(input);
    seen.set(kind,message);
    assert.ok(KINDS.includes(kind));
    assert.ok(ACTIONS.includes(action));
    assert.ok(message.length>=20&&message.length<=140,message);
    assert.match(message,/[áčďéěíňóřšťúůýž]/i,message);
    assert.match(message,/[.]$/);
    assert.doesNotMatch(message,/\b(40[0-9]|41[0-9]|429|50[0-9]|http|json|stack|exception|error|token|cookie|session|epoch|uuid|id|api|null|undefined)\b/i,message);
    assert.doesNotMatch(message,/\d{3}/);
    assert.doesNotMatch(message,/[!]{1}|…|\bERR/);
  }
  assert.deepEqual([...seen.keys()].sort(),[...KINDS].sort());
  assert.equal(new Set(seen.values()).size,KINDS.length);
});

test("uncertain says it is being verified and never claims success or failure",()=>{
  const {message,action}=mapTargetClientFailure("uncertain");
  assert.equal(action,"verify");
  assert.match(message,/ověřuje/);
  assert.match(message,/nevíme/);
  assert.doesNotMatch(message,/(byla|bylo|se) (úspěšně )?(uložen|provedeno|neuložen|selhal)/i);
  assert.doesNotMatch(message,/úspěšn|selhal|chyba|nepodařilo/i);
});

test("action labels exist for every actionable action and are Czech",()=>{
  assert.deepEqual(Object.keys(targetClientActionLabels).sort(),
    ["reload","retry_later","sign_in","verify"]);
  for(const label of Object.values(targetClientActionLabels))
    assert.match(label,/^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž ]+$/);
});

test("results are fresh objects (callers cannot mutate the table)",()=>{
  const a=mapTargetClientFailure("stale");
  a.message="changed";
  assert.notEqual(mapTargetClientFailure("stale").message,"changed");
});
