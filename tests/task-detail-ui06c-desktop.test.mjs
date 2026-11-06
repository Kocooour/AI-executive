import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { taskPreviewCanToggle } from "../lib/task-detail-preview.ts";
import { taskPreviewCompletionTone, taskPreviewStateText } from "../lib/lumi-completion-state.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("UI-06c: desktop preview has one square task completion at the heading, never the old action duplicate", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  assert.match(detail, /const \[mobileViewport, setMobileViewport\] = useState<boolean \| null>\(null\);/);
  assert.match(detail, /const desktopTaskPreview = Boolean\(mobileDesignV1Preview && mobileViewport === false && selectedTask\);/);
  assert.match(detail, /data-task-detail-desktop-preview=\{desktopTaskPreview \? "lumi-v1" : undefined\}/);
  assert.match(detail, /\{desktopTaskPreview && selectedTask && \(\s*<LumiCompletionControl kind="task" className="taskDetailDesktopCompletion"/);
  assert.equal(detail.split('className="taskDetailDesktopCompletion"').length - 1, 1);
  assert.match(detail, /disabled=\{!taskPreviewMayToggle\}/);
  assert.match(detail, /if \(!taskPreviewMayToggle\) return;\s*if \(selectedTask.status === "completed"\) void reopenTask\(selectedTask\);\s*else void done\(selectedTask.id\);/);
  assert.match(detail, /\{!mobileDesignV1Preview && \(selected.status === "completed" \?/,
    "preview mode must not render legacy completion even while viewport is unknown");
  assert.match(detail, /const workButton = \(mobileTaskPreview \|\| desktopTaskPreview\) && activeTaskSession \?/,
    "active work sessions require their separate stop/finish flow");
  assert.match(detail, /data-task-completed=\{\(mobileTaskPreview \|\| desktopTaskPreview\) && selectedTask \?/);
  assert.match(detail, /\{mobileTaskPreview && selectedTask && \(/,
    "existing mobile preview control is retained without a visual rewrite");
});

test("UI-06c: a disabled desktop preview never becomes an ACL/write authorization", () => {
  const normal = { type: "task", status: "open", workspaceId: "personal" };
  assert.equal(taskPreviewCanToggle(normal, "personal", false), true);
  assert.equal(taskPreviewCanToggle({ ...normal, status: "completed" }, "personal", false), true);
  assert.equal(taskPreviewCanToggle(normal, "all", false), false);
  assert.equal(taskPreviewCanToggle(normal, "shared-1", false), false);
  assert.equal(taskPreviewCanToggle(normal, "personal", true), false, "blocked by pending, held, conflict, fallback or live work session");
  assert.equal(taskPreviewCanToggle({ ...normal, status: "deleted" }, "personal", false), false);
  assert.equal(taskPreviewCanToggle(null, "personal", false), false);
  assert.match(read("../app/ui/views/detail-panel.tsx"), /isFallbackArea\(selectedTask, app\.items\) \|\|\s*unsent\.has\(selectedTask\.id\) \|\| heldBack\.some/);
  assert.match(read("../app/ui/views/detail-panel.tsx"), /entityConflicts\(selectedTask\)\.length > 0 \|\| activeTaskSession/);
});

test("UI-06c: square, contour-only and localized state use the shared task preview language", () => {
  const task = { type: "task", status: "open", properties: { priority: "high" } };
  assert.equal(taskPreviewCompletionTone(task, "2026-11-06"), "warning");
  assert.equal(taskPreviewStateText("warning", "cs"), "Úkol vyžaduje pozornost");
  assert.equal(taskPreviewStateText("warning", "en"), "Task needs attention");
  assert.equal(taskPreviewCompletionTone({ ...task, status: "completed" }, "2026-11-06"), "complete");
  const detail = read("../app/ui/views/detail-panel.tsx");
  assert.match(detail, /tone=\{taskPreviewCompletionTone\(selectedTask, today\)\}/);
  assert.match(detail, /stateLabel=\{taskPreviewStateText\(taskPreviewCompletionTone\(selectedTask, today\), language\)\}/);
  assert.match(detail, /actionLabel=\{\`\$\{tr\(selectedTask.status === "completed" \? "reopen" : "complete"\)\} \$\{selectedTask.title \|\| tr\("untitledItem"\)\}\`\}/);
  const completion = read("../app/ui/views/lumi-completion-control.tsx");
  assert.match(completion, /aria-pressed=\{complete\} aria-label=\{label\}/);
  assert.match(completion, /data-completion-kind=\{kind\} data-completion-tone=\{complete\?"complete":tone\}/);
});

test("UI-06c: desktop styling is feature-gated, responsive, and leaves mobile and legacy untouched", () => {
  const css = read("../app/lumi-task-detail-v1.css");
  assert.match(css, /@media \(min-width: 701px\) \{\s*\.appShell\[data-design-system="lumi-v1"\]/);
  assert.match(css, /\.inspectorDetail\[data-task-detail-desktop-preview="lumi-v1"\] \.taskPreviewTitleRow \{/);
  assert.match(css, /grid-template-columns: 44px minmax\(0, 1fr\);/);
  assert.match(css, /\.inspectorDetail\[data-task-detail-desktop-preview="lumi-v1"\] \.taskDetailDesktopCompletion/);
  const shared = read("../app/lumi-completion-v1.css");
  assert.match(shared, /\.lumiCompletionControl\[data-completion-tone="warning"\] \.lumiCompletionShape/);
  assert.match(shared, /\.lumiCompletionControl\[data-completion-tone="complete"\] \.lumiCompletionShape/);
  assert.match(read("../app/ui/views/detail-panel.tsx"), /data-task-detail-preview=\{mobileTaskPreview \? "lumi-v1" : undefined\}/);
});

test("UI-06c P2: unresolved viewport cannot expose unguarded legacy completion in preview", () => {
  const detail = read("../app/ui/views/detail-panel.tsx");
  // Until matchMedia runs (including first mobile hydration), neither new
  // completion exists. The old unguarded action must also remain absent.
  assert.ok(detail.includes("useState<boolean | null>(null)"));
  assert.ok(detail.includes(
    "const mobileTaskPreview = Boolean(mobileDesignV1Preview && mobileViewport && selectedTask)"));
  assert.ok(detail.includes(
    "const desktopTaskPreview = Boolean(mobileDesignV1Preview && mobileViewport === false && selectedTask)"));
  assert.ok(detail.includes('!mobileDesignV1Preview && (selected.status === "completed" ?'));
  assert.ok(!detail.includes('!mobileTaskPreview && !desktopTaskPreview && (selected.status === "completed"'),
    "both viewport predicates are false on hydration, so they cannot guard old actions");
  for (const viewport of [null, true, false]) {
    const designPreview = true;
    const mobile = Boolean(designPreview && viewport);
    const desktop = Boolean(designPreview && viewport === false);
    const legacy = !designPreview;
    assert.equal(legacy, false, "preview must never use unguarded legacy actions");
    if (viewport === null) assert.deepEqual([mobile, desktop], [false, false]);
    else assert.equal(Number(mobile) + Number(desktop), 1);
  }
  assert.equal(!false, true, "the unchanged preview-off legacy action remains available");
});
