import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldRestoreProjectFocus } from "../lib/project-return-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const intent = { projectId: "project-one", workspaceId: "shared-1", view: "Today", source: "sidebar" };

test("UI-01d: project Back restores focus only in the original authorized view and workspace", () => {
  const current = { openProjectId: null, workspaceId: "shared-1", view: "Today" };
  assert.equal(shouldRestoreProjectFocus(intent, current, true), true);
  assert.equal(shouldRestoreProjectFocus(intent, { ...current, workspaceId: "personal" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intent, { ...current, view: "Projects" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intent, { ...current, openProjectId: "project-two" }, true), false);
  assert.equal(shouldRestoreProjectFocus(intent, current, false), false, "deleted/revoked project cannot be focused");
  assert.equal(shouldRestoreProjectFocus(null, current, true), false, "pasted direct link has no opener");
});

test("UI-01d: only user-opened preview project captures an existing local opener", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /if \(!visibleProjectsRef\.current\.some\(\(visible\) => visible\.id === project\.id && visible\.workspaceId === project\.workspaceId\)\) return;/);
  assert.match(app, /if \(mobileDesignV1Preview\) \{\s*const active = document\.activeElement;/);
  assert.match(app, /active\.dataset\.projectOpen === project\.id/);
  assert.match(app, /querySelectorAll<HTMLButtonElement>\("button\[data-project-open\]"\)/);
  assert.match(app, /intent: \{ projectId: project\.id, workspaceId: activeWorkspaceRef\.current, view,/);
  assert.match(app, /source: opener\.closest\("aside"\) \? "sidebar" : "content"/);
  assert.match(app, /projectReturnFocusRef\.current = opener \?/);
  assert.match(app, /projectReturnFocusRef\.current = null;\s*setNavigationUnavailable\(false\)/,
    "explicit tab navigation cancels the pending focus return");
});

test("UI-01d: Back/Forward restores only after view commit and never focuses revoked or hidden opener", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /if \(!mobileDesignV1Preview \|\| openProjectId !== null \|\| !projectReturnFocusRef\.current\) return;/);
  assert.match(app, /item\.id === pending\.intent\.projectId && item\.workspaceId === pending\.intent\.workspaceId/);
  assert.match(app, /shouldRestoreProjectFocus\(pending\.intent,/);
  assert.match(app, /button\.isConnected && button\.dataset\.projectOpen === pending\.intent\.projectId/);
  assert.match(app, /button\.getClientRects\(\)\.length > 0/);
  assert.match(app, /const target = eligible\(pending\.opener\) \? pending\.opener :/);
  assert.match(app, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /if \(window\.history\.state\?\.lumiProject\) window\.history\.back\(\)/);
  assert.match(app, /window\.addEventListener\("popstate", followAddress\)/);
  assert.doesNotMatch(read("../lib/project-return-focus.ts"), /localStorage|sessionStorage|fetch\(|\.pushState/);
});

test("UI-01d: mobile rows, legacy project rows and desktop sidebar expose opaque focus target IDs", () => {
  const mobile = read("../app/ui/views/mobile-project-row-v1.tsx");
  const rows = read("../app/ui/views/entity-list.tsx");
  const sidebar = read("../app/ui/views/sidebar.tsx");
  assert.match(mobile, /<button type="button" className="taskRowOpen" data-project-open=\{project\.id\}/);
  assert.match(rows, /data-project-open=\{x\.type === "project" \? x\.id : undefined\}/);
  assert.match(sidebar, /data-sidebar-project=\{project\.id\}\s*data-project-open=\{project\.id\}/);
  assert.match(sidebar, /onClick=\{\(\) => void inspect\(project\)\}/);
  assert.match(mobile, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); void inspect\(project\); \}\}/);
});
