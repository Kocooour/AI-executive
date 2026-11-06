import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectPreviewCanToggle, projectPreviewCanCommit } from "../lib/project-list-preview.ts";

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
  assert.match(page, /if \(!canChangeStatus \|\| actionInFlight\.current\) return;/);
  assert.match(page, /disabled=\{projectDetailPreview && !canChangeStatus\}/g);
  assert.match(page, /onClick=\{\(\) => projectDetailPreview\s*\? void previewToggleStatus\(\)\s*: void setProjectStatus/);
  assert.match(page, /projectPreviewCanToggle\(project, activeWorkspaceId,/);
  assert.match(page, /isHeld \|\| unsent\.has\(project\.id\) \|\| entityConflicts\(project\)\.length > 0 \|\| actionBusy/);
  assert.match(page, /const confirmed = await askConfirm\(/);
  assert.match(page, /Dokončení projektu stav těchto úkolů nezmění/);
  assert.match(page, /if \(!confirmed\) return/);
  assert.match(page, /await setProjectStatus\(project, completed \? "active" : "completed", project\)/);
  assert.match(page, /function reportPreviewActionError\(error: unknown\)/);
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
  assert.match(page, /await setProjectStatus\(project, completed \? "active" : "completed", project\)/);
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

test("UI-05c: current snapshot rejects mid-confirm status, revision, scope, held and deletion", async () => {
  const original = { id: "project-1", type: "project", title: "Example", status: "active",
    workspaceId: "personal", createdAt: 1, updatedAt: 100, properties: { activity: [] } };
  const allowed = (current, workspace = "personal", blocked = false) =>
    projectPreviewCanCommit(original, current, workspace, blocked);
  assert.equal(allowed(structuredClone(original)), true);
  assert.equal(allowed(undefined), false, "deleted during confirmation");
  assert.equal(allowed({ ...original, status: "completed", updatedAt: 101 }), false, "completed elsewhere");
  assert.equal(allowed({ ...original, status: "archived", updatedAt: 101 }), false, "archived elsewhere");
  assert.equal(allowed({ ...original, workspaceId: "shared", updatedAt: 101 }), false, "workspace reassigned");
  assert.equal(allowed({ ...original, updatedAt: 101 }), false, "revision changed");
  assert.equal(allowed({ ...original, title: "Renamed" }), false, "same timestamp, different content");
  assert.equal(allowed(original, "all"), false, "aggregate not writable");
  assert.equal(allowed(original, "shared"), false, "workspace switched or revoked");
  assert.equal(allowed(original, "personal", true), false, "held, pending or conflicted");
  let resolveConfirm;
  const pending = new Promise((resolve) => { resolveConfirm = resolve; });
  let latest = structuredClone(original);
  const confirmedWrite = (async () => {
    if (!await pending) return false;
    return projectPreviewCanCommit(original, latest, "personal", false);
  })();
  latest = { ...original, status: "completed", updatedAt: 101 };
  resolveConfirm(true);
  assert.equal(await confirmedWrite, false, "stale confirmation must not authorize commit");
});

test("UI-05c: status and delete validate inside their IndexedDB write transactions", () => {
  const setter = read("../app/ui/use-lumi-app.tsx");
  assert.match(setter, /async function setProjectStatus\(project: Entity, status: "active" \| "completed", expectedPreview\?: Entity\)/);
  assert.match(setter, /await db\.transaction\("rw", db\.entities, async \(\) => \{\s*const current = await db\.entities\.get\(project\.id\);\s*assertPreviewProjectMutation\(expectedPreview, current\);/);
  assert.match(setter, /await db\.transaction\("rw", db\.entities, db\.relations, async \(\) => \{\s*if \(expectedPreview\) \{\s*const current = await db\.entities\.get\(e\.id\);\s*assertPreviewProjectMutation\(expectedPreview, current\);/);
  assert.match(setter, /projectPreviewCanCommit\(expected, current, activeWorkspaceRef\.current, blocked\)/);
  assert.match(setter, /projectPreviewCanCommit\(expected, visible, activeWorkspaceRef\.current, blocked\)/);
  assert.match(setter, /openProjectIdRef\.current !== expected\.id/);
  assert.match(page, /await remove\(project, project\)/);
  assert.match(page, /actionInFlight\.current = true/);
  assert.match(page, /reportPreviewActionError\(error\)/);
});
