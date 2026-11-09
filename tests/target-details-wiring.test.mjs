import assert from "node:assert/strict";
import {existsSync,readFileSync,readdirSync,statSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const rootSource=read("app/ui/lumi-app-root.tsx");
const hookSource=read("app/ui/use-lumi-app.tsx");
const sidebar=read("app/ui/views/sidebar.tsx");

function walk(dir){
  return readdirSync(path.join(root,dir)).flatMap(name=>{
    const rel=path.join(dir,name);
    return statSync(path.join(root,rel)).isDirectory()?walk(rel):[rel];
  });
}

test("flags off: the shell is the legacy tree - heavy target modules are only dynamic imports",()=>{
  // Static imports of the root: nothing that fetches, no CSS, no readers or panels.
  const staticImports=[...rootSource.matchAll(/^import .*from "(.+)";$/gm)].map(m=>m[1]);
  for(const spec of staticImports){
    assert.doesNotMatch(spec,/target-detail-panel|target-sidebar-projects|target-scope|target-my-plan|\.css$/,spec);
    assert.doesNotMatch(spec,/staging-.*client|target-detail-session/,spec);
  }
  assert.match(rootSource,/dynamic\(\(\) => import\("\.\/target-detail-panel"\), \{ ssr: false \}\)/);
  assert.match(sidebar,/dynamic\(\(\) => import\("\.\.\/target-sidebar-projects"\), \{ ssr: false \}\)/);
  // The two static helpers are inert: no CSS, no fetch, no session creation.
  for(const file of ["app/ui/target-detail-state.ts","lib/target-detail-route.ts"]){
    const source=read(file);
    assert.doesNotMatch(source,/\.css"|fetch\(|useTargetSession|createTarget/,file);
  }
});

test("flags off: no listener, no panel and no request without a detail flag",()=>{
  assert.match(rootSource,/useLumiApp\(\{ targetDetails: detailsOn, targetUnified: scopesOn \}\)/);
  assert.match(rootSource,/useTargetSearch\(detailsOn\)/);
  assert.match(read("app/ui/target-detail-state.ts"),/useSyncExternalStore\(enabled\?subscribe:noopSubscribe/);
  assert.match(rootSource,/detailsOn \? detailRequestFromSearch\(detailSearch, detailGates\) : \{ state: "none" \}/);
  assert.match(rootSource,/\{detailPanel && <TargetDetailPanel/);
  assert.match(hookSource,/export function useLumiApp\(options: \{ targetDetails\?: boolean; targetUnified\?: boolean \} = \{\}\)/);
});

test("every legacy-address deviation in use-lumi-app is guarded by the target-details ref",()=>{
  const guarded=[
    /else if \(targetDetailsRef\.current && !options\?\.targetOpen && requestsTypedRecord/,
    /\(targetDetailsRef\.current && isPlanDetailSearch\(window\.location\.search\)\)/,
    /const targetTyped = targetDetailsRef\.current && requestsTypedRecord\(window\.location\.search\)/,
    /const route = targetTyped \? null : targetFromSearch/,
    /setNavigationUnavailable\(!targetTyped && showUnavailableLink/,
    /if \(targetDetailsRef\.current && requestsTypedRecord\(window\.location\.search\)\) \{\s*const typedView/,
    /const target = targetTyped \? null : targetFromSearch\(window\.location\.search, addressableViews, nextView\)/,
    /const unavailableTarget = !targetTyped && showUnavailableLink/,
  ];
  for(const pattern of guarded)assert.match(hookSource,pattern,String(pattern));
  assert.match(hookSource,/const targetDetailsRef = useRef\(Boolean\(options\.targetDetails\)\)/);
});

test("target addresses are never resolved against legacy records (no legacy fallback for a typed id)",()=>{
  // With the ref on, the legacy resolvers receive null instead of the typed address.
  assert.match(hookSource,/const route = targetTyped \? null :/);
  assert.match(hookSource,/const target = targetTyped \? null :/);
});

test("unification: Quick Capture is a no-op and hidden everywhere in target mode",()=>{
  assert.match(hookSource,/function openCapture\([^)]*\) \{\s*\/\/[^\n]*\n\s*if \(captureDisabledRef\.current\) return;/);
  assert.match(hookSource,/const captureDisabled = Boolean\(options\.targetUnified\)/);
  assert.match(hookSource,/\n\s*captureDisabled,\n/);
  assert.match(read("app/ui/views/mobile-nav.tsx"),/!moreOpen && !app\.captureDisabled && <button className="mobileCaptureButton"/);
  const fab=read("app/ui/views/desktop-capture-fab.tsx");
  assert.match(fab,/if \(state\.captureDisabled\) return;/);
  assert.match(fab,/if \(app\.captureDisabled\) return null;/);
  assert.match(sidebar,/\{!app\.captureDisabled && <>\s*\{mobileDesignV1Preview && app\.selected/);
  assert.match(sidebar,/\{!app\.captureDisabled && <button onClick=\{\(\) => openCapture\(\)\}/);
  assert.match(read("app/ui/views/home-view.tsx"),/\{!app\.captureDisabled && <button onClick=\{\(\) => openCapture\(\)\}>/);
  assert.match(read("app/ui/views/context-view.tsx"),/disabled=\{!task\.title\.trim\(\) \|\| app\.captureDisabled\}/);
});

test("unification: target mode shows the target project index, never the legacy workspace projects",()=>{
  assert.match(sidebar,/\{app\.captureDisabled && targetSidebar\?\.projects && \(\s*<TargetSidebarProjects/);
  assert.match(sidebar,/const sidebarProjects = app\.captureDisabled \? \[\] : app\.sidebarProjects;/);
  assert.match(rootSource,/targetSidebar=\{scopesOn && targetScopes\?\.projects \?/);
  const component=read("app/ui/target-sidebar-projects.tsx");
  assert.match(component,/createKindIndexReadSession\("project"/);
  assert.match(component,/useTargetSession\(/);
  assert.match(component,/useTargetScope\(\)/);
  assert.doesNotMatch(component,/sidebarProjects\b.*app|useLumiApp|db\.entities/s);
  // The scope is part of the session key, so a scope change drops every title.
  assert.match(component,/\[scope\]\);/);
  assert.match(component,/state\.page\.scope===scope/);
});

test("unification: the legacy inspector is never rendered or opened in target views",()=>{
  assert.match(rootSource,/const targetView = scopeList !== null \|\| targetPlan;/);
  assert.match(rootSource,/\{!\(scopesOn && targetView\) && <DetailPanel app=\{app\} \/>\}/);
  assert.match(rootSource,/const legacyInspector = Boolean\(app\.selected\) && !\(scopesOn && targetView\);/);
  assert.match(rootSource,/legacyInspector \|\| detailPanel \? " inspectorOpen" : ""/);
  // Target lists and the plan never call the legacy inspect().
  for(const file of ["app/ui/target-scope-lists.tsx","app/ui/target-my-plan.tsx","app/ui/target-detail-panel.tsx",
    "app/ui/target-sidebar-projects.tsx"])
    assert.doesNotMatch(read(file),/\binspect\(|useLumiApp|openCapture/,file);
});

test("rows open details only through the typed detail flag of their kind; otherwise they stay text",()=>{
  assert.match(rootSource,/detail=\{scopeList === "project" \? detailGates\.project : detailGates\.note\}/);
  assert.match(rootSource,/taskDetail=\{detailGates\.task\}/);
  const lists=read("app/ui/target-scope-lists.tsx");
  assert.match(lists,/\{detail\s*\?<button type="button" className="targetScopeRowButton"/);
  assert.match(lists,/:entry\.item\.title\}/);
  const plan=read("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(plan,/onOpenTask=\{embedded\?onOpenTask:undefined\}/);
  // The standalone staging pages never receive the callback.
  assert.doesNotMatch(read("app/target-staging/my-plan/preview/page.tsx"),/onOpenTask/);
});

test("navigation stays inside the main app: no row links to a standalone staging page",()=>{
  for(const file of ["app/ui/target-scope-lists.tsx","app/ui/target-my-plan.tsx","app/ui/target-detail-panel.tsx",
    "app/ui/target-sidebar-projects.tsx","app/ui/target-detail-state.ts"])
    assert.doesNotMatch(read(file).replace(/^import .*\.css";$/gm,""),/\/target-staging\/|stagingIndexDetailHref|<a /,file);
});

test("a view change or a scope change never touches an open detail except by the address",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  // Keyed by target (not by scope): a scope change keeps an open authorized detail.
  assert.match(panel,/\[route\.kind,route\.id\]\);/);
  assert.match(panel,/<DetailBody key=\{detailRouteKey\(route\)\}/);
  assert.doesNotMatch(panel,/useTargetScope/);
});

test("the panel reads only for a server-confirmed generation and routes 401 through the refusal budget",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(panel,/const \{gate,onRefusal,retry\}=useTargetGate\(\)/);
  assert.match(panel,/const ready=gate\.kind==="ready"/);
  assert.match(panel,/if\(!session\|\|!ready\)return;/);
  assert.match(panel,/state\.reason==="signed-out"\)refusalRef\.current\(\)/);
  // Privacy: hidden, pagehide, offline and BFCache all remove the content.
  for(const event of ["visibilitychange","offline","pagehide","pageshow"])
    assert.match(panel,new RegExp(`"${event}"`),event);
  assert.match(panel,/sessionRef\.current\?\.suspend\(\)/);
});

test("focus management: the panel takes focus on open and Escape/close/backdrop all close it",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(panel,/panelRef\.current\?\.focus\(\{preventScroll:true\}\)/);
  assert.match(panel,/event\.key!=="Escape"/);
  assert.match(panel,/className="close inspectorClose"/);
  assert.match(panel,/onClick=\{close\}>/);
  assert.match(panel,/tabIndex=\{-1\}/);
  assert.match(panel,/aria-label=\{label\}/);
  const state=read("app/ui/target-detail-state.ts");
  assert.match(state,/closest\("\[data-detail-row\]"\)/);
  assert.match(state,/export function focusPendingRow/);
});

test("no create endpoint exists for tasks, projects or notes: the documented 4b/backend gap",()=>{
  for(const file of ["app/api/target-staging/tasks/route.ts","app/api/target-staging/projects/route.ts"]){
    const source=read(file);
    assert.match(source,/export async function GET/,file);
    assert.doesNotMatch(source,/export async function (POST|PUT|PATCH|DELETE)/,file);
  }
  assert.equal(existsSync(path.join(root,"app/api/target-staging/notes/route.ts")),false);
  const create=walk("app/api/target-staging").filter(file=>/route\.ts$/.test(file) &&
    /export async function POST/.test(read(file)) && /create/i.test(file));
  assert.deepEqual(create,[]);
});

test("page: the provider mounts through the shared rule and the config reaches the root",()=>{
  const page=read("app/page.tsx");
  assert.match(page,/targetDataNeeded\(config\)/);
  assert.match(page,/targetDetails=\{config\?\.details\}/);
  assert.match(page,/<LumiAppRoot \/>/);
});

test("docs and workflow: the slice documentation and focused CI paths exist",()=>{
  assert.equal(existsSync(path.join(root,"docs/R3-FE-04A-DETAILS.md")),true);
  const doc=read("docs/R3-FE-04A-DETAILS.md");
  for(const needle of ["AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED","2026-11-09","Quick Capture","Vyhledávání"])
    assert.ok(doc.includes(needle),needle);
});
