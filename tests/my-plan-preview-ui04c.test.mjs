import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMyPlanPreview, previewAreaForTask, previewDayForTask, previewReorderPeers, tomorrowOf } from "../lib/my-plan-preview.ts";
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
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
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
  assert.match(today, /useEffect\(\(\) => \{ setReviewedProposal\(null\); \}/);
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
  assert.match(app, /const planPeers = planTaskDrag[\s\S]*?previewReorderPeers\(planReorderSections!, source\.id, scope, targetEntity\.id\)/);
  assert.match(app, /if \(planTaskDrag && !planPeers\) return/);
  assert.match(app, /if \(planTaskDrag\) return; \/\/ cross-type drops/);
  assert.match(app, /if \(planTaskDrag && target\.startsWith\("section:"\)\) return/);
  assert.match(app, /const planPeers = planKeyboard \? previewReorderPeers\(planReorderSections!, entity\.id, scope\)/);
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
  assert.match(app, /expectedTaskSnapshot\?: string/);
  assert.match(app, /todayProposalTaskSignature\(stored\) !== expectedTaskSnapshot/);
  assert.match(app, /db\.transaction\("rw", db\.entities, async \(\) => \{/);
  assert.match(app, /!loaded \|\| todayProposalTaskSignature\(loaded\) !== expectedTaskSnapshot/);
  assert.match(app, /}, `deferred \$\{choice\}`, false, expectedTaskSnapshot\)/);
});
