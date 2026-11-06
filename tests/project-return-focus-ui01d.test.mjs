import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectFocusReturnForHistory, shouldRestoreProjectFocus } from "../lib/project-return-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const listSearch = "?view=Projects";
const projectASearch = "?view=Projects&projectId=project-a";
const projectBSearch = "?view=Projects&projectId=project-b";
const intentA = {
  projectId: "project-a", workspaceId: "personal", view: "Projects",
  source: "content", originProjectId: null, originSearch: listSearch,
};
const intentB = {
  projectId: "project-b", workspaceId: "personal", view: "Projects",
  source: "sidebar", originProjectId: "project-a", originSearch: projectASearch,
};
const entries = new Map([
  ["entry-a", { intent: intentA, opener: "list-button-a" }],
  ["entry-b", { intent: intentB, opener: "sidebar-button-b" }],
]);

test("UI-01d: A→B→Back A→Back list keeps both separate opener intents", () => {
  const toA = projectFocusReturnForHistory("entry-b", entries, projectASearch);
  assert.equal(toA?.opener, "sidebar-button-b");
  assert.equal(shouldRestoreProjectFocus(toA?.intent ?? null, {
    openProjectId: "project-a", workspaceId: "personal", view: "Projects", search: projectASearch,
  }, true), true);

  // The next Back departs A, not B. It must restore the list's A button.
  const toList = projectFocusReturnForHistory("entry-a", entries, listSearch);
  assert.equal(toList?.opener, "list-button-a");
  assert.equal(shouldRestoreProjectFocus(toList?.intent ?? null, {
    openProjectId: null, workspaceId: "personal", view: "Projects", search: listSearch,
  }, true), true);
  assert.equal(entries.size, 2, "Back must preserve intents for Forward/Back later");
});

test("UI-01d: Forward never borrows a Back focus intent, repeated Back still works", () => {
  assert.equal(projectFocusReturnForHistory(null, entries, projectASearch), null,
    "Forward list→A has no departing project token");
  assert.equal(projectFocusReturnForHistory("entry-a", entries, projectBSearch), null,
    "Forward A→B does not match A's recorded origin list URL");
  assert.equal(projectFocusReturnForHistory("entry-b", entries, projectASearch)?.opener,
    "sidebar-button-b", "Back B→A again uses B's own token");
  assert.equal(projectFocusReturnForHistory("entry-a", entries, listSearch)?.opener,
    "list-button-a", "Back A→list again uses A's original token");
  assert.equal(projectFocusReturnForHistory("unknown-token", entries, listSearch), null,
    "history.state from a reloaded/pasted entry has no in-memory opener");
  assert.equal(projectFocusReturnForHistory("entry-b", entries, listSearch), null,
    "Back skipping the expected origin cannot borrow B's focus intent");
});

test("UI-01d: restoration requires committed route, same legacy workspace and local visibility", () => {
  const current = {
    openProjectId: "project-a", workspaceId: "personal", view: "Projects", search: projectASearch,
  };
  assert.equal(shouldRestoreProjectFocus(intentB, current, true), true);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, workspaceId: "shared" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, view: "Today" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, search: projectBSearch }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, { ...current, openProjectId: null }, true), false);
  assert.equal(shouldRestoreProjectFocus(intentB, current, false), false,
    "deleted/revoked B cannot receive focus");
  assert.equal(shouldRestoreProjectFocus(null, current, true), false,
    "direct URL without a local origin never focuses a stale button");
});

test("UI-01d: opening captures one token per new project history entry", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /if \(!visibleProjectsRef\.current\.some\(\(visible\) => visible\.id === project\.id && visible\.workspaceId === project\.workspaceId\)\) return;/);
  assert.match(app, /const active = document\.activeElement;/);
  assert.match(app, /active\.dataset\.projectOpen === project\.id/);
  assert.match(app, /querySelectorAll<HTMLButtonElement>\("button\[data-project-open\]"\)/);
  assert.match(app, /const focusEntryId = opener \? crypto\.randomUUID\(\) : null;/);
  assert.match(app, /const originProjectId = openProjectIdRef\.current;/);
  assert.match(app, /const originSearch = window\.location\.search;/);
  assert.match(app, /window\.history\.pushState\(\{\s*lumiProject: project\.id,/);
  assert.match(app, /lumiFocusEntry: focusEntryId/);
  assert.match(app, /projectFocusEntriesRef\.current\.set\(focusEntryId,/);
  assert.match(app, /window\.history\.replaceState\(window\.history\.state \?\? \{ lumiProject: project\.id \}/,
    "clicking the same project must preserve its existing entry identity");
});

test("UI-01d: popstate tracks outgoing vs incoming tokens and waits for committed destination", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /pendingProjectFocusRef\.current = projectFocusReturnForHistory\(\s*activeProjectFocusEntryRef\.current, projectFocusEntriesRef\.current, window\.location\.search\);/);
  assert.match(app, /activeProjectFocusEntryRef\.current = typeof destinationFocusId === "string" \? destinationFocusId : null;/);
  assert.match(app, /if \(openProjectId !== pending\.intent\.originProjectId \|\|\s*view !== pending\.intent\.view \|\| activeWorkspaceId !== pending\.intent\.workspaceId\) return;/);
  assert.match(app, /window\.location\.search !== pending\.intent\.originSearch/);
  assert.match(app, /shouldRestoreProjectFocus\(pending\.intent,/);
  assert.match(app, /item\.id === pending\.intent\.projectId && item\.workspaceId === pending\.intent\.workspaceId/);
  assert.match(app, /button\.isConnected && button\.dataset\.projectOpen === pending\.intent\.projectId/);
  assert.match(app, /button\.getClientRects\(\)\.length > 0/);
  assert.match(app, /const target = eligible\(pending\.opener\) \? pending\.opener :/);
  assert.match(app, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /window\.addEventListener\("popstate", followAddress\)/);
  assert.match(app, /if \(window\.history\.state\?\.lumiProject\) window\.history\.back\(\)/);
  assert.match(app, /pendingProjectFocusRef\.current = null;\s*activeProjectFocusEntryRef\.current = null;\s*setNavigationUnavailable\(false\)/,
    "explicit navigation clears active focus state");
  assert.doesNotMatch(read("../lib/project-return-focus.ts"), /localStorage|sessionStorage|fetch\(|\.pushState/);
});

test("UI-01d: all project openers publish the same opaque ID and no new URL params", () => {
  const mobile = read("../app/ui/views/mobile-project-row-v1.tsx");
  const rows = read("../app/ui/views/entity-list.tsx");
  const sidebar = read("../app/ui/views/sidebar.tsx");
  assert.match(mobile, /<button type="button" className="taskRowOpen" data-project-open=\{project\.id\}/);
  assert.match(rows, /data-project-open=\{x\.type === "project" \? x\.id : undefined\}/);
  assert.match(sidebar, /data-sidebar-project=\{project\.id\}\s*data-project-open=\{project\.id\}/);
  assert.match(sidebar, /onClick=\{\(\) => void inspect\(project\)\}/);
  assert.match(mobile, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); void inspect\(project\); \}\}/);
});
