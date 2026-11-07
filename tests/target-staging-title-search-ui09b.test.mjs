import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {validTitleSearchQuery} from "../lib/target-staging-title-search-client.ts";

const root=path.join(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const page=read("app/target-staging/title-search/preview/page.tsx");
const ui=read("app/ui/target-staging-title-search-preview.tsx");
const css=read("app/target-staging/title-search/preview/preview.css");

test("UI-09b isolated server page is default-off and cannot index search titles",()=>{
  for(const flag of [
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_TITLE_SEARCH_CLIENT_PREVIEW_ENABLED",
  ])assert.ok(page.includes(flag),flag);
  assert.match(page,/some\(flag=>process\.env\[flag\]!==\"true\"\)\)notFound\(\)/);
  assert.match(page,/dynamic=\"force-dynamic\"/);
  assert.match(page,/index:false,follow:false/);
  for(const file of ["app/ui/navigation.ts","app/ui/views/mobile-nav.tsx",
    "app/ui/views/sidebar.tsx","app/ui/views/topbar.tsx"]){
    assert.ok(!read(file).includes("/target-staging/title-search/preview"),file);
  }
});

test("UI-09b explicit search and pagination only, with no writes, cache or synthetic permission UI",()=>{
  assert.ok(ui.includes('createStagingTitleSearchSession()'));
  assert.ok(ui.includes('validTitleSearchQuery(query)'));
  assert.ok(ui.includes('session.current!.first({query,scope,limit:25})'));
  assert.ok(ui.includes('session.current!.next()'));
  assert.ok(ui.includes('if(pageInFlight.current)return;'),"double next-page actions are ignored");
  assert.ok(ui.includes('Zobrazeno {ready.items.length} autorizovaných názvů.'));
  assert.ok(ui.includes('item.areaKind==="shared"?"Sdílené":"Osobní"'));
  assert.match(css,/stagingTitleSearchSrOnly/);
  assert.ok(ui.includes('all:"Vše",personal:"Osobní",shared:"Sdílené"'));
  assert.ok(ui.includes("Vše není Můj plán."));
  assert.ok(ui.includes('snapshot?.status==="ready"?snapshot:null'));
  assert.ok(ui.includes('data-area-kind={item.areaKind}'));
  assert.doesNotMatch(ui,/item\.areaId|item\.projectId|actorUserId|memberRole|note\.body/i);
  assert.doesNotMatch(ui,/localStorage|indexedDB|sessionStorage|setTimeout|setInterval|method:\s*["'](?:POST|PATCH|PUT|DELETE)/i);
  assert.match(css,/min-height:44px/);
  assert.match(css,/data-kind="project"/);
});

test("UI-09b clears visible titles on query, scope, hide, offline, pagehide and focus",()=>{
  for(const line of [
    'invalidate();\n    setDraft(value);',
    'invalidate();\n    setScope(value);',
    'session.current?.reset()',
    'setSnapshot(null)',
    'window.addEventListener("pagehide",pagehide)',
    'window.addEventListener("pageshow",pageshow)',
    'window.addEventListener("focus",pagehide)',
    'window.addEventListener("offline",offline)',
    'document.addEventListener("visibilitychange",visibility)',
    'epoch.current!==id',
    'document.visibilityState==="hidden"||!navigator.onLine',
    'setSnapshot(session.current!.getSnapshot())',
    'const ready=snapshot?.status==="ready"?snapshot:null',
  ])assert.ok(ui.includes(line),line);
  assert.ok(ui.includes('window.removeEventListener("pagehide",pagehide)'));
  assert.ok(ui.includes('window.removeEventListener("offline",offline)'));
});

test("UI-09b uses real server query bounds and does not silently make network calls",()=>{
  assert.equal(validTitleSearchQuery("a"),false);
  assert.equal(validTitleSearchQuery("ab"),true);
  assert.equal(validTitleSearchQuery(" x"),false);
  assert.equal(validTitleSearchQuery("one two"),true);
  assert.equal(validTitleSearchQuery("one two three four five six seven eight nine"),false);
  assert.equal(validTitleSearchQuery("x".repeat(81)),false);
  assert.ok(ui.includes('onSubmit={event=>{event.preventDefault();void search();}}'));
  assert.ok(!ui.includes("useEffect(()=>{void search()"));
});
