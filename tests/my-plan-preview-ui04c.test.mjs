import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMyPlanPreview, previewAreaForTask, previewDayForTask, tomorrowOf } from "../lib/my-plan-preview.ts";

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
  assert.match(timeline, /entry\.kind === "event"/);
  assert.match(timeline, /myPlanV1EventIcon/);
  assert.match(css, /\.appShell\[data-my-plan-preview="true"\]/);
  assert.match(css, /var\(--v1-area-personal\)/);
  assert.match(css, /var\(--v1-neutral-stroke\)/);
});
