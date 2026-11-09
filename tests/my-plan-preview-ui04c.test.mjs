import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMyPlanPreview, previewAreaForTask, previewDayForTask, previewManualRankUpdates, previewRankNextRecords, previewRankWritesAllowed, previewReorderPeers, tomorrowOf } from "../lib/my-plan-preview.ts";
import { byManualOrder, manualOrder } from "../lib/task-views.ts";
import { pickSummarySuggestion, todayProposalReviewKey, todayProposalTaskSignature } from "../lib/today-summary.ts";

const day = "2026-11-05";
const entity = (id, type, workspaceId = "personal", properties = {}, status = type === "task" ? "open" : "active") => ({
  id, type, title: id, status, workspaceId, properties, createdAt: 0, updatedAt: 0,
});
const relation = (sourceEntityId, targetEntityId, relationType, workspaceId = "personal") => ({
  id: `${sourceEntityId}:${relationType}:${targetEntityId}`, sourceEntityId, targetEntityId,
  relationType, workspaceId, createdAt: 0,
});
const flatten = (section) => section.groups.flatMap((group) => group.tasks.map((item) => item.id));
const sectionIds = (args) => buildMyPlanPreview({ today: day, workspaceId: "personal", ...args }).map(flatten);

test("UI-04c: calendar rollover uses a civil day, not UTC midnight arithmetic", () => {
  assert.equal(tomorrowOf("2026-12-31"), "2027-01-01");
  assert.equal(tomorrowOf("2028-02-28"), "2028-02-29");
  assert.equal(tomorrowOf("2026-02-28"), "2026-03-01");
  assert.throws(() => tomorrowOf("today"), /Invalid/);
});

test("UI-04c: overdue and today's deadlines appear today, tomorrow once, completed never", () => {
  const tasks = [
    entity("overdue", "task", "personal", { deadline: "2026-11-03", when: "2026-12-01" }),
    entity("due-today", "task", "personal", { deadline: day }),
    entity("old-when", "task", "personal", { when: "2026-11-02" }),
    entity("today-flag", "task", "personal", { today: true }),
    entity("tomorrow-when", "task", "personal", { when: "2026-11-06" }),
    entity("tomorrow-deadline", "task", "personal", { deadline: "2026-11-06", when: "2026-12-01" }),
    entity("both", "task", "personal", { today: true, deadline: "2026-11-06" }),
    entity("future", "task", "personal", { when: "2026-11-07" }),
    entity("undated", "task"),
    entity("completed", "task", "personal", { deadline: "2026-11-01" }, "completed"),
    entity("fake-date", "task", "personal", { when: "" }),
  ];
  const [today, tomorrow] = sectionIds({ entities: tasks, relations: [] });
  assert.deepEqual(new Set(today), new Set(["overdue", "due-today", "old-when", "today-flag", "both"]));
  assert.deepEqual(new Set(tomorrow), new Set(["tomorrow-when", "tomorrow-deadline"]));
  assert.equal(new Set([...today, ...tomorrow]).size, today.length + tomorrow.length);
  assert.equal(previewDayForTask(entity("due", "task", "personal", { deadline: "2026-11-04" }), day), "today");
  assert.equal(previewDayForTask(entity("future", "task", "personal", { when: "2026-11-09" }), day), null);
});

test("UI-04c: project-inherited Area wins over stale direct task Area", () => {
  const work = entity("area-work", "area", "personal", {}, "active");
  work.title = "Práce";
  const family = entity("area-family", "area", "personal", {}, "active");
  family.title = "Rodina";
  const project = entity("project", "project");
  const task = entity("task", "task", "personal", { when: day });
  const relations = [
    relation("task", "project", "belongs_to_project"),
    relation("project", "area-work", "belongs_to_area"),
    relation("task", "area-family", "belongs_to_area"),
  ];
  const preview = buildMyPlanPreview({ workspaceId: "personal", today: day, entities: [work, family, project, task], relations });
  assert.equal(preview[0].groups[0].areaId, "area-work");
  assert.equal(preview[0].groups[0].tone, "work");
  assert.equal(preview[0].groups[0].accessibleLabel, "Práce");
  assert.equal(preview[0].groups[0].tasks[0].id, task.id);
});

test("UI-04c: personal area is green, unassigned is neutral and has an accessible label", () => {
  const area = entity("area-personal", "area"); area.title = "Osobní";
  const one = entity("one", "task", "personal", { today: true });
  const two = entity("two", "task", "personal", { today: true });
  const preview = buildMyPlanPreview({ workspaceId: "personal", today: day,
    entities: [area, one, two], relations: [relation("one", area.id, "belongs_to_area")] });
  assert.deepEqual(preview[0].groups.map((group) => group.tone), ["personal", "none"]);
  assert.equal(preview[0].groups[0].accessibleLabel, "Osobní");
  assert.equal(preview[0].groups[1].accessibleLabel, "Nezařazeno");
  assert.equal(preview[0].count, 2);
});

test("UI-04c: no combined all scope or cross-workspace relation leakage", () => {
  const task = entity("task", "task", "personal", { today: true });
  const foreign = entity("foreign", "task", "shared", { today: true });
  const foreignArea = entity("foreign-area", "area", "shared");
  const relationships = [
    relation("task", "foreign-area", "belongs_to_area", "personal"),
    relation("foreign", "foreign-area", "belongs_to_area", "shared"),
  ];
  const entities = [task, foreign, foreignArea];
  assert.deepEqual(sectionIds({ entities, relations: relationships })[0], ["task"]);
  assert.equal(previewAreaForTask(task, entities, relationships), null);
  assert.deepEqual(buildMyPlanPreview({ workspaceId: "all", today: day, entities, relations: relationships }).map(flatten), [[], []]);
  assert.deepEqual(buildMyPlanPreview({ workspaceId: "shared", today: day, entities, relations: relationships })[0].groups[0].tasks.map((x) => x.id), ["foreign"]);
});

test("UI-04c: conflicting project and Area memberships fail closed; inaccessible Area status never colors a task", () => {
  const task = entity("task", "task", "personal", { today: true });
  const first = entity("p1", "project");
  const second = entity("p2", "project");
  const area = entity("a", "area");
  const inactive = entity("b", "area", "personal", {}, "archived");
  assert.equal(previewAreaForTask(task, [task, first, second, area], [
    relation("task", first.id, "belongs_to_project"), relation("task", second.id, "belongs_to_project"),
    relation(first.id, area.id, "belongs_to_area"),
  ]), null);
  assert.equal(previewAreaForTask(task, [task, inactive], [relation("task", inactive.id, "belongs_to_area")]), null);
});

test("UI-04c: filters and timeline suppression do not alter membership or duplicate tasks", () => {
  const todayHigh = entity("today-high", "task", "personal", { when: day, priority: "high" });
  const todayLow = entity("today-low", "task", "personal", { when: day, priority: "low" });
  const tomorrow = entity("tomorrow-high", "task", "personal", { when: "2026-11-06", priority: "high" });
  const [first, next] = sectionIds({ entities: [todayLow, todayHigh, tomorrow], relations: [],
    priorityFilter: "high", excludeTimelineIds: new Set(["today-high"]) });
  assert.deepEqual(first, []);
  assert.deepEqual(next, ["tomorrow-high"]);
  const [sorted] = sectionIds({ entities: [todayLow, todayHigh], relations: [], sortBy: "priority" });
  assert.deepEqual(sorted, ["today-high", "today-low"]);
});

test("UI-04c: My Plan preview stays opt-in and preserves legacy Today/other view branches", () => {
  const page = readFileSync(new URL("../app/ui/lumi-app-root.tsx", import.meta.url), "utf8");
  const list = readFileSync(new URL("../app/ui/views/entity-list.tsx", import.meta.url), "utf8");
  const today = readFileSync(new URL("../app/ui/views/today-view.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../app/ui/views/day-timeline.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/lumi-my-plan-v1.css", import.meta.url), "utf8");
  assert.match(page, /data-my-plan-preview=\{mobileDesignV1Preview && app\.mobilePlanPreviewActive && view === "Today"/);
  assert.match(list, /const myPlanPreview = mobileDesignV1Preview && app\.mobilePlanPreviewActive && view === "Today"/);
  assert.match(list, /myPlanPreview \? \(/);
  assert.match(list, /view === "Projects" \? null : listed\.map/);
  assert.match(list, /role="group" aria-label=\{group\.accessibleLabel\}/);
  assert.match(list, /data-my-plan-aggregate-blocked/);
  assert.match(today, /Návrh Lumi/);
  assert.match(today, /myPlanV1EventsTitle/);
  assert.match(today, /data-plan-proposal-review/);
  assert.match(today, /data-plan-proposal-impact/);
  assert.match(today, /aktualizují se jeho značky Dnes/);
  assert.match(today, /Its deadline, workspace, Area and other tasks stay unchanged/);
  assert.match(today, /data-plan-proposal-approve/);
  assert.match(today, /data-plan-proposal-reject/);
  assert.match(today, /previewProposal && !proposalReviewed/);
  assert.match(today, /useEffect\(\(\) => \{ setReviewedProposal\(null\); setProposalFailed\(false\); \}/);
  assert.match(timeline, /entry\.kind === "event"/);
  assert.match(timeline, /myPlanV1EventIcon/);
  assert.match(css, /\.appShell\[data-my-plan-preview="true"\]/);
  assert.match(css, /var\(--v1-area-personal\)/);
  assert.match(css, /var\(--v1-neutral-stroke\)/);
});


test("UI-04c: keyboard and drag reorder use only rendered peers in the same day and Area", () => {
  const work = entity("work", "area"); work.title = "Práce";
  const home = entity("home", "area"); home.title = "Osobní";
  const project = entity("project", "project");
  const tasks = [
    entity("deadline-only", "task", "personal", { deadline: day, when: "2026-12-01" }),
    entity("today-sibling", "task", "personal", { when: day }),
    entity("different-area", "task", "personal", { when: day }),
    entity("tomorrow-only", "task", "personal", { when: "2026-12-01", deadline: "2026-11-06" }),
    entity("tomorrow-sibling", "task", "personal", { when: "2026-11-06" }),
    entity("far-future", "task", "personal", { when: "2026-12-01" }),
    entity("timeline", "task", "personal", { when: day }),
    entity("filtered", "task", "personal", { when: day, priority: "low" }),
  ];
  tasks.forEach((task, index) => { task.createdAt = index * 1000; });
  const links = [
    relation("deadline-only", project.id, "belongs_to_project"),
    relation(project.id, work.id, "belongs_to_area"),
    relation("today-sibling", work.id, "belongs_to_area"),
    relation("different-area", home.id, "belongs_to_area"),
    relation("tomorrow-only", work.id, "belongs_to_area"),
    relation("tomorrow-sibling", work.id, "belongs_to_area"),
    relation("far-future", work.id, "belongs_to_area"),
    relation("timeline", work.id, "belongs_to_area"),
    relation("filtered", work.id, "belongs_to_area"),
  ];
  const sections = buildMyPlanPreview({
    workspaceId: "personal", today: day, entities: [work, home, project, ...tasks],
    relations: links, priorityFilter: "high", excludeTimelineIds: new Set(["timeline"]),
  });
  // Priority filtering is an existing live feature. Make the two visible tasks
  // high-priority while unrelated rows remain excluded.
  assert.equal(sections[0].count, 0);
  const visible = buildMyPlanPreview({
    workspaceId: "personal", today: day, entities: [work, home, project, ...tasks],
    relations: links, excludeTimelineIds: new Set(["timeline"]),
  });
  const todayPeers = previewReorderPeers(visible, "deadline-only", "task:Today");
  assert.deepEqual(todayPeers?.map((x) => x.id), ["deadline-only", "today-sibling", "filtered"]);
  assert.deepEqual(previewReorderPeers(visible, "tomorrow-only", "task:Upcoming")?.map((x) => x.id),
    ["tomorrow-only", "tomorrow-sibling"]);
  assert.equal(previewReorderPeers(visible, "deadline-only", "task:Today", "different-area"), null);
  assert.equal(previewReorderPeers(visible, "deadline-only", "task:Today", "tomorrow-only"), null);
  assert.equal(previewReorderPeers(visible, "deadline-only", "task:Upcoming", "today-sibling"), null);
  assert.equal(previewReorderPeers(visible, "tomorrow-only", "task:Today", "tomorrow-sibling"), null);
  assert.equal(previewReorderPeers(visible, "deadline-only", "task:Today", "timeline"), null);
  assert.equal(previewReorderPeers(visible, "far-future", "task:Upcoming", "tomorrow-sibling"), null);
  assert.equal(previewReorderPeers(visible, "deadline-only", "task:Anytime"), null);
  assert.deepEqual(previewReorderPeers(sections, "deadline-only", "task:Today"), null);
});

test("UI-04c: preview reorder never falls back to legacy Today/Upcoming or changes Area/date", () => {
  const app = readFileSync(new URL("../app/ui/use-lumi-app.tsx", import.meta.url), "utf8");
  assert.match(app, /const planReorderSections = mobileDesignV1Preview && mobilePlanPreviewActive/);
  assert.match(app, /buildMyPlanPreview\(\{ entities: items, relations: scopedRelations,/);
  assert.match(app, /excludeTimelineIds: todayTimelineTaskIds,/);
  assert.match(app, /const planPeers = planTaskDrag[\s\S]*?previewReorderPeers\(planReorderSections!, source\.id, scope, targetEntity\.id, sortBy\)/);
  assert.match(app, /if \(planTaskDrag && !planPeers\) return/);
  assert.match(app, /if \(planTaskDrag\) return; \/\/ cross-type drops/);
  assert.match(app, /if \(planTaskDrag && \(sortBy !== "manual" \|\| target\.startsWith\("section:"\)\)\) return/);
  assert.match(app, /const planPeers = planKeyboard \? previewReorderPeers\(planReorderSections!, entity\.id, scope, undefined, sortBy\)/);
  assert.match(app, /if \(planKeyboard && !planPeers\) return/);
  assert.match(app, /if \(!planTaskDrag && view === "Today"/);
  assert.match(app, /if \(!planKeyboard && view === "Today"/);
});


test("UI-04c: suggestions count visible overdue deadlines but never defer a protected deadline", () => {
  // Deadline-only work is shown in Dnes even though legacy Today excludes it.
  // Seven overdue tasks make the day overloaded, but none may be deferred.
  const protectedTasks = Array.from({ length: 7 }, (_, index) =>
    entity(`overdue-${index}`, "task", "personal", {
      deadline: "2026-11-01", when: "2026-12-01",
    }));
  const ordinary = entity("can-defer", "task", "personal", { when: day });
  const all = [...protectedTasks, ordinary];
  const visible = buildMyPlanPreview({
    workspaceId: "personal", today: day, entities: all, relations: [],
  })[0].groups.flatMap((group) => group.tasks);
  assert.equal(visible.length, 8);
  const selected = pickSummarySuggestion({
    ordered: visible, todayCount: visible.length, openTasks: all, today: day,
    calendarOverloaded: false, todayTaskIds: new Set(visible.map((task) => task.id)),
  });
  assert.equal(selected?.task.id, "can-defer");
  assert.equal(selected?.suggestion.reason, "deferOverloaded");
  assert.equal(selected?.suggestion.params.todayCount, 8);
  // The former legacy picker counted a single Today task and had no proposal.
  assert.equal(pickSummarySuggestion({
    ordered: [ordinary], todayCount: 1, openTasks: all, today: day,
    calendarOverloaded: false,
  }), null);
});

test("UI-04c: proposal candidates exclude timeline-linked and priority-filtered rows", () => {
  const normal = Array.from({ length: 8 }, (_, i) =>
    entity(`task-${i}`, "task", "personal", { when: day, priority: i < 7 ? "high" : "low" }));
  const visible = buildMyPlanPreview({
    workspaceId: "personal", today: day, entities: normal, relations: [],
    priorityFilter: "high", excludeTimelineIds: new Set(["task-6"]),
  })[0].groups.flatMap((group) => group.tasks);
  assert.deepEqual(visible.map((task) => task.id),
    ["task-0", "task-1", "task-2", "task-3", "task-4", "task-5"]);
  const picked = pickSummarySuggestion({
    ordered: visible, todayCount: visible.length, openTasks: normal,
    today: day, calendarOverloaded: false,
    todayTaskIds: new Set(visible.map((task) => task.id)),
  });
  assert.equal(picked, null); // six visible rows, so no overloaded-day suggestion
  const forced = pickSummarySuggestion({
    ordered: visible, todayCount: visible.length, openTasks: normal,
    today: day, calendarOverloaded: true,
    todayTaskIds: new Set(visible.map((task) => task.id)),
  });
  assert.ok(forced);
  assert.notEqual(forced.task.id, "task-6");
  assert.notEqual(forced.task.id, "task-7");
  assert.equal(forced.suggestion.params.todayCount, 6);
});

test("UI-04c: reviewing task+target must not authorize changed revisions, fields or proposal evidence", () => {
  const task = entity("proposal", "task", "personal", { when: day, priority: "low" });
  task.title = "Original";
  task.updatedAt = 1234;
  const suggestion = {
    task, suggestion: { target: "2026-11-06", reason: "deferOverloaded",
      params: { todayCount: 8, dayCount: 1, date: "2026-11-06" } },
  };
  const original = todayProposalReviewKey(suggestion, "personal", day);
  assert.equal(todayProposalReviewKey(suggestion, "personal", day), original);
  assert.notEqual(todayProposalReviewKey(suggestion, "personal", "2026-11-06"), original);
  assert.notEqual(todayProposalReviewKey(suggestion, "shared", day), original);
  assert.notEqual(todayProposalReviewKey({ ...suggestion, task: { ...task, updatedAt: 1235 } }, "personal", day), original);
  assert.notEqual(todayProposalReviewKey({ ...suggestion, task: { ...task, title: "Edited" } }, "personal", day), original);
  assert.notEqual(todayProposalReviewKey({ ...suggestion, task: {
    ...task, properties: { ...task.properties, priority: "high" },
  } }, "personal", day), original);
  assert.notEqual(todayProposalReviewKey({ ...suggestion, suggestion: {
    ...suggestion.suggestion, reason: "deferBusyWeek",
  } }, "personal", day), original);
  assert.notEqual(todayProposalReviewKey({ ...suggestion, suggestion: {
    ...suggestion.suggestion, params: { ...suggestion.suggestion.params, todayCount: 7 },
  } }, "personal", day), original);
  assert.notEqual(todayProposalTaskSignature(task), todayProposalTaskSignature({
    ...task, properties: { ...task.properties, when: "2026-11-07" },
  }));
});

test("UI-04c: approve enforces the reviewed signature inside local write transaction", () => {
  const view = readFileSync(new URL("../app/ui/views/today-view.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/ui/use-lumi-app.tsx", import.meta.url), "utf8");
  assert.match(view, /ordered: previewProposal \? previewTodayTasks : collection/);
  assert.match(view, /todayCount: previewProposal \? previewTodayTasks\.length : todayTasks\.length/);
  assert.match(view, /todayTaskIds: previewTodayTaskIds/);
  assert.match(view, /excludeTimelineIds: app\.todayTimelineTaskIds, language/);
  assert.match(view, /todayProposalReviewKey\(picked, activeWorkspaceId, today\)/);
  assert.match(view, /!proposalReviewed \|\| !proposalKey/);
  assert.match(view, /todayProposalTaskSignature\(picked\.task\)/);
  assert.match(view, /data-plan-proposal-retry/);
  assert.match(view, /if \(!saved\) setProposalFailed\(true\)/);
  assert.match(app, /expectedTaskSnapshot\?: string/);
  assert.match(app, /todayProposalTaskSignature\(stored\) !== expectedTaskSnapshot/);
  assert.match(app, /db\.transaction\("rw", db\.entities, async \(\) => \{/);
  assert.match(app, /!loaded \|\| todayProposalTaskSignature\(loaded\) !== expectedTaskSnapshot/);
  assert.match(app, /}, `deferred \$\{choice\}`, false, expectedTaskSnapshot\)/);
});


test("UI-04c: switching from priority sorting before manual reorder avoids rank corruption", () => {
  const a = entity("A", "task", "personal", { when: day, priority: "high",
    manualOrders: { "personal:task:Today": 3000 } });
  const b = entity("B", "task", "personal", { when: day, priority: "medium",
    manualOrders: { "personal:task:Today": 1000 } });
  const c = entity("C", "task", "personal", { when: day, priority: "low",
    manualOrders: { "personal:task:Today": 2000 } });
  const input = { entities: [a, b, c], relations: [], workspaceId: "personal", today: day };
  const priority = buildMyPlanPreview({ ...input, sortBy: "priority" });
  const manual = buildMyPlanPreview({ ...input, sortBy: "manual" });
  assert.deepEqual(priority[0].groups[0].tasks.map((task) => task.id), ["A", "B", "C"]);
  assert.deepEqual(manual[0].groups[0].tasks.map((task) => task.id), ["B", "C", "A"]);
  // Before the fix, moving B below C in priority mode assigned B a rank of
  // 3000, then switched to manual and displayed C,A,B instead of A,C,B.
  // No drag or keyboard helper may accept non-manually sorted neighbours.
  for (const mode of ["priority", "date", "created"]) {
    assert.equal(previewReorderPeers(priority, "B", "task:Today", "C", mode), null);
    assert.equal(previewReorderPeers(priority, "B", "task:Today", undefined, mode), null);
  }
  assert.deepEqual(previewReorderPeers(manual, "B", "task:Today", "C", "manual")?.map((task) => task.id), ["B", "C", "A"]);
});

test("UI-04c: reorder edit enters manual sorting before handles appear and closes on sort change", () => {
  const ui = readFileSync(new URL("../app/ui/views/entity-list.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../app/ui/use-lumi-app.tsx", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../lib/my-plan-preview.ts", import.meta.url), "utf8");
  assert.match(ui, /if \(myPlanPreview && !reorderPreview && sortBy !== "manual"\) setSortBy\("manual"\)/);
  assert.match(ui, /if \(myPlanPreview && sortBy !== "manual"\) setReorderPreview\(false\)/);
  assert.match(ui, /\(!myPlanPreview \|\| sortBy === "manual"\)/);
  assert.match(ui, /Upravit pořadí ručně/);
  assert.match(hook, /if \(planTaskDrag && \(sortBy !== "manual" \|\| target\.startsWith\("section:"\)\)\) return/);
  assert.match(hook, /previewReorderPeers\(planReorderSections!, entity\.id, scope, undefined, sortBy\)/);
  assert.match(helper, /if \(sortBy !== "manual"\) return null/);
});


// Both keyboard (ArrowDown) and native/pointer drag call completeDrop, which
// computes this same list before calling previewManualRankUpdates.
const moveAfter = (peers, sourceId, targetId) => {
  const moved = [...peers];
  const sourceIndex = moved.findIndex((item) => item.id === sourceId);
  const targetIndex = moved.findIndex((item) => item.id === targetId);
  const [item] = moved.splice(sourceIndex, 1);
  const insertionIndex = moved.findIndex((row) => row.id === targetId);
  moved.splice(insertionIndex + (sourceIndex < targetIndex ? 1 : 0), 0, item);
  return moved;
};
const applyRanks = (peers, updates, scope) => peers.map((task) => {
  const update = updates.find(({ id }) => id === task.id);
  return update ? { ...task, properties: { ...task.properties,
    manualOrders: { ...task.properties.manualOrders, [`${task.workspaceId}:${scope}`]: update.rank },
  } } : task;
});

test("UI-04c: identical manual ranks remain movable by ArrowDown and drag without silent no-op", () => {
  const tasks = ["A", "B", "C"].map((id) => {
    const task = entity(id, "task", "personal", { when: day });
    task.createdAt = 1000; // same-timestamp imports use ID as final sort tie-breaker
    return task;
  });
  for (const way of ["keyboard", "pointer-or-native-drag"]) {
    const preview = buildMyPlanPreview({ entities: tasks, relations: [], workspaceId: "personal", today: day });
    const peers = previewReorderPeers(preview, "A", "task:Today", "B", "manual");
    assert.deepEqual(peers?.map((task) => task.id), ["A", "B", "C"]);
    const targetId = way === "keyboard" ? peers[1].id : "B";
    const ordered = moveAfter(peers, "A", targetId);
    assert.deepEqual(ordered.map((task) => task.id), ["B", "A", "C"]);
    const updates = previewManualRankUpdates(ordered, peers, "A", "task:Today");
    assert.ok(updates?.length);
    const persisted = applyRanks(tasks, updates, "task:Today").sort(byManualOrder("task:Today"));
    assert.deepEqual(persisted.map((task) => task.id), ["B", "A", "C"]);
    assert.equal(new Set(persisted.map((task) => manualOrder(task, "task:Today"))).size, 3);
  }
});

test("UI-04c: fallback retains hidden/timeline peer slots and never writes another Area", () => {
  const personal = entity("area-personal", "area"); personal.title = "Osobní";
  const work = entity("area-work", "area"); work.title = "Práce";
  const tasks = ["A", "H", "B", "C", "W"].map((id, i) => {
    const task = entity(id, "task", "personal", { when: day,
      priority: id === "H" ? "low" : "high" });
    task.createdAt = 1000 + i;
    return task;
  });
  const relations = tasks.map((task) => relation(task.id,
    task.id === "W" ? work.id : personal.id, "belongs_to_area"));
  const source = { entities: [personal, work, ...tasks], relations, workspaceId: "personal", today: day };
  const filtered = buildMyPlanPreview({ ...source, priorityFilter: "high" });
  const full = buildMyPlanPreview({ ...source, priorityFilter: "all" });
  const visible = previewReorderPeers(filtered, "A", "task:Today", "B", "manual");
  const allPeers = previewReorderPeers(full, "A", "task:Today", undefined, "manual");
  assert.deepEqual(visible.map((row) => row.id), ["A", "B", "C"]);
  assert.deepEqual(allPeers.map((row) => row.id), ["A", "H", "B", "C"]);
  const desired = moveAfter(visible, "A", "B");
  const updates = previewManualRankUpdates(desired, allPeers, "A", "task:Today");
  assert.ok(updates?.length);
  assert.ok(updates.every((entry) => entry.id !== "W"));
  const applied = applyRanks(tasks, updates, "task:Today");
  const changed = buildMyPlanPreview({ ...source, entities: [personal, work, ...applied] });
  assert.deepEqual(changed[0].groups.find((g) => g.areaId === personal.id).tasks.map((row) => row.id),
    ["B", "H", "A", "C"]);
  assert.deepEqual(buildMyPlanPreview({
    ...source, entities: [personal, work, ...applied], priorityFilter: "high",
  })[0].groups.find((g) => g.areaId === personal.id).tasks.map((row) => row.id),
    ["B", "A", "C"]);
  assert.equal(applied.find((row) => row.id === "W").updatedAt, tasks[4].updatedAt);
  assert.equal(applied.find((row) => row.id === "W").properties.manualOrders, undefined);
});

test("UI-04c: only the moved rank is written when manual neighbours have a real gap", () => {
  const tasks = ["A", "B", "C"].map((id, i) => entity(id, "task", "personal", {
    when: day, manualOrders: { "personal:task:Today": (i + 1) * 1000 },
  }));
  const before = buildMyPlanPreview({ entities: tasks, relations: [], workspaceId: "personal", today: day });
  const peers = previewReorderPeers(before, "A", "task:Today");
  const moved = moveAfter(peers, "A", "B");
  const updates = previewManualRankUpdates(moved, peers, "A", "task:Today");
  assert.deepEqual(updates, [{ id: "A", rank: 2500 }]);
  assert.deepEqual(applyRanks(tasks, updates, "task:Today").sort(byManualOrder("task:Today")).map((row) => row.id), ["B", "A", "C"]);
  assert.deepEqual(previewManualRankUpdates(peers, peers, "A", "task:Today"), []);
  assert.equal(previewManualRankUpdates(moved, peers.slice(1), "A", "task:Today"), null);
});

test("UI-04c: app persists collision-recovery ranks atomically and preserves legacy path", () => {
  const app = readFileSync(new URL("../app/ui/use-lumi-app.tsx", import.meta.url), "utf8");
  assert.match(app, /previewManualRankUpdates\(ordered, allAreaPeers, movedId, scope\)/);
  assert.match(app, /db\.transaction\("rw", db\.entities, async \(\) => \{/);
  assert.match(app, /db\.entities\.bulkGet\(allAreaPeers\.map/);
  assert.match(app, /task\.updatedAt !== allAreaPeers\[index\]\.updatedAt/);
  assert.match(app, /await db\.entities\.update\(next\.id, \{/);
  assert.match(app, /if \(!saved\) \{\s*setPlanReorderError\(true\);\s*return;\s*\}/);
  assert.match(app, /setPlanReorderError\(false\);\s*await syncToServer\(\);\s*await load\(\);/);
  assert.match(app, /previewReorderPeers\(fullPlan, source\.id, scope, undefined, "manual"\)/);
  assert.match(app, /await persistManualOrder\(peers, source\.id, scope, allAreaPeers\)/);
  assert.match(app, /await persistManualOrder\(peers, source\.id, scope\);/);
});


test("UI-04c: collision reindex is all-or-nothing when a changed peer is held, unsent or conflicted", () => {
  const tasks = ["A", "B", "C"].map((id) => {
    const task = entity(id, "task", "personal", { when: day });
    task.createdAt = 1000;
    return task;
  });
  const preview = buildMyPlanPreview({ workspaceId: "personal", today: day, entities: tasks, relations: [] });
  const peers = previewReorderPeers(preview, "A", "task:Today", "B", "manual");
  const reordered = moveAfter(peers, "A", "B");
  const updates = previewManualRankUpdates(reordered, peers, "A", "task:Today");
  assert.deepEqual(reordered.map((task) => task.id), ["B", "A", "C"]);
  assert.deepEqual(updates.map((entry) => entry.id), ["A", "C"]);
  const empty = new Set();
  assert.equal(previewRankWritesAllowed(updates, tasks, "personal", empty, empty), true);
  assert.equal(previewRankWritesAllowed(updates, tasks, "personal", new Set(["C"]), empty), false);
  assert.equal(previewRankWritesAllowed(updates, tasks, "personal", empty, new Set(["C"])), false);
  const conflicted = tasks.map((task) => task.id === "C" ? {
    ...task, properties: { ...task.properties, syncConflicts: [
      { id: "conflict-1", field: "title", lostValue: "prior version", at: 1000 },
    ] },
  } : task);
  assert.equal(previewRankWritesAllowed(updates, conflicted, "personal", empty, empty), false);

  // A filtered/blocked task not in the planned update set is never written.
  assert.equal(previewRankWritesAllowed(updates, tasks, "personal", new Set(["B"]), empty), true);
  // Simulate the integration's preflight: all rejected cases yield zero writes,
  // leaving both moved and unrelated records untouched.
  for (const [records, held, unsent] of [
    [tasks, new Set(["C"]), empty],
    [tasks, empty, new Set(["C"])],
    [conflicted, empty, empty],
  ]) {
    const changed = previewRankWritesAllowed(updates, records, "personal", held, unsent)
      ? applyRanks(records, updates, "task:Today") : records;
    assert.deepEqual(changed, records);
  }
});

test("UI-04c: guarded ranks reject missing, invalid, cross-workspace and non-open update targets", () => {
  const good = entity("good", "task", "personal", { when: day });
  const updates = [{ id: "good", rank: 2000 }];
  const none = new Set();
  assert.equal(previewRankWritesAllowed(updates, [good], "personal", none, none), true);
  assert.equal(previewRankWritesAllowed(updates, [good], "all", none, none), false);
  assert.equal(previewRankWritesAllowed(updates, [good], "shared", none, none), false);
  assert.equal(previewRankWritesAllowed(updates, [], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed([], [good], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed([{ id: "missing", rank: 1 }], [good], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed([{ id: "good", rank: Infinity }], [good], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed([updates[0], updates[0]], [good], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed(updates, [{ ...good, status: "completed" }], "personal", none, none), false);
  assert.equal(previewRankWritesAllowed(updates, [{ ...good, title: "" }], "personal", none, none), false);
});

test("UI-04c: all protected peer checks run before first atomic reorder update", () => {
  const app = readFileSync(new URL("../app/ui/use-lumi-app.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/ui/views/entity-list.tsx", import.meta.url), "utf8");
  const start = app.indexOf('if (allAreaPeers) {', app.indexOf('async function persistManualOrder('));
  const end = app.indexOf('    const timestamp = writeTime();', app.indexOf('      return;', start));
  const collision = app.slice(start, app.indexOf('    const timestamp = writeTime();\n    const movedIndex', start));
  assert.ok(collision.length > 0);
  assert.match(collision, /previewManualRankUpdates\(ordered, allAreaPeers, movedId, scope\)/);
  assert.match(collision, /previewRankWritesAllowed\(/);
  assert.match(collision, /new Set\(heldReasons\.keys\(\)\), unsent/);
  assert.match(collision, /authState === "ready" && syncStatus === "synced"/);
  assert.match(collision, /activeWorkspaceRef\.current === workspaceId && writeWorkspaceId === workspaceId/);
  assert.match(collision, /if \(!updates \|\| !writableScope\(\) \|\| !eligible\(allAreaPeers\) \|\|/);
  assert.match(collision, /!previewRankNextRecords\(updates, allAreaPeers, scope, timestamp\)/);
  assert.match(collision, /await db\.transaction\("rw", db\.entities, async \(\) => \{/);
  assert.match(collision, /if \(!writableScope\(\) \|\| latest\.some\(/);
  assert.match(collision, /if \(!eligible\(fresh\)\) return;/);
  assert.match(collision, /const nextRecords = previewRankNextRecords\(updates, fresh, scope, timestamp\)/);
  assert.match(collision, /if \(!nextRecords\) return;/);
  assert.ok(collision.indexOf('if (!nextRecords) return;') < collision.indexOf('await db.entities.update(next.id, {'));
  assert.match(collision, /if \(!saved\) \{\s*setPlanReorderError\(true\);/);
  assert.match(ui, /role="alert" data-plan-reorder-refused/);
  assert.match(ui, /app\.setPlanReorderError\(false\)/);
});


test("UI-04c: single rank change checks the full successor at the exact 250k property boundary", () => {
  const scope = "task:Today", timestamp = 1793900000000;
  const updates = [{ id: "large", rank: 2500 }];
  const template = entity("large", "task", "personal", { when: day, notes: "" });
  const templateNext = previewRankNextRecords(updates, [template], scope, timestamp);
  assert.ok(templateNext);
  // Derive the boundary from the real serialized successor, including the
  // manualOrders key and activity event. Do not change the server limit.
  const maxNoteLength = 250000 - JSON.stringify(templateNext[0].properties).length;
  const fits = { ...template, properties: { ...template.properties, notes: "x".repeat(maxNoteLength) } };
  const tooLargeAfter = { ...template, properties: { ...template.properties, notes: "x".repeat(maxNoteLength + 1) } };
  assert.ok(JSON.stringify(tooLargeAfter.properties).length < 250000);
  const empty = new Set();
  assert.equal(previewRankWritesAllowed(updates, [fits], "personal", empty, empty), true);
  assert.equal(previewRankWritesAllowed(updates, [tooLargeAfter], "personal", empty, empty), true);
  const successor = previewRankNextRecords(updates, [fits], scope, timestamp);
  assert.ok(successor);
  assert.equal(JSON.stringify(successor[0].properties).length, 250000);
  assert.equal(successor[0].updatedAt, timestamp);
  assert.deepEqual(successor[0].properties.manualOrders, { "personal:task:Today": 2500 });
  assert.deepEqual(successor[0].properties.activity, [{ at: timestamp, action: "reordered" }]);
  assert.equal(previewRankNextRecords(updates, [tooLargeAfter], scope, timestamp), null);
  assert.equal(tooLargeAfter.properties.manualOrders, undefined);
  assert.equal(tooLargeAfter.updatedAt, template.updatedAt);
});

test("UI-04c: near-limit member aborts all equal-rank normalization before any peer changes", () => {
  const tasks = ["A", "B", "C"].map((id) => {
    const task = entity(id, "task", "personal", { when: day });
    task.createdAt = 1000;
    return task;
  });
  const plan = buildMyPlanPreview({ entities: tasks, relations: [], workspaceId: "personal", today: day });
  const peers = previewReorderPeers(plan, "A", "task:Today", "B", "manual");
  const proposedOrder = moveAfter(peers, "A", "B");
  const updates = previewManualRankUpdates(proposedOrder, peers, "A", "task:Today");
  assert.deepEqual(updates.map((entry) => entry.id), ["A", "C"]);
  const empty = new Set();
  // C is an unrelated neighbour. Its original data is valid, but adding a
  // manual rank and activity entry makes it un-sendable. A must not change.
  const heavy = tasks.map((task) => task.id === "C"
    ? { ...task, properties: { ...task.properties, notes: "z".repeat(249880) } }
    : task);
  assert.equal(previewRankWritesAllowed(updates, heavy, "personal", empty, empty), true);
  const before = JSON.stringify(heavy);
  assert.equal(previewRankNextRecords(updates, heavy, "task:Today", 1793900000000), null);
  assert.equal(JSON.stringify(heavy), before);
  const valid = previewRankNextRecords(updates, tasks, "task:Today", 1793900000000);
  assert.ok(valid);
  assert.deepEqual(valid.map((task) => task.id), ["A", "C"]);
  const records = tasks.map((task) => valid.find((next) => next.id === task.id) || task);
  assert.deepEqual(records.sort(byManualOrder("task:Today")).map((task) => task.id), ["B", "A", "C"]);
});

test("UI-04c: prospective batch rejects missing records and keeps clipped activity logs", () => {
  const task = entity("task", "task", "personal", {
    when: day, activity: Array.from({ length: 60 }, (_, at) => ({ at, action: "old" })),
  });
  assert.equal(previewRankNextRecords([{ id: "absent", rank: 1 }], [task], "task:Today", 3), null);
  assert.equal(previewRankNextRecords([{ id: "task", rank: NaN }], [task], "task:Today", 3), null);
  assert.equal(previewRankNextRecords([{ id: "task", rank: 1 }], [task], "task:Today", Infinity), null);
  assert.equal(previewRankNextRecords([{ id: "task", rank: 1 }, { id: "task", rank: 2 }], [task], "task:Today", 3), null);
  const next = previewRankNextRecords([{ id: "task", rank: 1 }], [task], "task:Today", 3);
  assert.ok(next);
  assert.equal(next[0].properties.activity.length, 50);
  assert.deepEqual(next[0].properties.activity.at(-1), { at: 3, action: "reordered" });
  assert.equal(task.properties.activity.length, 60); // pure helper; no mutation
});
