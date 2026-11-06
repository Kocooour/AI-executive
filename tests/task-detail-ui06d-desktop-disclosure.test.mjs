import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("UI-06d: desktop and mobile preview share the essentials-first DOM/tab order", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  assert.match(detail, /\{\(mobileTaskPreview \|\| desktopTaskPreview\)\s*\?\s*\[essentialsSection, notesSection, workButton, moreButton, listSection, optionsSection, actionsSection\]/);
  assert.match(detail, /:\s*\[listSection, essentialsSection, optionsSection, notesSection, moreButton, workButton, actionsSection\]/,
    "preview-off legacy desktop retains the existing order and advanced controls");
  assert.match(detail, /const desktopTaskPreview = Boolean\(mobileDesignV1Preview && mobileViewport === false && selectedTask\);/);
  assert.match(detail, /const mobileTaskPreview = Boolean\(mobileDesignV1Preview && mobileViewport && selectedTask\);/);
  assert.match(detail, /const \[mobileViewport, setMobileViewport\] = useState<boolean \| null>\(null\);/,
    "desktop/mobile-specific controls must not render before the viewport has resolved");
});

test("UI-06d: secondary task sections stay mounted and share one accessible disclosure", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  assert.match(detail, /const \[taskMoreOpen, setTaskMoreOpen\] = useState\(false\);/);
  assert.match(detail, /useEffect\(\(\) => \{ setTaskMoreOpen\(false\); \}, \[selected\?\.id\]\);/,
    "opening a different task resets secondary controls to the simplified view");
  assert.match(detail, /const moreButton = \(\s*<button key="toggle" type="button" className="taskDetailMoreToggle"/);
  assert.match(detail, /aria-controls=\{\`task-more-list-\$\{selected\.id\} task-more-options-\$\{selected\.id\} task-more-actions-\$\{selected\.id\}\`\}/);
  assert.match(detail, /aria-expanded=\{taskMoreOpen\}/);
  assert.match(detail, /onClick=\{\(\) => setTaskMoreOpen\(\(open\) => !open\)\}/);
  for (const [key,group] of [["list","List"],["options","Options"],["actions","Actions"]]) {
    assert.ok(detail.includes('key="' + key + '" className="taskDetailMoreGroup taskDetailMore' + group + '"'),
      group + " is a stable keyed React node, hidden by CSS rather than unmounted");
    assert.ok(detail.includes('id={\`task-more-' + key + '-\${selected.id}\`}'),
      "aria-controls points to the real " + key + " section");
  }
  assert.match(detail, /data-task-more-open=\{taskMoreOpen \? "true" : "false"\}/);
  assert.match(detail, /const notesSection = \(\s*<div key="notes" className="taskDetailNotes"/);
  assert.match(detail, /const essentialsSection = \(\s*<div key="essentials" className="taskDetailEssentials"/);
});

test("UI-06d: desktop-only disclosure is keyboard-accessible, scoped, and hides entire advanced groups", () => {
  const css = read("../app/lumi-task-detail-v1.css");
  const start = css.indexOf("/* UI-06d:");
  assert.notEqual(start, -1);
  const desktop = css.slice(start);
  assert.match(desktop, /@media \(min-width: 701px\) \{/);
  assert.match(desktop, /data-design-system="lumi-v1"/);
  assert.match(desktop, /data-task-detail-desktop-preview="lumi-v1"/);
  assert.match(desktop, /\.taskDetailFields > \.taskDetailMoreToggle \{\s*display: flex;/);
  assert.match(desktop, /min-height: 44px;/);
  assert.match(desktop, /\.taskDetailMoreToggle:focus-visible/);
  assert.match(desktop, /\.taskDetailFields\[data-task-more-open="false"\] > \.taskDetailMoreGroup \{\s*display: none;/);
  assert.match(desktop, /\.taskDetailFields > \.taskDetailEssentials/);
  assert.match(desktop, /\.taskDetailFields > \.taskDetailNotes/);
  assert.doesNotMatch(desktop, /\border\s*:/,
    "CSS never reorders keyboard targets independently of their DOM order");
  const mobileCss = css.slice(0, start);
  assert.match(mobileCss, /@media \(max-width: 700px\)/);
  assert.match(mobileCss, /\.taskDetailFields\[data-task-more-open="false"\] > \.taskDetailMoreGroup \{/);
});

test("UI-06d: work-session finishing and the single guarded task completion remain outside disclosure", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  assert.match(detail, /const workButton = \(mobileTaskPreview \|\| desktopTaskPreview\) && activeTaskSession \?/);
  assert.match(detail, /const taskPreviewMayToggle = taskPreviewCanToggle\(selectedTask, app\.activeWorkspaceId,/);
  assert.match(detail, /entityConflicts\(selectedTask\)\.length > 0 \|\| activeTaskSession/);
  assert.match(detail, /\{desktopTaskPreview && selectedTask && \(\s*<LumiCompletionControl kind="task"/);
  assert.match(detail, /disabled=\{!taskPreviewMayToggle\}/);
  assert.match(detail, /\{!mobileDesignV1Preview && \(selected.status === "completed" \?/,
    "preview cannot fall back to the unguarded legacy completion before hydration");
  const pos = detail.indexOf("? [essentialsSection, notesSection, workButton, moreButton");
  assert.ok(pos !== -1, "separate session finish action must precede collapsed groups in DOM/tab order");
});
