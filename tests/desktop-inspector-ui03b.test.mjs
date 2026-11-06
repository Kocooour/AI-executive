import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectorPreviewEscapeAllowed } from "../lib/desktop-inspector-ui03b.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const escape = { key: "Escape", defaultPrevented: false, isComposing: false,
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

test("UI-03b: only bare, unhandled Escape closes an inspector when no editor or modal owns it", () => {
  assert.equal(inspectorPreviewEscapeAllowed(escape, false, false), true);
  assert.equal(inspectorPreviewEscapeAllowed({ ...escape, key: "Enter" }, false, false), false);
  assert.equal(inspectorPreviewEscapeAllowed({ ...escape, key: "Esc" }, false, false), false);
  assert.equal(inspectorPreviewEscapeAllowed({ ...escape, defaultPrevented: true }, false, false), false);
  assert.equal(inspectorPreviewEscapeAllowed({ ...escape, isComposing: true }, false, false), false);
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
    assert.equal(inspectorPreviewEscapeAllowed({ ...escape, [modifier]: true }, false, false), false,
      `modified Escape with ${modifier} must not hijack browser/editor actions`);
  }
  assert.equal(inspectorPreviewEscapeAllowed(escape, true, false), false,
    "editable input, textarea, select or contenteditable retains Escape ownership");
  assert.equal(inspectorPreviewEscapeAllowed(escape, false, true), false,
    "a nested listbox/menu/dialog or a global modal retains Escape ownership");
});

test("UI-03b: shared desktop/mobile inspector wires preview-only guarded Escape to URL-safe Close", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(detail, /import \{ inspectorPreviewEscapeAllowed \} from "\.\.\/\.\.\/\.\.\/lib\/desktop-inspector-ui03b"/);
  assert.match(detail, /if \(!mobileDesignV1Preview\) return;/);
  assert.match(detail, /onKeyDown=\{\(event\) => \{/);
  assert.match(detail, /inspectorPreviewEscapeAllowed\(event\.nativeEvent, editing, blocking\)/);
  assert.match(detail, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*closeInspector\(\)/);
  assert.match(detail, /app\.capture \|\| app\.moreOpen \|\| app\.assistantOpen/);
  assert.match(detail, /app\.confirmRequest \|\| document\.querySelector\('\[aria-modal="true"\]'\)/);
  assert.match(detail, /\[role="listbox"\], \[role="menu"\], \[role="dialog"\]/);
  assert.match(detail, /input, textarea, select, \[contenteditable\]/);
  assert.match(detail, /ref=\{inspectorRef\} tabIndex=\{-1\}/);
  assert.match(detail, /className="close inspectorClose"/);
  assert.match(app, /function closeInspector\(\)/);
  assert.match(app, /if \(window\.history\.state\?\.lumiRecord === target\.id\) \{/);
  assert.match(app, /window\.history\.back\(\)/);
  assert.match(app, /searchForView\(target\.view, startupView\)/);
});

test("UI-03b: current secondary view receives aria-current without changing legacy menu semantics", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const css = read("../app/lumi-desktop-v1.css");
  const previewStart = sidebar.indexOf("{mobileDesignV1Preview && (");
  const previewEnd = sidebar.indexOf("{sidebarProjects.length > 0 && (", previewStart);
  const legacyStart = sidebar.indexOf("{!mobileDesignV1Preview && secondaryOpen && (");
  const legacyEnd = sidebar.indexOf("</div>", legacyStart);
  assert.ok(previewStart > 0 && previewEnd > previewStart && legacyStart > previewEnd);
  const preview = sidebar.slice(previewStart, previewEnd);
  const legacy = sidebar.slice(legacyStart, legacyEnd);
  assert.match(preview, /role="navigation"/);
  assert.match(preview, /aria-current=\{view === x \? "page" : undefined\}/);
  assert.match(preview, /data-nav-view=\{x\}/);
  assert.doesNotMatch(legacy, /aria-current/, "preview only: no changed legacy More contract");
  assert.match(css, /\.secondaryNav button\[aria-current="page"\]/);
  assert.match(css, /background: var\(--workspace-soft\)/);
});

test("UI-03b: selected project is exposed as the current page in the in-scope full project list", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const css = read("../app/lumi-desktop-v1.css");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(sidebar, /mobileDesignV1Preview && app\.openProject\?\.id === project\.id \? "active" : ""/);
  assert.match(sidebar, /aria-current=\{mobileDesignV1Preview && app\.openProject\?\.id === project\.id \? "page" : undefined\}/);
  assert.match(sidebar, /data-current-project=\{mobileDesignV1Preview && app\.openProject\?\.id === project\.id \? "true" : undefined\}/);
  assert.match(css, /\.sidebarProjects button\[data-current-project="true"\]/);
  assert.match(app, /const sidebarProjects = activeSidebarProjects\(/);
  assert.match(app, /mobileDesignV1Preview \? Number\.POSITIVE_INFINITY : undefined/);
  assert.match(app, /function openProjectPage\(project: Entity\)/);
  assert.match(app, /visibleProjectsRef\.current\.some\(\(visible\) => visible\.id === project\.id && visible\.workspaceId === project\.workspaceId\)/);
  assert.match(app, /setOpenProjectId\(project\.id\)/);
});

test("UI-03b: inspector and sidebar active styles remain preview-only and do not introduce writes", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const css = read("../app/lumi-desktop-v1.css");
  const nav = read("../app/ui/navigation.ts");
  assert.match(nav, /NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW === "1"/);
  assert.match(detail, /if \(!mobileDesignV1Preview\) return;/);
  assert.match(sidebar, /\{mobileDesignV1Preview && \(/);
  assert.match(css, /@media \(min-width: 701px\)/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\] > aside/);
  assert.doesNotMatch(css, /\[data-current-project\].*\{[^}]*!important/s);
});
