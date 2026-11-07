import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  initialGlobalIndexWakeGate,invalidateGlobalIndexWakeGate,consumeGlobalIndexWake,
} from "../lib/target-staging-global-index-lifecycle.ts";

const root=path.join(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const ui=read("app/ui/target-staging-global-index-preview.tsx");
const page=read("app/target-staging/global-index/preview/page.tsx");
const css=read("app/target-staging/global-index/preview/preview.css");

test("R3 UI-09a server gate is separate, default-off and undiscoverable from normal nav",()=>{
  for(const flag of [
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED",
  ])assert.ok(page.includes(flag),flag);
  assert.match(page,/some\(flag=>process\.env\[flag\]!=="true"\)\)notFound\(\)/);
  assert.match(page,/dynamic="force-dynamic"/);
  assert.match(page,/index:false,follow:false/);
  assert.doesNotMatch(page,/my-plan|statusWriteEnabled|PATCH|POST/i);
});

test("R3 UI-09a global scopes, type glyphs and readable mobile controls",()=>{
  assert.ok(ui.includes('(["all","personal","shared"] as const)'));
  assert.ok(ui.includes('all:"Vše",personal:"Osobní",shared:"Sdílené"'));
  assert.ok(ui.includes("Vše není Můj plán."));
  assert.ok(ui.includes('aria-pressed={scope===value}'));
  assert.ok(ui.includes('data-area-kind={entry.item.areaKind}'));
  assert.match(css,/min-height:44px/);
  assert.match(css,/data-kind="project"/);
  assert.match(css,/data-area-kind="shared"/);
  assert.doesNotMatch(ui,/actorUserId|memberRole|assignedToUserId|note\.body|localStorage|indexedDB/i);
});

test("R3 UI-09a wipe/abort/reload hooks cover hidden, offline, focus and BFCache",()=>{
  for(const line of [
    'document.addEventListener("visibilitychange",visibility)',
    'window.addEventListener("offline",offline)',
    'window.addEventListener("online",online)',
    'window.addEventListener("pagehide",pagehide)',
    'window.addEventListener("pageshow",pageshow)',
    'window.addEventListener("focus",foreground)',
    'const pagehide=()=>hide()',
    'const pageshow=(event:PageTransitionEvent)=>wake(event.persisted)',
    'wakeGate.current=invalidateGlobalIndexWakeGate(wakeGate.current)',
    'current.current?.abort()',
    'requestSequence.current++',
    'if(controller.signal.aborted||requestSequence.current!==id)return',
    'invalidate("stale",true)',
    'setState({status:"loading"})',
    'setState(combined?{status:"ready",page:combined}:',
  ])assert.ok(ui.includes(line),line);
  assert.ok(ui.includes('window.removeEventListener("pagehide",pagehide)'));
  assert.ok(ui.includes('window.removeEventListener("pageshow",pageshow)'));
  assert.ok(ui.includes('document.removeEventListener("visibilitychange",visibility)'));
  assert.ok(ui.includes('state.page.scope===scope?state.page:null'));
});

test("R3 UI-09a hidden/show under 350ms always reauthorizes",()=>{
  let gate=consumeGlobalIndexWake(initialGlobalIndexWakeGate(),10_000,true).gate;
  assert.equal(consumeGlobalIndexWake(gate,10_025).reload,false);
  gate=invalidateGlobalIndexWakeGate(gate);
  const resumed=consumeGlobalIndexWake(gate,10_050);
  assert.equal(resumed.reload,true);
  assert.equal(resumed.gate.requiresReauthorization,false);
  assert.equal(consumeGlobalIndexWake(resumed.gate,10_065).reload,false);
  gate=invalidateGlobalIndexWakeGate(resumed.gate);
  assert.equal(consumeGlobalIndexWake(gate,10_070).reload,true);
});

test("R3 UI-09a BFCache, explicit recheck and backwards clock reauthorize",()=>{
  const first=consumeGlobalIndexWake(initialGlobalIndexWakeGate(),42_000,true);
  assert.equal(consumeGlobalIndexWake(first.gate,42_100,true).reload,true);
  assert.equal(consumeGlobalIndexWake(first.gate,41_000).reload,true);
  assert.equal(consumeGlobalIndexWake(first.gate,42_400).reload,true);
  assert.equal(consumeGlobalIndexWake(first.gate,42_050).reload,false);
});

test("R3 UI-09a hides prior rows while scope changes or another page revalidates",()=>{
  assert.ok(ui.includes('if(next===scope)return;'));
  assert.ok(ui.includes('invalidate("stale",true);'));
  assert.ok(ui.includes('setState({status:"loading"});\n    const result=await fetchGlobalIndexPage'));
  assert.ok(ui.includes('const combined=appendGlobalIndexPage(previous,result.page);'));
  assert.ok(ui.includes('moreInFlight.current'));
  assert.match(ui,/if\(result\.ok===false\)\{setState\(\{status:"error",reason:result\.reason\}\);return;\}/);
  assert.doesNotMatch(ui,/method:\s*["'](?:PATCH|POST|PUT|DELETE)/);
});
