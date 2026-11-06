import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectPreviewCanToggle } from "../lib/project-list-preview.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../app/ui/views/project-page.tsx");
const css = read("../app/lumi-project-detail-v1.css");

test("UI-05c: one preview project context follows the task list on phone and desktop", () => {
  assert.match(page, /const projectDetailPreview = mobileDesignV1Preview/);
  assert.match(page, /const mobileDetailPreview = projectDetailPreview && mobileViewport/);
  assert.match(page, /data-project-detail-preview=\{projectDetailPreview \? "lumi-v1" : undefined\}/);
  const firstHeader = page.indexOf('<div className="projectHeader">');
  const headerContext = page.indexOf('{!projectDetailPreview && <ProjectContext');
  const taskSection = page.indexOf('<section className="projectSection" aria-labelledby="project-tasks-heading">');
  const contextFold = page.indexOf('{projectDetailPreview && (\n        <details key={project.id} className="projectContextFold"');
  const notesSection = page.indexOf('<section className="projectSection" aria-labelledby="project-notes-heading">');
  assert.ok(firstHeader > -1 && firstHeader < headerContext && headerContext < taskSection);
  assert.ok(taskSection < contextFold && contextFold < notesSection, "Tasks must be first and context behind one accessible disclosure");
  assert.match(page, /<summary>\{t\.contextTitle\}<\/summary>/);
  assert.equal(page.split('<ProjectContext key={project.id} app={app} project={project} />').length-1, 2,
    "one mutually exclusive legacy or v1 ProjectContext, never duplicated");
  assert.match(page, /\{!projectDetailPreview && <ProjectContext/);
  assert.match(page, /\{projectDetailPreview && \(/);
  assert.match(page, /\{mobileDetailPreview && projectActions\}/);
  assert.match(page, /\{!mobileDetailPreview && projectActions\}/);
});

test("UI-05c: desktop v1 project completion uses the same confirmed, guarded path as mobile", () => {
  assert.match(page, /async function previewToggleStatus\(\)/);
  assert.match(page, /if \(!canChangeStatus\) return;/);
  assert.match(page, /disabled=\{projectDetailPreview && !canChangeStatus\}/g);
  assert.match(page, /onClick=\{\(\) => projectDetailPreview\s*\? void previewToggleStatus\(\)\s*: void setProjectStatus/);
  assert.match(page, /projectPreviewCanToggle\(project, activeWorkspaceId,/);
  assert.match(page, /isHeld \|\| unsent\.has\(project\.id\) \|\| entityConflicts\(project\)\.length > 0 \|\| actionBusy/);
  assert.match(page, /const confirmed = await askConfirm\(/);
  assert.match(page, /Dokončení projektu stav těchto úkolů nezmění/);
  assert.match(page, /if \(!confirmed\) return/);
  assert.match(page, /await setProjectStatus\(project, completed \? "active" : "completed"\)/);
  assert.match(page, /setActionError\(language === "cs" \?/);
  assert.doesNotMatch(page, /mobileToggleStatus/);
  const a = { type: "project", status: "active", workspaceId: "personal" };
  assert.equal(projectPreviewCanToggle(a, "personal", false), true);
  for (const blocked of [true, false]) {
    assert.equal(projectPreviewCanToggle(a, "all", blocked), false);
    assert.equal(projectPreviewCanToggle(a, "shared", blocked), false);
  }
  assert.equal(projectPreviewCanToggle(a, "personal", true), false);
  assert.equal(projectPreviewCanToggle({ ...a, status: "completed" }, "personal", false), true);
  assert.equal(projectPreviewCanToggle({ ...a, status: "archived" }, "personal", false), false);
});

test("UI-05c: preview cannot silently complete child tasks or weaken the legacy data model", () => {
  const setter = read("../app/ui/use-lumi-app.tsx");
  const projectHelper = read("../lib/project-list-preview.ts");
  assert.match(page, /const openTasks = tasks\.filter\(\(task\) => task\.status === "open"\)/);
  assert.match(page, /const count = openTasks\.length/);
  assert.match(page, /Completing it will leave those tasks open/);
  assert.match(page, /await setProjectStatus\(project, completed \? "active" : "completed"\)/);
  assert.match(projectHelper, /activeWorkspaceId === project\.workspaceId/);
  assert.match(setter, /async function setProjectStatus\(/);
  assert.doesNotMatch(page, /await done\(task\.id\)/);
});

test("UI-05c: desktop disclosure is keyboard accessible, respects reduced motion and is preview-scoped", () => {
  assert.match(css, /@media \(min-width: 701px\)/);
  assert.match(css, /\.projectPage\[data-project-detail-preview="lumi-v1"\] \.projectContextFold > summary/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /\.projectContextFold > summary:focus-visible/);
  assert.match(css, /\.projectContextFold\[open\] > summary::before/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.projectActions button:disabled/);
  assert.match(css, /\.projectActionError/);
  const layout = read("../app/layout.tsx");
  assert.match(layout, /import "\.\/lumi-project-detail-v1\.css"/);
  const nav = read("../app/ui/navigation.ts");
  assert.match(nav, /NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW === "1"/);
});
