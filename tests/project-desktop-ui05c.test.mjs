import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectPreviewCanToggle, projectPreviewCanCommit, projectPreviewDependents, waitForProjectPreviewWrites } from "../lib/project-list-preview.ts";
import { settleSyncOperation } from "../lib/sync-result.ts";
import { projectSyncNoticeAfterUndo, projectSyncNoticeResolved, sameProjectSyncNotice,
  projectSyncNoticesAfterUndo, withProjectSyncNotice, withoutProjectSyncNotice,
  withoutResolvedProjectSyncNotices, projectSyncNoticeTitle, projectSyncNoticeLabel } from "../lib/project-sync-notice.ts";

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
  assert.match(page, /await setProjectStatus\(snapshot\.project, completed \? "active" : "completed", snapshot\)/);
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
  assert.match(page, /const count = snapshot\.openTasks/);
  assert.match(page, /Completing it will leave those tasks open/);
  assert.match(page, /await setProjectStatus\(snapshot\.project, completed \? "active" : "completed", snapshot\)/);
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
  assert.match(setter, /async function setProjectStatus\(project: Entity, status: "active" \| "completed", expectedPreview\?: ProjectPreviewActionSnapshot\)/);
  assert.match(setter, /await db\.transaction\("rw", db\.entities, db\.relations, async \(\) => \{\s*const current = await db\.entities\.get\(project\.id\);\s*assertPreviewProjectMutation\(expectedPreview\.project, current\);/);
  assert.match(setter, /await db\.transaction\("rw", db\.entities, db\.relations, async \(\) => \{\s*if \(expectedPreview\) \{\s*const current = await db\.entities\.get\(e\.id\);\s*assertPreviewProjectMutation\(expectedPreview\.project, current\);/);
  assert.match(setter, /projectPreviewCanCommit\(expected, current, activeWorkspaceRef\.current, blocked\)/);
  assert.match(setter, /visible\.workspaceId !== expected\.workspaceId/);
  assert.match(setter, /openProjectIdRef\.current !== expected\.id/);
  assert.match(page, /await remove\(snapshot\.project, snapshot\)/);
  assert.match(page, /actionInFlight\.current = true/);
  assert.match(page, /reportPreviewActionError\(error\)/);
});

test("UI-05c: completing after title/context blur waits for the local autosaves", async () => {
  const page = read("../app/ui/views/project-page.tsx");
  const ctx = read("../app/ui/views/project-context.tsx");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(page, /trackProjectWrite\(project\.id, rename\(project, next\)\)/);
  assert.match(ctx, /app\.trackProjectWrite\(project\.id, run\)/);
  assert.match(page, /const snapshot = await projectPreviewActionSnapshot\(project\.id\)/g);
  assert.match(app, /await waitForProjectWrites\(projectId\);/);
  let resolveRename, resolveContext;
  const rename = new Promise((resolve) => { resolveRename = resolve; });
  const context = new Promise((resolve) => { resolveContext = resolve; });
  const outstanding = new Set([rename, context]);
  const settle = (promise) => promise.then(() => outstanding.delete(promise));
  rename.then(() => outstanding.delete(rename));
  context.then(() => outstanding.delete(context));
  let prepared = false;
  const preparing = waitForProjectPreviewWrites(() => [...outstanding]).then(() => { prepared = true; });
  await Promise.resolve();
  assert.equal(prepared, false);
  resolveRename();
  await rename;
  await Promise.resolve();
  assert.equal(prepared, false, "context save also has to finish");
  resolveContext();
  await preparing;
  assert.equal(prepared, true);
});

test("UI-05c: task, note, relation and status changes invalidate a pending confirmation", () => {
  const project = { id: "p", type: "project", title: "Project", workspaceId: "personal", status: "active", properties: {} };
  const task = { id: "t", type: "task", workspaceId: "personal", status: "open", properties: {} };
  const relation = { id: "r", sourceEntityId: "t", targetEntityId: "p",
    workspaceId: "personal", relationType: "belongs_to_project", createdAt: 1 };
  const initial = projectPreviewDependents(project, [task], [relation]);
  assert.equal(initial.openTaskCount, 1);
  assert.notEqual(projectPreviewDependents(project, [{ ...task, status: "completed" }], [relation]).signature, initial.signature);
  assert.notEqual(projectPreviewDependents(project, [task, { ...task, id: "new" }],
    [relation, { ...relation, id: "r2", sourceEntityId: "new" }]).signature, initial.signature);
  assert.notEqual(projectPreviewDependents(project, [task], []).signature, initial.signature);
  assert.notEqual(projectPreviewDependents(project, [task, { ...task, id: "n", type: "note", status: "active" }],
    [relation, { ...relation, id: "r3", sourceEntityId: "n" }]).signature, initial.signature);
  assert.notEqual(projectPreviewDependents(project, [task, { ...task, id: "legacy", properties: { projectId: "p" } }],
    [relation]).signature, initial.signature);
  const setter = read("../app/ui/use-lumi-app.tsx");
  assert.match(setter, /if \(\(await projectPreviewDependencies\(current\)\)\.signature !== expectedPreview\.dependents\)/g);
  assert.match(setter, /await db\.transaction\("rw", db\.entities, db\.relations, async \(\) => \{/g);
});

test("UI-05c: rejected server PUT reaches preview status and delete actions, while the normal queue stays usable", async () => {
  // The same queue machinery runs for both preview actions, even if Delete unmounts its page.
  for (const action of ["complete", "delete"]) {
    const failure = new Error(`PUT /api/store failed for ${action}`);
    let offlineCount = 0;
    const operation = Promise.reject(failure);
    const { queue, result } = settleSyncOperation(operation, () => { offlineCount += 1; }, true);
    await assert.rejects(result, (error) => error === failure,
      `${action} must receive its own PUT error`);
    await assert.doesNotReject(queue, "the background queue must still be reusable");
    assert.equal(offlineCount, 1, "the shared queue must mark offline once");
  }
  const { queue, result } = settleSyncOperation(Promise.reject(new Error("offline")),
    () => {}, false);
  await assert.doesNotReject(result, "non-preview callers retain the offline-first contract");
  await assert.doesNotReject(queue);
  let successMarkedOffline = false;
  const completed = settleSyncOperation(Promise.resolve(), () => { successMarkedOffline = true; }, true);
  await assert.doesNotReject(completed.result);
  await completed.queue;
  assert.equal(successMarkedOffline, false, "successful server sync must not raise an error");
});

test("UI-05c: both preview mutations request failures and preserve a persistent accessible warning", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  const sync = read("../app/ui/hooks/use-sync.ts");
  const root = read("../app/ui/lumi-app-root.tsx");
  assert.equal(app.split('await syncToServer({ reportFailure: Boolean(expectedPreview) });').length - 1, 2,
    "completion and deletion must each observe the result of their own server write");
  assert.match(sync, /syncQueue\.current = settled\.queue;\s*return settled\.result;/);
  assert.match(sync, /if \(reportFailure\) throw new Error\("SYNC_NOT_CONFIRMED"\)/);
  assert.match(app, /setProjectSyncNotices\(\(current\) => withProjectSyncNotice\(current,\s*\{ kind: "delete", projectId: e\.id, projectTitle: e\.title, workspaceId: e\.workspaceId,\s*workspaceTitle:/);
  assert.match(app, /setProjectSyncNotices\(\(current\) => withProjectSyncNotice\(current,\s*\{ kind: "status", projectId: project\.id, projectTitle: project\.title,\s*workspaceId: project\.workspaceId,/);
  assert.match(root, /role="alert"\s+data-testid="project-sync-warning"/);
  assert.match(root, /notice\.kind === "delete"/);
  assert.match(root, /onClick=\{\(\) => app\.dismissProjectSyncNotice\(notice\.projectId\)\}/);
  assert.match(page, /if \(error instanceof Error && error\.message === "project_preview_sync_pending"\) return;/);
});

test("UI-05c: pending status warning resolves only on acknowledged matching or superseding project revision", () => {
  const pending = { kind: "status", projectId: "p", status: "completed", updatedAt: 200 };
  const row = { id: "p", type: "project", status: "completed", updatedAt: 200 };
  assert.equal(projectSyncNoticeResolved(pending, row, { ...row, updatedAt: 199 }, false), false,
    "an older server base is not proof of this completion");
  assert.equal(projectSyncNoticeResolved(pending, row, { ...row, updatedAt: 200 }, false), true);
  assert.equal(projectSyncNoticeResolved(pending, row, undefined, false), false,
    "a healthy sync of another record cannot resolve the project warning");
  assert.equal(projectSyncNoticeResolved(pending, row, { ...row, status: "active", updatedAt: 201 }, false), false,
    "the server acknowledging another status is not proof that this completion was sent");
  const reopened = { ...row, status: "active", updatedAt: 250 };
  assert.equal(projectSyncNoticeResolved(pending, reopened, reopened, false), true,
    "an acknowledged newer local status supersedes an old warning");
  assert.equal(projectSyncNoticeResolved(pending, reopened, { ...row, updatedAt: 199 }, false), false);
  assert.equal(sameProjectSyncNotice(pending, { ...pending }), true);
  assert.equal(sameProjectSyncNotice(pending, { ...pending, updatedAt: 201 }), false,
    "an old async confirmation cannot dismiss a newer failure for the same project");
});

test("UI-05c: pending deletion warning requires deletion receipt; Undo cancels that exact warning", () => {
  const deletion = { kind: "delete", projectId: "project-a" };
  assert.equal(projectSyncNoticeResolved(deletion, undefined, undefined, true), false,
    "delete marker still pending even when the record is locally absent");
  assert.equal(projectSyncNoticeResolved(deletion, undefined, undefined, false), true,
    "server base absent and delete marker consumed");
  assert.equal(projectSyncNoticeResolved(deletion, { id: "project-a" }, undefined, true), true,
    "a restored local project makes the deletion warning obsolete");
  assert.equal(projectSyncNoticeResolved(deletion, undefined, { id: "project-a" }, false), false,
    "server still holds the project");
  assert.equal(projectSyncNoticeAfterUndo(deletion, "project-b"), deletion,
    "Undo of a different project must not dismiss the warning");
  assert.equal(projectSyncNoticeAfterUndo(deletion, "project-a"), null);
  const status = { kind: "status", projectId: "project-a", status: "completed", updatedAt: 200 };
  assert.equal(projectSyncNoticeAfterUndo(status, "project-a"), status);
});

test("UI-05c: status and deletion warnings reconcile on successful retry and matching Undo", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(app, /const warnings = Object\.values\(projectSyncNotices\);/);
  assert.match(app, /db\.transaction\("r", db\.entities, db\.baseEntities, async \(\) => \{/);
  assert.match(app, /projectSyncNoticeResolved\(warning, local, acknowledged,/);
  assert.match(app, /pendingDeletions\.has\(warning\.projectId\)/);
  assert.match(app, /withoutResolvedProjectSyncNotices\(current, resolved\)/);
  assert.match(app, /setProjectSyncNotices\(\(current\) => projectSyncNoticesAfterUndo\(current, undo\.id\)\)/);
  assert.match(app, /if \(expectedPreview\) setProjectSyncNotices\(\(current\) => withoutProjectSyncNotice\(current, project\.id\)\)/);
  assert.match(app, /if \(expectedPreview\) setProjectSyncNotices\(\(current\) => withoutProjectSyncNotice\(current, e\.id\)\)/);
});

test("UI-05c: two offline project failures remain independent through Undo and server retry", () => {
  const a = { kind: "status", projectId: "project-a", status: "completed", updatedAt: 200 };
  const b = { kind: "delete", projectId: "project-b" };
  const first = withProjectSyncNotice({}, a);
  const both = withProjectSyncNotice(first, b);
  assert.deepEqual(Object.keys(both).sort(), ["project-a", "project-b"],
    "failing B must not erase the pending completion of A");
  const undoneB = projectSyncNoticesAfterUndo(both, "project-b");
  assert.deepEqual(Object.keys(undoneB), ["project-a"],
    "Undo B removes only B's deletion warning");
  assert.deepEqual(undoneB["project-a"], a,
    "the unsynchronized completion A is still visible after Undo B");
  assert.deepEqual(projectSyncNoticesAfterUndo(both, "project-a"), both,
    "Undo on another kind of warning cannot clear it");
  assert.deepEqual(Object.keys(withoutResolvedProjectSyncNotices(both, [b])), ["project-a"],
    "server confirming B does not imply A was saved");
  assert.deepEqual(Object.keys(withoutResolvedProjectSyncNotices(both, [a])), ["project-b"],
    "server confirming A does not imply B was deleted");
  assert.deepEqual(withoutResolvedProjectSyncNotices(both, [a, b]), {});
});

test("UI-05c: stale acknowledgement cannot clear a newer failure for the same project", () => {
  const oldA = { kind: "status", projectId: "a", status: "completed", updatedAt: 200 };
  const newestA = { ...oldA, status: "active", updatedAt: 300 };
  const b = { kind: "delete", projectId: "b" };
  const both = withProjectSyncNotice(withProjectSyncNotice({}, oldA), b);
  const replaced = withProjectSyncNotice(both, newestA);
  assert.deepEqual(withoutResolvedProjectSyncNotices(replaced, [oldA]), replaced,
    "an old response cannot erase newer A");
  assert.deepEqual(withoutResolvedProjectSyncNotices(replaced, [b]), { a: newestA },
    "B may settle without affecting the newer A");
  assert.deepEqual(withoutProjectSyncNotice(replaced, "b"), { a: newestA });
  assert.deepEqual(withoutProjectSyncNotice(replaced, "missing"), replaced);
});

test("UI-05c: app renders and dismisses warnings independently for every affected project", () => {
  const root = read("../app/ui/lumi-app-root.tsx");
  const app = read("../app/ui/use-lumi-app.tsx");
  assert.match(root, /app\.projectSyncNotices\.map\(\(notice\) => \(/);
  assert.match(root, /key=\{notice\.projectId\}/);
  assert.match(root, /role="alert"/);
  assert.match(root, /app\.dismissProjectSyncNotice\(notice\.projectId\)/);
  assert.match(app, /projectSyncNotices: Object\.values\(projectSyncNotices\)/);
  assert.match(app, /setProjectSyncNotices\(\(current\) => withProjectSyncNotice\(current,/);
  assert.match(app, /setProjectSyncNotices\(\(current\) => projectSyncNoticesAfterUndo\(current, undo\.id\)\)/);
});

test("UI-05d: multiple pending project notices are individually identified and accessible", () => {
  const a = { kind: "status", projectId: "project-a", projectTitle: "Dům", status: "completed", updatedAt: 200 };
  const b = { kind: "delete", projectId: "project-b", projectTitle: "Práce" };
  const pending = withProjectSyncNotice(withProjectSyncNotice({}, a), b);
  assert.equal(projectSyncNoticeTitle(pending["project-a"]), "Dům");
  assert.equal(projectSyncNoticeTitle(pending["project-b"]), "Práce");
  assert.equal(projectSyncNoticeTitle({ ...a, projectTitle: "  " }), "project-a",
    "a missing or blank name still supplies an unambiguous identity");
  assert.deepEqual(Object.keys(projectSyncNoticesAfterUndo(pending, "project-b")), ["project-a"]);
  assert.equal(projectSyncNoticeTitle(withoutResolvedProjectSyncNotices(pending, [b])["project-a"]), "Dům");
  const root = read("../app/ui/lumi-app-root.tsx"), app = read("../app/ui/use-lumi-app.tsx");
  assert.match(root, /<strong>\{projectSyncNoticeLabel\(notice, app\.projectSyncNotices, language\)\}<\/strong>/);
  assert.match(root, /aria-label=\{language === "cs"/);
  assert.match(root, /Skrýt upozornění projektu \$\{projectSyncNoticeLabel\(notice, app\.projectSyncNotices, language\)\}/);
  assert.match(root, /Dismiss notice for project \$\{projectSyncNoticeLabel\(notice, app\.projectSyncNotices, language\)\}/);
  assert.match(root, /onClick=\{\(\) => app\.dismissProjectSyncNotice\(notice\.projectId\)\}/);
  assert.match(app, /projectTitle: e\.title/);
  assert.match(app, /projectTitle: project\.title/);
});

test("UI-05d: two identically named projects in different workspaces have distinct alert and button labels", () => {
  const personal = { kind: "status", projectId: "personal-project", projectTitle: "Dům",
    workspaceId: "personal", workspaceTitle: "Personal", status: "completed", updatedAt: 250 };
  const shared = { kind: "delete", projectId: "shared-project", projectTitle: "Dům",
    workspaceId: "shared-1", workspaceTitle: "Rodina" };
  const notices = [personal, shared];
  assert.equal(projectSyncNoticeLabel(personal, notices, "cs"), "Dům (Osobní)");
  assert.equal(projectSyncNoticeLabel(shared, notices, "cs"), "Dům (Rodina)");
  assert.equal(projectSyncNoticeLabel(personal, notices, "en"), "Dům (Personal)");
  assert.equal(projectSyncNoticeLabel(shared, notices, "en"), "Dům (Rodina)");
  assert.notEqual(projectSyncNoticeLabel(personal, notices, "cs"),
    projectSyncNoticeLabel(shared, notices, "cs"));
  assert.deepEqual(Object.keys(projectSyncNoticesAfterUndo(
    withProjectSyncNotice(withProjectSyncNotice({}, personal), shared), shared.projectId)), [personal.projectId],
  "Undo the shared project's deletion must leave the personal project's alert");
});

test("UI-05d: duplicate workspace names and duplicate project titles use stable distinct ID fallback", () => {
  const first = { kind: "delete", projectId: "project-111", projectTitle: "Dům",
    workspaceId: "shared-a", workspaceTitle: "Rodina" };
  const second = { ...first, projectId: "project-222", workspaceId: "shared-b" };
  const two = [first, second];
  assert.equal(projectSyncNoticeLabel(first, two, "cs"), "Dům (Rodina) · project-111");
  assert.equal(projectSyncNoticeLabel(second, two, "cs"), "Dům (Rodina) · project-222");
  assert.equal(projectSyncNoticeLabel(first, [first], "cs"), "Dům (Rodina)",
    "the opaque identifier is only shown when needed to disambiguate");
  const sameWorkspace = { ...second, workspaceId: first.workspaceId };
  assert.notEqual(projectSyncNoticeLabel(first, [first, sameWorkspace], "en"),
    projectSyncNoticeLabel(sameWorkspace, [first, sameWorkspace], "en"),
    "completed or old duplicate names in the same workspace also remain distinguishable");
  assert.equal(projectSyncNoticeLabel({ ...first, projectTitle: "  " }, [{ ...first, projectTitle: "  " }], "cs"),
    "project-111 (Rodina)");
  const app = read("../app/ui/use-lumi-app.tsx"), root = read("../app/ui/lumi-app-root.tsx");
  assert.match(app, /workspaceTitle: items\.find\(\(item\) => item\.type === "workspace" && item\.workspaceId === e\.workspaceId\)\?\.title/);
  assert.match(app, /workspaceTitle: items\.find\(\(item\) => item\.type === "workspace" && item\.workspaceId === project\.workspaceId\)\?\.title/);
  assert.equal(root.split("projectSyncNoticeLabel(notice, app.projectSyncNotices, language)").length - 1, 3,
    "the visible warning and both localized accessible controls use the same disambiguated label");
});
