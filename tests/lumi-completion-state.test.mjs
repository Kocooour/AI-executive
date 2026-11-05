import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {taskPreviewCompletionTone,taskPreviewStateText} from "../lib/lumi-completion-state.ts";
import {v1DragHandleVisible,v1ReorderAvailable} from "../lib/lumi-reorder-preview.ts";
import {ymd} from "../lib/local-dates.ts";

const today=ymd();
const entity=(type="task",status="open",properties={})=>({
  id:"synthetic",type,status,title:"Synthetic",workspaceId:"personal",
  properties,createdAt:0,updatedAt:0,
});

test("UI-04b: square task completion states are based on deadline and attention, never workspace",()=>{
  const overdue="2000-01-01";
  for(const workspaceId of ["personal","shared-work","another"]) {
    const task={...entity("task","open",{deadline:overdue}),workspaceId};
    assert.equal(taskPreviewCompletionTone(task,today),"danger");
  }
  assert.equal(taskPreviewCompletionTone(entity("task","open",{deadline:today}),today),"warning");
  assert.equal(taskPreviewCompletionTone(entity("task","open",{priority:"high"}),today),"warning");
  assert.equal(taskPreviewCompletionTone(entity("task","open",{priority:"low"}),today),"plain");
  assert.equal(taskPreviewCompletionTone(entity("task","open",{when:"2000-01-01"}),today),"plain",
    "past scheduled when is not an overdue deadline");
  assert.equal(taskPreviewCompletionTone(entity("task","completed",{deadline:overdue,priority:"high"}),today),"complete");
  assert.equal(taskPreviewCompletionTone(entity("project","active",{deadline:overdue}),today),"plain");
});

test("UI-04b: screen reader descriptions include completion and attention in Czech and English",()=>{
  assert.match(taskPreviewStateText("plain","cs"),/Nedokončený/);
  assert.match(taskPreviewStateText("danger","cs"),/termínu/);
  assert.match(taskPreviewStateText("warning","en"),/attention/);
  assert.match(taskPreviewStateText("complete","en"),/Completed/);
});

test("UI-04b: controls are shared and gated; legacy routes retain their buttons",()=>{
  const control=readFileSync(new URL("../app/ui/views/lumi-completion-control.tsx",import.meta.url),"utf8");
  const list=readFileSync(new URL("../app/ui/views/entity-list.tsx",import.meta.url),"utf8");
  const home=readFileSync(new URL("../app/ui/views/home-view.tsx",import.meta.url),"utf8");
  const calendar=readFileSync(new URL("../app/ui/views/day-timeline.tsx",import.meta.url),"utf8");
  const project=readFileSync(new URL("../app/ui/views/mobile-project-row-v1.tsx",import.meta.url),"utf8");
  for(const body of [list,home,calendar]){
    assert.match(body,/mobileDesignV1Preview/);
    assert.match(body,/<LumiCompletionControl className="check" kind="task"/);
  }
  assert.match(project,/<LumiCompletionControl kind="project"/);
  assert.match(control,/aria-pressed=\{complete\}/);
  assert.match(control,/data-completion-kind=\{kind\}/);
  assert.match(control,/\{complete\?"✓":null\}/,
    "unfinished controls must not show a tick");
  assert.match(list,/reorderPreview/);
  assert.match(project,/reorderEnabled &&/);
});

test("UI-04b: all color semantics are scoped to v1 and use theme tokens",()=>{
  const css=readFileSync(new URL("../app/lumi-completion-v1.css",import.meta.url),"utf8");
  const layout=readFileSync(new URL("../app/layout.tsx",import.meta.url),"utf8");
  const tokens=JSON.parse(readFileSync(new URL("../docs/design-system/tokens.json",import.meta.url),"utf8"));
  const names=new Set(tokens.color.tokens.map(item=>item.name));
  for(const name of ["v1-neutral-stroke","v1-attention-orange","v1-attention-red","v1-completed-fill","v1-on-accent","v1-accent","v1-completed-text"]){
    assert.ok(names.has(name),`missing theme token: ${name}`);
    assert.ok(css.includes(`var(--${name})`),`unused state token: ${name}`);
  }
  assert.match(css,/\.appShell\[data-design-system="lumi-v1"\]/);
  assert.match(layout,/import "\.\/lumi-completion-v1\.css";/);
  assert.match(css,/data-completion-kind="project"/);
  assert.match(css,/data-completion-tone="complete"/);
});


test("UI-04b review P1: reorder remains reachable in every working list, including project detail",()=>{
  const editable=["Today","Inbox","Upcoming","Overdue","Anytime","Someday","Completed","Areas","Notes","Projects","Search"];
  for(const view of editable){
    assert.equal(v1ReorderAvailable(view),true,`missing edit toggle for ${view}`);
    assert.equal(v1DragHandleVisible(view,true,false),false,`handle visible before edit mode in ${view}`);
    assert.equal(v1DragHandleVisible(view,true,true),true,`cannot reorder ${view} after entering edit mode`);
    assert.equal(v1DragHandleVisible(view,false,false),true,`legacy drag changed in ${view}`);
  }
  for(const view of ["Home","Calendar"]){
    assert.equal(v1DragHandleVisible(view,true,true),false,`${view} must not expose v1 drag handles`);
  }
  const list=readFileSync(new URL("../app/ui/views/entity-list.tsx",import.meta.url),"utf8");
  const detail=readFileSync(new URL("../app/ui/views/project-page.tsx",import.meta.url),"utf8");
  assert.match(list,/v1ReorderAvailable\(view\)/);
  assert.match(list,/v1DragHandleVisible\(view, mobileDesignV1Preview, reorderPreview\)/);
  assert.match(list,/onToggleReorder=\{\(\) => setReorderPreview/);
  assert.match(detail,/data-v1-project-reorder-toggle/);
  assert.match(detail,/aria-pressed=\{reorderPreview\}/);
  assert.match(detail,/renderRow\(task, index, openTasks/);
  assert.match(detail,/renderRow\(note, index, orderedNotes/);
});

test("UI-04b review P2: same project status row on phone and desktop, guarded by conflicts",()=>{
  const list=readFileSync(new URL("../app/ui/views/entity-list.tsx",import.meta.url),"utf8");
  const project=readFileSync(new URL("../app/ui/views/mobile-project-row-v1.tsx",import.meta.url),"utf8");
  const css=readFileSync(new URL("../app/lumi-completion-v1.css",import.meta.url),"utf8");
  assert.match(list,/const projectListPreview = mobileDesignV1Preview && view === "Projects" && !app.openProject;/);
  assert.doesNotMatch(list,/mobileViewport/, "project row must not be gated by <=700px");
  assert.match(project,/<LumiCompletionControl kind="project"/);
  assert.match(project,/const hasConflict = entityConflicts\(project\)\.length > 0/);
  assert.match(project,/heldReasons\.has\(project\.id\) \|\| hasConflict \|\| busy/);
  assert.match(project,/Resolve the project conflict before changing status/);
  assert.match(css,/\.appShell\[data-design-system="lumi-v1"\] \.taskRowList \.v1ProjectRow \{/);
  assert.match(css,/\.v1ProjectRow \.v1ProjectMain/);
});

test("UI-04b review P2: real Today control width remains 44px with and without reorder",()=>{
  const css=readFileSync(new URL("../app/lumi-completion-v1.css",import.meta.url),"utf8");
  const layout=readFileSync(new URL("../app/layout.tsx",import.meta.url),"utf8");
  const list=readFileSync(new URL("../app/ui/views/entity-list.tsx",import.meta.url),"utf8");
  const todayIndex=layout.indexOf('import "./lumi-today.css";');
  const controlIndex=layout.indexOf('import "./lumi-completion-v1.css";');
  assert.ok(todayIndex >= 0 && controlIndex > todayIndex, "v1 sizing must override late legacy Today CSS");
  assert.match(list,/data-v1-reorder=\{mobileDesignV1Preview && view === "Today" \? String\(reorderPreview\)/);
  assert.match(css,/grid-template-columns: 44px minmax\(0, 1fr\) auto auto;/);
  assert.match(css,/grid-template-columns: 44px 44px minmax\(0, 1fr\) auto auto;/);
  assert.match(css,/\.taskRow\[data-entity-type="task"\] > \.lumiCompletionControl \{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;[\s\S]*?min-height: 44px;/);
  assert.match(css,/\.taskRow\[data-v1-reorder="true"\]\[data-entity-type="task"\] > \.lumiCompletionControl \{ grid-column: 2; \}/);
  assert.match(css,/\.taskRow\[data-entity-type="task"\] > \.dragHandle::before \{\s*content: none;/,
    "the old oversized touch pseudo-element cannot overlap the new 44px button");
});
