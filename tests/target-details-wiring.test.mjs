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
  assert.match(rootSource,/useLumiApp\(\{ targetDetails: detailsOn, targetUnified: scopesOn, targetViews: detailsOn \? targetViews : \[\] \}\)/);
  // Details are inert unless a target list / plan exists to open them from.
  assert.match(rootSource,/const detailsOn = detailsActive\(detailGates, targetViews\)/);
  assert.match(rootSource,/useTargetSearch\(detailsOn\)/);
  assert.match(read("app/ui/target-detail-state.ts"),/useSyncExternalStore\(enabled\?subscribe:noopSubscribe/);
  assert.match(rootSource,/detailsOn\s*\? detailActivation\(\{ search: detailSearch, gates: detailGates, activeTargetView \}\) : \{ state: "none" \}/);
  assert.match(rootSource,/\{detailPanel && <TargetDetailPanel/);
  assert.match(hookSource,/export function useLumiApp\(options: \{ targetDetails\?: boolean; targetUnified\?: boolean; targetViews\?: readonly string\[\] \} = \{\}\)/);
});

test("every legacy-address deviation in use-lumi-app is guarded by the target-details ref",()=>{
  const guarded=[
    /else if \(shouldLeaveTypedAddress\(\{ enabled: targetDetailsRef\.current, keepAddress: Boolean\(options\?\.keepAddress\)/,
    /targetDetailsRef\.current && targetViewsRef\.current\.includes\("MyPlanPreview"\) && isPlanDetailSearch\(window\.location\.search\)/,
    /const targetTyped = targetTypedNow\(\);\s*const route = targetTyped \? null : targetFromSearch/,
    /setNavigationUnavailable\(!targetTyped && showUnavailableLink/,
    /if \(holdTypedAddress\(\{ enabled: targetDetailsRef\.current, search: window\.location\.search,/,
    /const target = targetTyped \? null : targetFromSearch\(window\.location\.search, addressableViews, nextView\)/,
    /const unavailableTarget = !targetTyped && showUnavailableLink/,
    /const targetTypedNow = \(\) => targetDetailsRef\.current && isTargetAddress\(window\.location\.search, targetViewsRef\.current\)/,
    // Startup / restore keeps the address (cold deep links and reloads open their detail).
    /setView\(savedView, \{ keepAddress: true \}\)/,
    /if \(addressedView\) setView\(addressedView, \{ keepAddress: true \}\)/,
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
  assert.match(hookSource,/function openCapture\([^)]*\) \{\s*\/\/[^\n]*\n\s*if \(blockLegacyWrite\(\)\) return;/);
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
  assert.match(rootSource,/TargetSidebarContext\.Provider value=\{scopesOn && targetScopes\?\.projects \?/);
  assert.match(sidebar,/useContext\(TargetSidebarContext\)/);
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
  assert.match(lists,/\{detail&&detailIdOk\(entry\.item\.id\)\s*\?<button type="button" className="targetScopeRowButton"/);
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
  // Privacy: hidden, pagehide, offline and BFCache remove the content; returning waits for the runtime's fresh verification.
  const hooks=read("app/ui/use-target-revalidation.ts");
  for(const event of ["visibilitychange","offline","pagehide","pageshow","online"])
    assert.match(hooks,new RegExp(`"${event}"`),event);
  // The wake logic is a pure, tested machine (lib/target-wake.ts): it waits for the runtime's
  // fresh verification, never gives up before reading, and shows signed-out instead of staying hidden.
  assert.match(hooks,/createWakeMachine\(\{/);
  assert.match(hooks,/refresh:\(\)=>runtime\?runtime\.refresh\(\)/);
  const machine=read("lib/target-wake.ts");
  assert.match(machine,/if\(result==="signed_out"\)deps\.handlers\(\)\.signedOut\(\);\s*\n\s*else deps\.handlers\(\)\.ready\(\);/);
  assert.match(panel,/signedOut:\(\)=>setState\(\{kind:"error",reason:"signed-out"\}\)/);
  assert.match(panel,/useTargetWake\(\{/);
  assert.match(panel,/sessionRef\.current\?\.suspend\(\)/);
  // Revalidation tick: an open detail re-reads, a failure (404) replaces the content.
  assert.match(panel,/useTargetTick\(\(\)=>\{/);
});

test("focus management: the panel takes focus on open and Escape/close/backdrop all close it",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(panel,/panelRef\.current\?\.focus\(\{preventScroll:true\}\)/);
  // Esc and the focus trap live at DOCUMENT level while the panel is open.
  assert.match(panel,/document\.addEventListener\("keydown",onKey\)/);
  assert.match(panel,/event\.key==="Escape"/);
  assert.match(panel,/document\.addEventListener\("focusin",onFocusIn\)/);
  assert.match(panel,/role="dialog" aria-modal="true"/);
  assert.match(panel,/event\.key!=="Tab"/);
  assert.match(panel,/className="close inspectorClose"/);
  assert.match(panel,/onClick=\{close\}>/);
  assert.match(panel,/tabIndex=\{-1\}/);
  assert.match(panel,/aria-label=\{label\}/);
  const state=read("app/ui/target-detail-state.ts");
  assert.match(state,/closest\("\[data-detail-row\]"\)/);
  assert.match(state,/export function focusPendingRow/);
});

test("4b introduces only a separately gated private standalone note-create HTTP route; task/project create and target UI remain unavailable",()=>{
  for(const file of ["app/api/target-staging/tasks/route.ts","app/api/target-staging/projects/route.ts"]){
    const source=read(file);
    assert.match(source,/export async function GET/,file);
    assert.doesNotMatch(source,/export async function (POST|PUT|PATCH|DELETE)/,file);
  }
  const noteRoute=read("app/api/target-staging/notes/route.ts");
  assert.match(noteRoute,/export async function POST/);
  assert.match(noteRoute,/AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED/);
  assert.match(noteRoute,/AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED/);
  assert.match(noteRoute,/projectId: null/);
  const writer=read("lib/target-note-lifecycle-writer.ts");
  assert.match(writer,/privateCreateOnly/);
  assert.match(writer,/dest\.kind !== "private"/);
  const shell=read("app/ui/use-lumi-app.tsx");
  assert.match(shell,/if \(blockLegacyWrite\(\)\) return;/);
  const doc=read("docs/R3-BE-04B-PRIVATE-NOTE-CREATE.md");
  assert.match(doc,/Quick Capture.*vypnut/);
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

const writersInApp=["create","createFromRow","done","reopenTask","moveTaskToSection","patch","patchNoteText",
  "persistManualOrder","relate","remove","rename","resolveConflict","restore","setProjectStatus","triageInbox",
  "triageInboxBatch","completeDrop","createSuggestedTarget","saveContextClaim","subjectAction","contextAction",
  "saveNotes","saveNoteBody",
  // Agents / assistant / context / settings (user-initiated, write legacy or server-legacy data)
  "askAI","resolveAIProposal","undoAIAction","runPACTAgent","contextClaimAction","contextHistoryAction",
  "previewContextInbox","approveContextInbox","saveWorkspaceName","createWorkspace"];
const writersInHooks={
  "use-backups.ts":["restoreServerBackup","importExport"],
  "use-calendar-events.ts":["writeDecisions","createEventTask","applySuggestion"],
  "use-day-plan.ts":["workSessionAction","applyDayPlanAction","undoDayPlanBlock"],
  "use-attention.ts":["actOnAttention"],
  "use-notifications.ts":["enableNotifications","disableNotifications","testNotification","saveNotificationSettings"],
};
const functionHead=(source,name,length=900)=>{
  const start=source.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
  assert.ok(start>0,name);
  return source.slice(start,start+length);
};

test("unified mode: every user-initiated legacy writer is guarded by the unified-mode flag (and inert when flags off)",()=>{
  for(const name of writersInApp)
    assert.match(functionHead(hookSource,name),/if \(blockLegacyWrite\(\)\) return/,name+" must be guarded");
  for(const [file,names] of Object.entries(writersInHooks)){
    const source=read("app/ui/hooks/"+file);
    assert.match(source,/writesBlocked = \(\) => false/,file+" defaults to NOT blocked (flags off = legacy)");
    for(const name of names)
      assert.match(functionHead(source,name,500),/if \(writesBlocked\(\)\) return/,file+" "+name);
  }
  // The hooks receive the flag from the app hook; the default false means identical legacy behaviour.
  for(const hook of ["useNotifications","useDayPlan","useBackups","useAttention","useCalendarEvents"])
    assert.match(hookSource,new RegExp(`${hook}\\(\\{[^}]*writesBlocked: blockLegacyWrite`),hook);
  // The blocker is inert unless the unified flag is on, and announces (never silent).
  assert.match(hookSource,/const blockLegacyWrite = \(\) => \{\s*if \(!captureDisabledRef\.current\) return false;\s*setLegacyWriteAttempt\(true\);\s*return true;/);
  assert.match(hookSource,/const captureDisabled = Boolean\(options\.targetUnified\)/);
  assert.match(hookSource,/legacyWritesDisabled: captureDisabled/);
  // Blocked writers never report success: defer returns false BEFORE any Undo is set.
  const defer=functionHead(hookSource,"deferTask",400);
  assert.match(defer,/if \(blockLegacyWrite\(\)\) return false;/);
  // Backups: creating a server backup (read-only export of the server copy) stays available.
  assert.doesNotMatch(functionHead(read("app/ui/hooks/use-backups.ts"),"createServerBackup",300),/writesBlocked/);
  // The inline add row of legacy lists is not rendered in unified mode.
  assert.match(read("app/ui/views/entity-list.tsx"),/!app\.legacyWritesDisabled && \(/);
});

test("unified mode: legacy write controls render DISABLED with the notice, not as silent no-ops",()=>{
  const gate=read("app/ui/views/legacy-write-gate.tsx");
  assert.match(gate,/<fieldset disabled className="legacyWriteGate" title=\{writes\.hint\}/);
  assert.match(rootSource,/LegacyWritesContext\.Provider value=\{\{ disabled: app\.legacyWritesDisabled, hint: app\.legacyReadOnlyHint \}\}/);
  for(const file of ["app/ui/views/inbox-triage.tsx","app/ui/views/inbox-batch-triage.tsx"])
    assert.match(read(file),/<LegacyWriteGate>/,file);
  assert.match(read("app/ui/views/lumi-completion-control.tsx"),/const disabled=ownDisabled\|\|writes\.disabled/);
  assert.match(read("app/ui/views/defer-popover.tsx"),/disabled=\{app\.legacyWritesDisabled\}\s*\n\s*title=\{app\.legacyReadOnlyHint\}/);
  for(const [file,needle] of [
    ["app/ui/views/context-view.tsx","|| app.legacyWritesDisabled"],
    ["app/ui/views/agents-view.tsx","app.legacyWritesDisabled"],
    ["app/ui/views/assistant-panel.tsx","app.legacyWritesDisabled"],
    ["app/ui/views/settings-view.tsx","app.legacyWritesDisabled"],
  ])assert.ok(read(file).includes(needle),file);
  // An attempted blocked action is announced, with nothing changed.
  assert.match(rootSource,/app\.legacyWritesDisabled && app\.legacyWriteAttempt && \(/);
  assert.match(rootSource,/role="alert" data-testid="legacy-write-blocked"/);
});

test("a typed link to another active target view switches to it and opens (address kept)",()=>{
  assert.match(rootSource,/app\.setView\("Today", \{ previewMyPlan: true, keepAddress: true \}\)/);
  assert.match(rootSource,/else app\.setView\(wanted, \{ keepAddress: true \}\)/);
  assert.match(rootSource,/if \(wanted === null \|\| wanted === activeTargetView\) return;/);
});

test("unified mode: legacy views stay visible read-only with a calm cs/en notice (owner decision 2026-11-09, option 1)",()=>{
  assert.match(rootSource,/const legacyReadOnly = app\.legacyWritesDisabled && !targetView;/);
  assert.match(rootSource,/\{legacyReadOnly && \(\s*<p className="navigationUnavailableNotice legacyReadOnlyNotice" role="status"/);
  const copy=read("lib/target-detail-copy.ts");
  assert.match(copy,/Tento pohled zatím ukazuje dosavadní data; úpravy jsou v režimu serverových dat vypnuté\./);
  assert.match(copy,/This view still shows the existing data; editing is switched off in server-data mode\./);
  // The views themselves are not hidden.
  assert.doesNotMatch(rootSource,/legacyReadOnly \? null/);
});

test("legacy writers cannot feed the detail layer: project pages are inert where Projects is a target view",()=>{
  assert.match(hookSource,/function openProjectPage\(project: Entity\) \{\s*\/\/[^\n]*\n\s*if \(captureDisabledRef\.current && targetViewsRef\.current\.includes\("Projects"\)\) return;/);
  // Typed addresses of any non-target view are resolved by the legacy code exactly as before.
  assert.match(hookSource,/const targetTypedNow = \(\) => targetDetailsRef\.current && isTargetAddress\(/);
});

test("rows are buttons only for IDs the detail layer can open; otherwise plain text (never a silent no-op)",()=>{
  for(const [file,needle] of [
    ["app/ui/target-scope-lists.tsx","detailIdOk(entry.item.id)"],
    ["app/ui/target-sidebar-projects.tsx","detailIdOk(item.id)"],
    ["app/ui/target-detail-panel.tsx","gates.task&&detailIdOk(task.id)"],
    ["app/ui/target-staging-my-plan-preview.tsx","onOpenTask&&detailIdOk(task.taskId)"],
  ])assert.ok(read(file).includes(needle),file);
  assert.match(read("app/ui/target-detail-state.ts"),/if\(!detailIdOk\(route\.id\)/);
});

test("revalidation: lists, sidebar and detail re-read on the runtime tick; wake waits for the fresh verification",()=>{
  for(const file of ["app/ui/target-scope-lists.tsx","app/ui/target-sidebar-projects.tsx","app/ui/target-detail-panel.tsx"])
    assert.match(read(file),/useTargetTick\(/,file);
  const lists=read("app/ui/target-scope-lists.tsx");
  // Re-walk to the loaded row count, replacing the rows only as a whole.
  assert.match(lists,/loadedRowCount\(current\.page\)/);
  assert.match(lists,/live\.loadFirst\(\)/);
  assert.match(lists,/live\.loadMore\(\)/);
  const hooks=read("app/ui/use-target-revalidation.ts");
  assert.match(hooks,/runtime\.subscribeTick\(/);
  assert.match(hooks,/document\.visibilityState==="hidden"\|\|!navigator\.onLine\)return;\s*\n\s*ref\.current\(\)/);
  assert.match(read("lib/target-client-runtime.ts"),/for\(const fn of \[\.\.\.tickSubscribers\]\)guarded\(fn\)/);
});

test("scope change does not carry the detail marker; close of the unavailable overlay keeps the view",()=>{
  assert.match(read("app/ui/target-scope-state.ts"),/pushState\(withoutDetailMarker\(window\.history\.state\)/);
  assert.match(read("app/ui/target-detail-state.ts"),/parentSearchForDetail\(\s*route,scopeFromSearch\(window\.location\.search\),window\.location\.search\)/);
});

test("focus: deeper opens never return focus to the list; the panel owns focus; the label follows the state",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.doesNotMatch(panel,/expectFocusReturn/);
  assert.match(rootSource,/if \(previous !== null && !isParentOf\(previous, detailRoute\)\) expectFocusReturn\(previous\)/);
  assert.match(panel,/state\.kind==="error"\?\(state\.reason==="hidden"\?copy\.hidden:copy\.failures\[state\.reason\]\)/);
});

test("sidebar target titles are not clipped by the legacy 18 px icon-slot rule",()=>{
  const css=read("app/ui/target-details.css");
  assert.match(css,/\.appShell > aside \.sidebarProjects\.targetSidebarProjects button > span\.targetSidebarProjectTitle\{/);
  assert.match(css,/width:auto/);
  assert.match(read("app/ui/target-sidebar-projects.tsx"),/className="targetSidebarProjectTitle"/);
});

test("the refusal budget is shared per runtime (gate hook and My Plan)",()=>{
  for(const file of ["app/ui/use-target-gate.ts","app/ui/target-my-plan.tsx"]){
    const source=read(file);
    assert.match(source,/refusalBudgetFor\(runtime\)/,file);
    assert.doesNotMatch(source,/createRefusalBudget\(\)/,file);
  }
});

test("mount rule: page.tsx wiring is checked literally, independent of targetDataNeeded",()=>{
  const page=read("app/page.tsx");
  assert.match(page,/const config = targetUiEnabled\(\) \? targetUiConfig\(process\.env\) : null;/);
  assert.match(page,/const targetData = targetDataNeeded\(config\);\s*return targetData\s*\?\s*<TargetDataProvider><LumiAppRoot targetMyPlan=\{config\?\.myPlan\} targetScopes=\{config\?\.scopes\} targetDetails=\{config\?\.details\} targetNoteEdit=\{Boolean\(config\?\.details\.note\) && targetNoteEditUiEnabled\(process\.env\)\} targetProjectEdit=\{Boolean\(config\?\.details\.project\) && targetProjectTitleEditUiEnabled\(process\.env\)\} targetPrivateNoteAreas=\{Boolean\(config\?\.scopes\.notes\)&&targetPrivateNoteAreaUiEnabled\(process\.env\)\} \/><\/TargetDataProvider>\s*:\s*<LumiAppRoot \/>;/);
  // The rule itself, literally: details are no consumer of their own.
  assert.match(read("lib/target-ui-config.ts"),/return config!==null&&\(config\.myPlan\.enabled\|\|config\.scopes\.projects\|\|config\.scopes\.notes\);/);
});
