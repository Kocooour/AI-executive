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

test("UI-03a: desktop FAB is preview-only, accessible and uses existing private-first capture", () => {
  const fab = read("../app/ui/views/desktop-capture-fab.tsx");
  const page = read("../app/page.tsx");
  assert.match(fab, /if \(!mobileDesignV1Preview\) return null/);
  assert.match(fab, /window\.matchMedia\("\(min-width: 701px\)"\)/);
  assert.match(fab, /state\.capture \|\| state\.assistantOpen \|\| state\.moreOpen/);
  assert.match(fab, /state\.selected \|\| state\.confirmRequest/);
  assert.match(fab, /document\.querySelector\('\[aria-modal="true"\]'\)/);
  assert.match(fab, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(fab, /window\.removeEventListener\("keydown", onKeyDown\)/);
  assert.match(fab, /desktopCaptureShortcut\(event, editable, blocked\)/);
  assert.match(fab, /event\.preventDefault\(\);\s*state\.openCapture\(\)/);
  assert.match(fab, /data-desktop-capture-fab disabled=\{blocked\}/);
  assert.match(fab, /aria-label=\{app\.tr\("quickCapture"\)\}/);
  assert.match(fab, /onClick=\{\(\) => app\.openCapture\(\)\}/);
  assert.match(page, /<DesktopCaptureFab app=\{app\} \/>/);
  // No new persistence/auth logic: both keyboard and button use one existing handler.
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /function openCapture\(type: "task" \| "note" = "task", projectId = ""\)/);
  assert.match(app, /initialCaptureWorkspace\(projectWorkspaceId, personalWorkspaceId\)/);
});

test("UI-03a: direct desktop views and untruncated workspace-scoped projects remain independent of legacy", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(sidebar, /\{\(mobileDesignV1Preview \|\| secondaryOpen\) && \(/);
  assert.match(sidebar, /\{!mobileDesignV1Preview && \(\s*<>/);
  assert.match(sidebar, /className="secondaryNav"/);
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
  assert.match(css, /grid-template-areas:\s*"workspace assistant"\s*"search search"/);
});
