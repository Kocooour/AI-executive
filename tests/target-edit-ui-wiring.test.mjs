import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");

test("page and root pass the server-derived edit flags to the panel; absent flags mean read-only as in 4a",()=>{
  assert.match(read("app/page.tsx"),/targetEdits=\{config\?\.edits\}/);
  const rootSource=read("app/ui/lumi-app-root.tsx");
  assert.match(rootSource,/targetEdits\?: TargetEditsProps/);
  assert.match(rootSource,/<TargetDetailPanel route=\{detailRoute\} language=\{language\} gates=\{detailGates\} edits=\{targetEdits\} \/>/);
});

test("the panel shows the 4a read-only note unless edits exist for the shown kind",()=>{
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(panel,/content&&!\(edit&&kindHasEdits\(content\.kind,edits\)\)&&/);
  assert.match(panel,/<TaskEdits api=\{edit\} task=\{task\}\/>/);
  assert.match(panel,/<NoteEdits api=\{edit\} note=\{note\}\/>/);
  assert.match(panel,/useTargetTick\(revalidate\);/);
  // A deleted item is never re-read (it would replace the confirmation by a 404).
  assert.match(panel,/if\(editRef\.current\?\.deleted\)return;/);
});

test("edit UI never persists or logs user text and has no native dialogs",()=>{
  for(const file of ["app/ui/target-detail-edit.tsx","lib/target-detail-write.ts","lib/target-staging-edit-clients.ts"]){
    const source=read(file);
    assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document\.cookie/,file);
    assert.doesNotMatch(source,/console\.(log|info|warn|error)/,file);
    assert.doesNotMatch(source,/window\.(confirm|alert|prompt)|\bconfirm\(|\balert\(/,file);
  }
});

test("writes use the routed fetch (reads and receipts queue, writes never hold the read slot)",()=>{
  const source=read("app/ui/target-detail-edit.tsx");
  assert.match(source,/routeTargetFetch\(readFetch,\(input,init\)=>fetch\(input,init\)\)/);
  assert.match(source,/fetch:\(input,init\)=>routed\(input,init\)/);
  assert.match(source,/readTaskWriteContext\(task\.id,task\.areaId,routed,signal\)/);
  assert.match(source,/prepareMyPlanWhen\(\{taskId:task\.id,areaId:task\.areaId,whenOn:"2000-01-01",signal\},routed\)/);
  assert.match(source,/readNoteWriteContext\(content\.note\.id,content\.note\.areaId,routed,signal\)/);
  assert.match(read("app/ui/target-detail-panel.tsx"),/const readFetch=queuedTargetFetch\(\);/);
});

test("editability comes from the server preflight, never from scope or role guesses",()=>{
  const source=read("app/ui/target-detail-edit.tsx");
  assert.match(source,/setCapability\("readonly"\)/);
  // The scope only clears Undo / feedback; it never decides which controls exist.
  assert.match(source,/useEffect\(\(\)=>\{controller\.reset\(\);\},\[controller,sessionKey,scope\]\);/);
  assert.doesNotMatch(source,/scope\s*===|scope\s*!==|areaKind===.shared.&&.*(role|admin|editor)/);
  assert.match(source,/capability==="readonly"/);
});

test("Esc leaves the edit or confirm before the panel closes; confirm focuses the safe choice",()=>{
  const source=read("app/ui/target-detail-edit.tsx");
  assert.match(source,/onKeyDown=\{escapeTo\(cancel\)\}/);
  assert.match(source,/onKeyDown=\{escapeTo\(close\)\}/);
  assert.match(source,/event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(source,/if\(asking\)cancel\.current\?\.focus\(\);\s*else if\(restore\)\{trigger\.current\?\.focus\(\);setRestore\(false\);\}/);
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(panel,/if\(event\.defaultPrevented\)return;/);
});

test("live regions: a persistent polite status and a separate alert for conflict / uncertain / error",()=>{
  const source=read("app/ui/target-detail-edit.tsx");
  assert.match(source,/<p role="status" aria-live="polite" data-testid="target-detail-edit-status">/);
  assert.match(source,/<p role="alert" data-testid="target-detail-edit-alert">/);
});

test("lists, sidebar and My Plan re-read after a committed edit",()=>{
  for(const file of ["app/ui/target-scope-lists.tsx","app/ui/target-sidebar-projects.tsx","app/ui/target-staging-my-plan-preview.tsx"])
    assert.match(read(file),/subscribeTargetChange\(/,file);
  assert.match(read("app/ui/target-detail-edit.tsx"),/emitTargetChange\(\{/);
  // My Plan reuses its guarded GET-only refresh; it never starts a write of its own.
  assert.match(read("app/ui/target-staging-my-plan-preview.tsx"),/subscribeTargetChange\(\(\)=>refreshPlanRef\.current\(\)\)/);
});

test("legacy write barrier: drag handles, project-page fields and plan time actions are natively disabled in unified mode",()=>{
  const hook=read("app/ui/use-lumi-app.tsx");
  assert.match(hook,/const dragHandle = \(entity: Entity, scope: string\) => captureDisabled \? \(/);
  assert.match(hook,/disabled\s+draggable=\{false\}/);
  const page=read("app/ui/views/project-page.tsx");
  assert.match(page,/readOnly=\{app\.legacyWritesDisabled\}/);
  assert.match(page,/disabled=\{app\.legacyWritesDisabled\}/);
  assert.match(page,/const projectActions = <LegacyWriteGate><div className="projectActions" data-project-actions>/);
  assert.match(page,/<\/div><\/LegacyWriteGate>;/);
  const cell=read("app/ui/views/today-time-cell.tsx");
  assert.match(cell,/const dayPlanBusy = planBusy \|\| legacyWritesDisabled;/);
  assert.match(cell,/data-time-action="complete" disabled=\{legacyWritesDisabled\}/);
  assert.match(cell,/data-time-action="delete" disabled=\{legacyWritesDisabled\}/);
});

test("the config type and tests keep `edits` next to `details`",()=>{
  assert.match(read("lib/target-ui-config.ts"),/edits:TargetUiEdits;\n\};/);
});

test("review regressions: delete carries the visible snapshot, revocation invalidates controls, stale reads cannot override delete",()=>{
  const edit=read("app/ui/target-detail-edit.tsx");
  const write=read("lib/target-detail-write.ts");
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(edit,/kind:"taskDelete",taskId:base\.id,areaId:base\.areaId,base/);
  assert.match(edit,/kind:"noteDelete",noteId:base\.id,areaId:base\.areaId,base/);
  assert.match(edit,/setConfirmation\(\{base,text:confirmText\}\)/);
  assert.match(edit,/const approved=confirmation\.base/);
  assert.match(write,/sameDeleteSnapshot\(seen\.task,input\.base\)/);
  assert.match(write,/sameDeleteSnapshot\(seen\.note,input\.base\)/);
  assert.match(edit,/const checked=verifiedContent===content&&currentContent/);
  assert.match(edit,/setVerifiedContent\(null\);setAbilities\(NO_ABILITIES\);setCapability\("checking"\)/);
  assert.match(panel,/onDeleted:\(\)=>\{deletedRef\.current=true;epoch\.current\+\+;\}/);
  assert.match(panel,/if\(epoch\.current!==id\|\|deletedRef\.current\)return;/);
  assert.match(panel,/if\(epoch\.current===id&&!deletedRef\.current\)/);
});
