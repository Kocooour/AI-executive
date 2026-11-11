import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { desktopCaptureShortcut } from "../lib/desktop-shell-ui03a.ts";
import { activeSidebarProjects } from "../lib/project-navigation.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const key = {
  code: "Period", key: ">", metaKey: true, ctrlKey: false, shiftKey: true,
  altKey: false, repeat: false, defaultPrevented: false, isComposing: false,
};

test("UI-03a: Cmd/Ctrl+Shift+Period opens desktop capture without hijacking text editing", () => {
  assert.equal(desktopCaptureShortcut(key, false, false), true);
  assert.equal(desktopCaptureShortcut({ ...key, metaKey: false, ctrlKey: true }, false, false), true);
  assert.equal(desktopCaptureShortcut({ ...key, key: ":", code: "Period" }, false, false), true,
    "physical Period also works on Czech keyboard layouts");
  assert.equal(desktopCaptureShortcut({ ...key, code: "", key: "." }, false, false), true);
  assert.equal(desktopCaptureShortcut({ ...key, code: "", key: ">" }, false, false), true);
  assert.equal(desktopCaptureShortcut(key, true, false), false);
  assert.equal(desktopCaptureShortcut(key, false, true), false);
  assert.equal(desktopCaptureShortcut({ ...key, repeat: true }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, defaultPrevented: true }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, isComposing: true }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, shiftKey: false }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, altKey: true }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, metaKey: false, ctrlKey: false }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, metaKey: true, ctrlKey: true }, false, false), false);
  assert.equal(desktopCaptureShortcut({ ...key, code: "KeyL", key: "L" }, false, false), false);
});

test("UI-03a: desktop FAB preserves legacy private-first capture and separately gates target private note capture", () => {
  const fab = read("../app/ui/views/desktop-capture-fab.tsx");
  const page = read("../app/ui/lumi-app-root.tsx");
  assert.match(fab, /if \(!mobileDesignV1Preview\) return null/);
  assert.match(fab, /window\.matchMedia\("\(min-width: 701px\)"\)/);
  assert.match(fab, /state\.capture \|\| state\.assistantOpen \|\| state\.moreOpen/);
  assert.match(fab, /state\.confirmRequest \|\| state\.offlineView \|\| targetState\.current\.open \|\|\s*document\.querySelector/);
  const keyBlock = fab.slice(fab.indexOf("const blocked = Boolean(state.capture"), fab.indexOf("if (!desktopCaptureShortcut"));
  assert.doesNotMatch(keyBlock, /state\.selected/, "nonmodal desktop inspector must not block capture shortcut");
  assert.match(fab, /document\.querySelector\('\[aria-modal="true"\]'\)/);
  assert.match(fab, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(fab, /window\.removeEventListener\("keydown", onKeyDown\)/);
  assert.match(fab, /desktopCaptureShortcut\(event, editable, blocked\)/);
  assert.match(fab, /event\.preventDefault\(\);\s*if\(targetState\.current\.onOpen\)targetState\.current\.onOpen\(\);\s*else state\.openCapture\(\)/);
  assert.match(fab, /data-desktop-capture-fab data-target-private-capture-fab=\{onTargetCapture\?"desktop":undefined\}/);
  assert.match(fab, /const label=onTargetCapture/);
  assert.match(fab, /aria-label=\{label\}/);
  assert.match(fab, /onClick=\{onTargetCapture \?\? \(\(\)=>app\.openCapture\(\)\)\}/);
  assert.match(page, /<DesktopCaptureFab app=\{app\} onTargetCapture=\{targetCapture\?\(\)=>openAreaChooser\(\):undefined\}/);
  // Legacy write is still reached only when an independently gated target callback
  // is absent; unified target mode never falls through to the old writer.
  assert.match(fab, /if \(state\.captureDisabled && !targetState\.current\.onOpen\) return;/);
  assert.match(fab, /if \(app\.captureDisabled && !onTargetCapture\) return null;/);
  assert.match(page, /const targetCapture=Boolean\(scopesOn&&targetScopes\?\.notes&&targetPrivateNoteAreas&&\s*targetPrivateNoteCreate&&mobileDesignV1Preview\)/);
  assert.match(fab, /document\.querySelector\('\[aria-modal="true"\]'\)/);
  // Legacy handler remains independently private-first when target flags are off.
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /function openCapture\(type: "task" \| "note" = "task", projectId = ""\)/);
  assert.match(app, /initialCaptureWorkspace\(projectWorkspaceId, personalWorkspaceId\)/);
});

test("UI-03a: direct desktop views and untruncated workspace-scoped projects remain independent of legacy", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(sidebar, /\{mobileDesignV1Preview && \(\s*<div className="secondaryNav"/);
  assert.match(sidebar, /\{!mobileDesignV1Preview && secondaryOpen && \(/);
  assert.match(sidebar, /\{!mobileDesignV1Preview && \(\s*<>/);
  assert.match(sidebar, /className="secondaryNav"/);
  assert.match(sidebar, /data-desktop-v1-direct-views/);
  assert.match(sidebar, /role="navigation"/);
  const directNav = sidebar.indexOf("data-desktop-v1-direct-views");
  const projects = sidebar.indexOf("{sidebarProjects.length > 0 && (");
  const legacyNav = sidebar.indexOf("{!mobileDesignV1Preview && secondaryOpen && (");
  assert.ok(directNav > 0 && directNav < projects && projects < legacyNav,
    "v1 direct views must precede all 26 project rows, legacy More remains below projects");
  assert.match(app, /activeSidebarProjects\(\s*projects, activeWorkspaceId, mobileDesignV1Preview \? Number\.POSITIVE_INFINITY : undefined/);
  const project = (id, workspaceId = "personal", status = "active") =>
    ({ id, type: "project", title: id, workspaceId, status, properties: {}, createdAt: Number(id.slice(1)) || 0, updatedAt: 1 });
  const records = [...Array.from({ length: 26 }, (_, n) => project(`p${n + 1}`)),
    project("p50", "shared"), project("p51", "personal", "completed")];
  const all = activeSidebarProjects(records, "personal", Number.POSITIVE_INFINITY);
  assert.equal(all.length, 26);
  assert.ok(all.every((item) => item.workspaceId === "personal" && item.status === "active"));
  assert.equal(activeSidebarProjects(records, "personal").length, 7, "legacy limit remains unchanged");
  assert.equal(activeSidebarProjects(records, "all", Number.POSITIVE_INFINITY).length, 0,
    "the old aggregate must not grant inferred cross-workspace access");
});

test("UI-03a: v1 header removes the theme toggle but Settings retains system/light/dark", () => {
  const topbar = read("../app/ui/views/topbar.tsx");
  const settings = read("../app/ui/views/settings-view.tsx");
  assert.match(topbar, /\{!mobileDesignV1Preview && \(\s*<button\s+className="themeToggle"/);
  assert.match(topbar, /<label className="searchField">/);
  assert.match(topbar, /onClick=\{\(\) => setAssistantOpen\(true\)\}/);
  assert.match(settings, /<option value="system">/);
  assert.match(settings, /<option value="light">/);
  assert.match(settings, /<option value="dark">/);
  assert.match(settings, /saveTheme\(event\.target\.value as ThemeMode\)/);
});

test("UI-03a: purple FAB stays outside inspector and actions in a reserved scroll rail", () => {
  const css = read("../app/lumi-desktop-v1.css");
  const layout = read("../app/layout.tsx");
  assert.match(layout, /import "\.\/lumi-desktop-v1\.css"/);
  assert.match(css, /\.desktopCaptureFab \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 701px\)/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\] \.desktopCaptureFab/);
  assert.match(css, /background: var\(--v1-accent\)/);
  assert.match(css, /color: var\(--v1-on-accent\)/);
  assert.match(css, /padding-inline-end: 112px/);
  assert.match(css, /padding-block-end: 120px/);
  assert.match(css, /scroll-margin-block-end: 122px/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\]\.inspectorOpen \.desktopCaptureFab/);
  assert.match(css, /:has\(\[aria-modal="true"\]\) \.desktopCaptureFab/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\]\.inspectorOpen > aside \.desktopInspectorCapture/);
  assert.match(css, /grid-template-areas:\s*"workspace assistant"\s*"search search"/);
});


test("UI-03a: legacy inspector sidebar remains usable at desktop breakpoints; target detail traps its own capture", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const fab = read("../app/ui/views/desktop-capture-fab.tsx");
  const css = read("../app/lumi-desktop-v1.css");
  const inspectorCss = read("../app/lumi-inspector.css");
  // At both desktop breakpoints the existing sidebar is not a blocking modal.
  assert.match(inspectorCss, /@media \(min-width: 1200px\)/);
  assert.match(inspectorCss, /@media \(min-width: 701px\) and \(max-width: 1199px\)/);
  assert.match(sidebar, /\{mobileDesignV1Preview && app\.selected && !onTargetCapture && !app\.captureDisabled && \(\s*<button/);
  assert.doesNotMatch(sidebar, /targetInspectorOpen/);
  const targetDetail=read("../app/ui/target-detail-panel.tsx");
  assert.match(targetDetail, /role="dialog" aria-modal="true"/);
  assert.match(targetDetail, /data-testid="target-detail-capture"/);
  assert.match(targetDetail, /onClick=\{onPrivateCapture\}/);
  assert.match(sidebar, /data-desktop-inspector-capture/);
  assert.match(sidebar, /aria-label=\{tr\("quickCapture"\)\}/);
  assert.match(sidebar, /disabled=\{Boolean\(app\.capture \|\| app\.assistantOpen \|\| app\.moreOpen \|\| app\.confirmRequest\)\}/);
  assert.match(sidebar, /onClick=\{\(\) => openCapture\(\)\}/);
  assert.match(css, /\.inspectorOpen > aside \.desktopInspectorCapture \{/);
  assert.match(css, /\.desktopInspectorCapture:focus-visible/);
  assert.match(css, /\.desktopInspectorCapture:disabled/);
  assert.match(css, /min-height: 44px/);
  // The floating action remains hidden near an inspector; keyboard and
  // accessible sidebar button are still available, but true modals block both.
  assert.match(css, /\.inspectorOpen \.desktopCaptureFab/);
  const keyboardBlock = fab.slice(fab.indexOf("const blocked = Boolean(state.capture"),
    fab.indexOf("if (!desktopCaptureShortcut"));
  assert.doesNotMatch(keyboardBlock, /state\.selected/);
  assert.match(keyboardBlock, /state\.confirmRequest/);
  assert.match(keyboardBlock, /aria-modal/);
  assert.equal(desktopCaptureShortcut(key, false, false), true,
    "nonmodal inspector does not enter the blocked state");
  assert.equal(desktopCaptureShortcut(key, false, true), false,
    "modal overlay still blocks the shortcut");
});

test("UI-03a: 26+ projects do not push direct destinations below projects", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const css = read("../app/lumi-navigation.css");
  const previewNav = sidebar.indexOf("data-desktop-v1-direct-views");
  const firstProject = sidebar.indexOf("{sidebarProjects.length > 0");
  const legacyMore = sidebar.indexOf("{!mobileDesignV1Preview && secondaryOpen");
  assert.ok(previewNav >= 0 && previewNav < firstProject && legacyMore > firstProject);
  assert.match(sidebar, /aria-label=\{tr\("moreViews"\)\} data-desktop-v1-direct-views/);
  assert.match(sidebar, /\{secondaryViews\.map\(\(x\) => <button/);
  assert.match(sidebar, /<section className="sidebarProjects"/);
  assert.match(css, /\.appShell > aside > \.sidebarScroll \{/);
  assert.match(css, /overflow-y: auto/);
  const records = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`, title: `Project ${i}`, type: "project", status: "active",
    workspaceId: "personal", properties: {}, createdAt: i + 1, updatedAt: 1,
  }));
  assert.equal(activeSidebarProjects(records, "personal", Number.POSITIVE_INFINITY).length, 30);
  assert.equal(activeSidebarProjects(records, "personal").length, 7);
});
