import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {taskPreviewCompletionTone,taskPreviewStateText} from "../lib/lumi-completion-state.ts";
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
