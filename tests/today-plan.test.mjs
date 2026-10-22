import assert from "node:assert/strict";
import test from "node:test";

const { planSlotsByTask, planMinutesForTasks, planItemsOutsideToday, roundedPlanHours } = await import("../lib/today-plan.ts");
const { pickSummarySuggestion } = await import("../lib/today-summary.ts");
const { homeTodayList } = await import("../lib/home-today.ts");

const block = (taskId, minutes, extra = {}) => ({ taskId, estimatedMinutes: minutes, ...extra });
const plan = {
  existingBlocks: [block("a", 30, { start: "s", end: "e" })],
  planBlocks: [block("b", 45, { start: "s", end: "e" }), block("a", 90, { start: "s2", end: "e2" })],
  unscheduled: [block("c", 20), block("d", 60)],
};

test("one slot per task: existing wins over a proposal, then proposed, then unscheduled", () => {
  const slots = planSlotsByTask(plan);
  assert.equal(slots.get("a").kind, "existing");
  assert.equal(slots.get("a").item.estimatedMinutes, 30);
  assert.equal(slots.get("b").kind, "proposed");
  assert.equal(slots.get("c").kind, "unscheduled");
  assert.equal(slots.has("zzz"), false);
  assert.equal(planSlotsByTask(null).size, 0);
});

test("header minutes count only the tasks in Today, once, and are null without a plan", () => {
  assert.equal(planMinutesForTasks(null, new Set(["a"])), null);
  assert.equal(planMinutesForTasks(plan, new Set(["a", "b", "c"])), 30 + 45 + 20);
  assert.equal(planMinutesForTasks(plan, new Set(["x"])), 0);
  assert.equal(planMinutesForTasks({ existingBlocks: [block("a", Number.NaN)], planBlocks: [], unscheduled: [] }, new Set(["a"])), 0);
});

test("hours are rounded to half an hour, at least half an hour when something is planned", () => {
  assert.equal(roundedPlanHours(0), 0);
  assert.equal(roundedPlanHours(10), 0.5);
  assert.equal(roundedPlanHours(40), 0.5);
  assert.equal(roundedPlanHours(50), 1);
  assert.equal(roundedPlanHours(95), 1.5);
  assert.equal(roundedPlanHours(180), 3);
  assert.equal(roundedPlanHours(Number.NaN), 0);
});

test("plan items outside Today are counted once per task", () => {
  assert.equal(planItemsOutsideToday(plan, new Set(["a", "c"])), 2);
  assert.equal(planItemsOutsideToday(plan, new Set(["a", "b", "c", "d"])), 0);
  assert.equal(planItemsOutsideToday(null, new Set()), 0);
  // Only tasks that still exist as open tasks count.
  assert.equal(planItemsOutsideToday(plan, new Set(["a"]), new Set(["a", "b", "x"])), 1);
});

const TODAY = "2026-10-22";
let n = 0;
const task = (properties = {}, overrides = {}) => ({
  id: `t${++n}`, type: "task", title: `Task ${n}`, status: "open", workspaceId: "personal",
  properties: { when: TODAY, ...properties }, createdAt: 1000, updatedAt: 1000, ...overrides,
});

test("summary suggestion: nothing for a light day, last 'Today is full' candidate otherwise", () => {
  const few = Array.from({ length: 4 }, () => task());
  assert.equal(pickSummarySuggestion({ ordered: few, todayCount: 4, openTasks: few, today: TODAY, calendarOverloaded: false }), null);
  const many = Array.from({ length: 7 }, () => task());
  const picked = pickSummarySuggestion({ ordered: many, todayCount: 7, openTasks: many, today: TODAY, calendarOverloaded: false });
  assert.equal(picked.task.id, many[6].id);
  assert.equal(picked.suggestion.reason, "deferOverloaded");
  assert.equal(picked.suggestion.target, "2026-10-23");
});

test("summary suggestion: skips tasks with a close deadline, takes an overloaded calendar with few tasks", () => {
  const rest = Array.from({ length: 6 }, () => task());
  const urgent = task({ deadline: "2026-10-23" });
  const all = [...rest, urgent];
  const picked = pickSummarySuggestion({ ordered: all, todayCount: 7, openTasks: all, today: TODAY, calendarOverloaded: false });
  assert.equal(picked.task.id, rest[5].id);
  const two = [task(), task()];
  assert.equal(pickSummarySuggestion({ ordered: two, todayCount: 2, openTasks: two, today: TODAY, calendarOverloaded: true }).task.id, two[1].id);
  const onlyUrgent = [task({ deadline: "2026-10-22" })];
  assert.equal(pickSummarySuggestion({ ordered: onlyUrgent, todayCount: 1, openTasks: onlyUrgent, today: TODAY, calendarOverloaded: true }), null);
  assert.equal(pickSummarySuggestion({ ordered: [], todayCount: 9, openTasks: [], today: TODAY, calendarOverloaded: false }), null);
});

test("Home Today leaves out attention subjects, caps the list and counts the same set", () => {
  const tasks = Array.from({ length: 9 }, () => task());
  const attention = [
    { subjectId: tasks[0].id, workspaceId: "personal" },
    { subjectId: tasks[2].id, workspaceId: "personal" },
    // Same id in another workspace is another subject.
    { subjectId: tasks[3].id, workspaceId: "other" },
    { subjectId: "project-1", workspaceId: "personal" },
  ];
  const result = homeTodayList({ todayTasks: tasks, attentionItems: attention, limit: 5 });
  assert.deepEqual(result.shown.map((t) => t.id), [tasks[1], tasks[3], tasks[4], tasks[5], tasks[6]].map((t) => t.id));
  assert.equal(result.total, 7);
  assert.equal(result.more, 2);
  assert.equal(result.inAttention, 2);
  const none = homeTodayList({ todayTasks: tasks.slice(0, 2), attentionItems: [{ subjectId: tasks[0].id, workspaceId: "personal" }, { subjectId: tasks[1].id, workspaceId: "personal" }], limit: 5 });
  assert.equal(none.shown.length, 0);
  assert.equal(none.total, 0);
  assert.equal(none.inAttention, 2);
});

const { attentionPrimaryAction } = await import("../lib/home-today.ts");

test("attention primary action: the date chip for a task with a date reason, Open otherwise", () => {
  const open = { type: "task", status: "open" };
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "deadline_overdue" }, open, true), "defer");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "deadline_soon" }, open, true), "defer");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "planned_date_passed" }, open, true), "defer");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "waiting_follow_up" }, open, true), "open");
  assert.equal(attentionPrimaryAction({ subjectType: "project", ruleId: "project_idle" }, undefined, true), "open");
  // Not in local data, finished, or a read-only workspace.
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "deadline_overdue" }, undefined, true), "open");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "deadline_overdue" }, { type: "task", status: "completed" }, true), "open");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "deadline_overdue" }, open, false), "open");
});
