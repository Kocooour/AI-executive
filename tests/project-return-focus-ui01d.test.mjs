import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { knownProjectFocusPosition, projectFocusReturnForHistory, shouldRestoreProjectFocus } from "../lib/project-return-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const listSearch = "?view=Projects";
const projectASearch = "?view=Projects&projectId=project-a";
const projectBSearch = "?view=Projects&projectId=project-b";
const positions = new Set(["list-1", "entry-a1", "entry-b", "entry-a2"]);
const intentA1 = {
  projectId: "project-a", workspaceId: "personal", view: "Projects",
  source: "content", originProjectId: null, originSearch: listSearch, originPositionId: "list-1",
};
const intentB = {
  projectId: "project-b", workspaceId: "personal", view: "Projects",
  source: "sidebar", originProjectId: "project-a", originSearch: projectASearch,
  originPositionId: "entry-a1",
};
const intentA2 = {
  projectId: "project-a", workspaceId: "personal", view: "Projects",
  source: "sidebar", originProjectId: "project-b", originSearch: projectBSearch,
  originPositionId: "entry-b",
};
const entries = new Map([
  ["entry-a1", { intent: intentA1, opener: "list-button-a" }],
  ["entry-b", { intent: intentB, opener: "sidebar-button-b" }],
  ["entry-a2", { intent: intentA2, opener: "sidebar-button-a" }],
]);

test("UI-01d: A→B→Back A→Back list keeps both separate opener intents", () => {
  const toA = projectFocusReturnForHistory("entry-b", entries, "entry-a1", projectASearch);
  assert.equal(toA?.opener, "sidebar-button-b");
  assert.equal(shouldRestoreProjectFocus(toA?.intent ?? null, {
    openProjectId: "project-a", workspaceId: "personal", view: "Projects",
    search: projectASearch, positionId: "entry-a1",
  }, true), true);
  const toList = projectFocusReturnForHistory("entry-a1", entries, "list-1", listSearch);
  assert.equal(toList?.opener, "list-button-a");
  assert.equal(shouldRestoreProjectFocus(toList?.intent ?? null, {
    openProjectId: null, workspaceId: "personal", view: "Projects",
    search: listSearch, positionId: "list-1",
  }, true), true);
  assert.equal(entries.size, 3, "Back must preserve intents for Forward and Back again");
});

test("UI-01d: A₁→B→A₂→Back→Back→Forward→Forward cannot mistake repeated A URLs for Back", () => {
  // A₁ and A₂ have the exact same URL but distinct browser-history positions.
  assert.equal(projectFocusReturnForHistory("entry-a2", entries, "entry-b", projectBSearch)?.opener,
    "sidebar-button-a", "Back from A₂ must return the button that opened A₂");
  assert.equal(projectFocusReturnForHistory("entry-b", entries, "entry-a1", projectASearch)?.opener,
    "sidebar-button-b", "Back from B must return B's opener on A₁");
  assert.equal(projectFocusReturnForHistory("entry-a1", entries, "entry-b", projectBSearch), null,
    "Forward from A₁ to B is never a focus return");
  assert.equal(projectFocusReturnForHistory("entry-b", entries, "entry-a2", projectASearch), null,
    "Forward to A₂ must NOT use B's opener from A₁ despite the duplicate URL");
  assert.equal(projectFocusReturnForHistory("entry-a2", entries, "entry-b", projectBSearch)?.opener,
    "sidebar-button-a", "another Back must still use the right intent");
});

test("UI-01d: exact destination history entry, route and scope must all match", () => {
  assert.equal(projectFocusReturnForHistory("entry-b", entries, "entry-a2", projectASearch), null,
    "origin search alone is insufficient when A appears twice in history");
  assert.equal(projectFocusReturnForHistory("entry-b", entries, "entry-a1", projectBSearch), null);
  assert.equal(projectFocusReturnForHistory("entry-b", entries, null, projectASearch), null);
  assert.equal(projectFocusReturnForHistory("unknown-token", entries, "entry-a1", projectASearch), null);
  assert.equal(projectFocusReturnForHistory(null, entries, "entry-a1", projectASearch), null);
  const current = {
    openProjectId: "project-a", workspaceId: "personal", view: "Projects",
    search: projectASearch, positionId: "entry-a1",
  };
  assert.equal(shouldRestoreProjectFocus(intentB, current, true), true);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, positionId: "entry-a2" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, positionId: null }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, workspaceId: "shared" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, view: "Today" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, search: projectBSearch }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, openProjectId: null }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, current, false), false,
    "revoked/deleted B is never a safe focus target");
  assert.equal(shouldRestoreProjectFocus(null, current, true), false,
    "direct URL without a local origin does not restore focus");
});

test("UI-01d: unrecognized or stale history.state never authenticates a focus position", () => {
  assert.equal(knownProjectFocusPosition({ lumiFocusEntry: "entry-a1" }, positions), "entry-a1");
  assert.equal(knownProjectFocusPosition({ lumiFocusEntry: "stale-after-reload" }, positions), null);
  assert.equal(knownProjectFocusPosition({ lumiFocusEntry: 123 }, positions), null);
  assert.equal(knownProjectFocusPosition({ other: "entry-a1" }, positions), null);
  assert.equal(knownProjectFocusPosition(null, positions), null);
  assert.equal(knownProjectFocusPosition("entry-a1", positions), null);
  assert.equal(knownProjectFocusPosition({ lumiFocusEntry: "entry-a1" }, new Set()), null);
});

test("UI-01d: clicking a project assigns fresh destination position and marks its origin", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /if \(!visibleProjectsRef\.current\.some\(\(visible\) => visible\.id === project\.id && visible\.workspaceId === project\.workspaceId\)\) return;/);
  assert.match(app, /active\.dataset\.projectOpen === project\.id/);
  assert.match(app, /querySelectorAll<HTMLButtonElement>\("button\[data-project-open\]"\)/);
  assert.match(app, /const focusEntryId = mobileDesignV1Preview \? crypto\.randomUUID\(\) : null;/);
  assert.match(app, /const originSearch = window\.location\.search;/);
  assert.match(app, /const originProjectId = openProjectIdRef\.current;/);
  assert.match(app, /originPositionId = knownProjectFocusPosition\(\s*window\.history\.state, knownProjectFocusPositionsRef\.current\)/);
  assert.match(app, /window\.history\.replaceState\(\{\s*\.\.\.\(originalState && typeof originalState === "object"/,
    "mark the original project/list history entry before opening the next one");
  assert.match(app, /window\.history\.pushState\(\{\s*lumiProject: project\.id,/);
  assert.match(app, /lumiFocusEntry: focusEntryId/);
  assert.match(app, /knownProjectFocusPositionsRef\.current\.add\(focusEntryId\)/);
  assert.match(app, /originSearch, originProjectId, originPositionId/);
  assert.match(app, /projectFocusEntriesRef\.current\.set\(focusEntryId,/);
  assert.match(app, /window\.history\.replaceState\(window\.history\.state \?\? \{ lumiProject: project\.id \}/,
    "reopening the same entry must preserve its identity");
});

test("UI-01d: popstate resolves exact departure and destination position before focus", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /const destinationFocusId = knownProjectFocusPosition\(\s*window\.history\.state, knownProjectFocusPositionsRef\.current\)/);
  assert.match(app, /pendingProjectFocusRef\.current = projectFocusReturnForHistory\(\s*activeProjectFocusEntryRef\.current, projectFocusEntriesRef\.current,\s*destinationFocusId, window\.location\.search\);/);
  assert.match(app, /activeProjectFocusEntryRef\.current = destinationFocusId;/);
  assert.match(app, /knownProjectFocusPosition\(window\.history\.state, knownProjectFocusPositionsRef\.current\) !==\s*pending\.intent\.originPositionId/);
  assert.match(app, /if \(openProjectId !== pending\.intent\.originProjectId \|\|\s*view !== pending\.intent\.view \|\| activeWorkspaceId !== pending\.intent\.workspaceId\) return;/);
  assert.match(app, /shouldRestoreProjectFocus\(pending\.intent,/);
  assert.match(app, /positionId: knownProjectFocusPosition\(window\.history\.state, knownProjectFocusPositionsRef\.current\)/);
  assert.match(app, /item\.id === pending\.intent\.projectId && item\.workspaceId === pending\.intent\.workspaceId/);
  assert.match(app, /button\.isConnected && button\.dataset\.projectOpen === pending\.intent\.projectId/);
  assert.match(app, /button\.getClientRects\(\)\.length > 0/);
  assert.match(app, /const target = eligible\(pending\.opener\) \? pending\.opener :/);
  assert.match(app, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /window\.addEventListener\("popstate", followAddress\)/);
  // C10 (#416): project Back skips any record-inspector history entries
  // created since opening the project; without them it remains one Back step.
  const close = app.match(/function closeProjectPage\(\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(close, "project Back must have a dedicated handler");
  assert.match(close, /if \(state\?\.lumiProject\) \{/);
  assert.match(close, /Number\.isSafeInteger\(state\.lumiProjectRecordSteps\)/);
  assert.match(close, /state\.lumiProjectRecordSteps > 0 \? state\.lumiProjectRecordSteps : 0/,
    "a project with no open record has zero extra history steps");
  assert.match(close, /window\.history\.go\(-\(recordSteps \+ 1\)\)/,
    "one Back step closes a project directly; additional record steps are skipped");
  assert.match(close, /searchWithScope\([\s\S]*scopeFromSearch\(window\.location\.search\)/,
    "direct project URLs close to a safe Projects list retaining reading scope");
  assert.doesNotMatch(close, /window\.history\.back\(\)/,
    "a single Back is insufficient after inspecting a project record");
  const inspect = app.match(/async function inspect\(e: Entity,[\s\S]*?\n  \}/)?.[0];
  assert.ok(inspect);
  assert.match(inspect, /lumiProjectRecordSteps: recordSteps/);
  assert.match(inspect, /lumiProject: parent/);
  assert.match(inspect, /lumiFocusEntry: projectOrigin\.lumiFocusEntry/,
    "record navigation keeps the current project focus position");
  assert.match(app, /pendingProjectFocusRef\.current = null;\s*activeProjectFocusEntryRef\.current = null;\s*setNavigationUnavailable\(false\)/,
    "explicit view navigation clears a pending focus return");
  assert.doesNotMatch(read("../lib/project-return-focus.ts"), /localStorage|sessionStorage|fetch\(|\.pushState/);
});

test("UI-01d: all project openers publish opaque IDs without changing navigation URLs", () => {
  const mobile = read("../app/ui/views/mobile-project-row-v1.tsx");
  const rows = read("../app/ui/views/entity-list.tsx");
  const sidebar = read("../app/ui/views/sidebar.tsx");
  assert.match(mobile, /<button type="button" className="taskRowOpen" data-project-open=\{project\.id\}/);
  assert.match(rows, /data-project-open=\{x\.type === "project" \? x\.id : undefined\}/);
  assert.match(sidebar, /data-sidebar-project=\{project\.id\}\s*data-project-open=\{project\.id\}/);
  assert.match(sidebar, /onClick=\{\(\) => void inspect\(project\)\}/);
  assert.match(mobile, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); void inspect\(project\); \}\}/);
});
