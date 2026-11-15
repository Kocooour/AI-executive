import assert from "node:assert/strict";
import {test} from "node:test";
import {matchingNativeBackReasons,validateNativeBackEvidence}
  from "../e2e/target-personal-native-bfcache-gate.ts";

// Synthetic proof objects only. No PageTransitionEvent or fake browser activity
// is used in the native witness; these are fail-closed decision regressions.
const event=(frameId="main",loaderId="back",reason="MainResourceHasCacheControlNoStore")=>({
  frameId,loaderId,reasons:[{reason,type:"Circumstantial"}],
});
const valid=()=>({
  initialPageShowObserved:true,
  postBackPageShowObserved:true,
  persisted:false,
  originalDocumentToken:"before",
  returnedDocumentToken:"after",
  topFrameId:"main",
  returnedLoaderId:"back",
  backReasonStartIndex:1,
  cacheNotUsed:[event("main","earlier"),event()],
});

test("strict not_restored passes with reasons from THIS Back and main loader",()=>{
  assert.equal(validateNativeBackEvidence(valid()),"not_restored");
  assert.equal(matchingNativeBackReasons(valid()).length,1);
});
test("strict restored passes without cache miss reasons only for original document",()=>{
  assert.equal(validateNativeBackEvidence({...valid(),persisted:true,
    returnedDocumentToken:"before",cacheNotUsed:[]}),"restored");
  assert.throws(()=>validateNativeBackEvidence({...valid(),persisted:true}),
    /original document token/);
});
test("strict cache miss without reasons always fails; nonstrict is diagnostics only",()=>{
  const noReasons={...valid(),cacheNotUsed:[]};
  assert.throws(()=>validateNativeBackEvidence(noReasons),/Unexplained native cache miss/);
  assert.equal(validateNativeBackEvidence(noReasons,{strict:false}),"not_restored");
});
test("older reasons recorded before Back cannot satisfy the release proof",()=>{
  const data={...valid(),cacheNotUsed:[event("main","back")],
    backReasonStartIndex:1};
  assert.equal(matchingNativeBackReasons(data).length,0);
  assert.throws(()=>validateNativeBackEvidence(data),/Unexplained native cache miss/);
});
test("subframe reasons cannot certify a top-level page miss",()=>{
  const data={...valid(),cacheNotUsed:[event("main","earlier"),event("child","back")]};
  assert.equal(matchingNativeBackReasons(data).length,0);
  assert.throws(()=>validateNativeBackEvidence(data),/Unexplained native cache miss/);
});
test("a different top-level navigation loader cannot certify this Back",()=>{
  const data={...valid(),cacheNotUsed:[event("main","earlier"),event("main","wrong")]};
  assert.equal(matchingNativeBackReasons(data).length,0);
  assert.throws(()=>validateNativeBackEvidence(data),/Unexplained native cache miss/);
});
test("empty and blank reason strings do not satisfy strict evidence",()=>{
  for(const reason of ["","  "])assert.throws(()=>validateNativeBackEvidence({
    ...valid(),cacheNotUsed:[event("main","earlier"),event("main","back",reason)]
  }),/Unexplained native cache miss/);
});
test("invalid reason-window marker fails closed",()=>{
  for(const marker of [null,undefined,-1,2,3,0.5])assert.throws(()=>
    validateNativeBackEvidence({...valid(),backReasonStartIndex:marker}),
    /Unexplained native cache miss/);
});
test("initial and post-Back native pageshow are independently mandatory",()=>{
  assert.throws(()=>validateNativeBackEvidence({
    ...valid(),initialPageShowObserved:false}),/initial pageshow/);
  assert.throws(()=>validateNativeBackEvidence({
    ...valid(),postBackPageShowObserved:false}),/post-Back pageshow/);
});
test("unknown persisted state is never reinterpreted as a miss",()=>{
  for(const persisted of [null,undefined,"false",0])assert.throws(()=>
    validateNativeBackEvidence({...valid(),persisted}),/not boolean/);
});
test("new document token is mandatory on a miss",()=>{
  assert.throws(()=>validateNativeBackEvidence({...valid(),
    returnedDocumentToken:"before"}),/reused the original/);
  assert.throws(()=>validateNativeBackEvidence({...valid(),
    returnedDocumentToken:null}),/Missing original\/returned/);
});
