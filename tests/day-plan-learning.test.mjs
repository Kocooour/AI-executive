import assert from "node:assert/strict";
import test from "node:test";
import { learnPlanning } from "../lib/day-plan-learning.ts";
import { nextWorkingDate, reviewPlan } from "../lib/day-plan-review.ts";
import { matchesDayPlanCandidate } from "../lib/day-plan-decision.ts";

const task = (id, title, properties = {}, status = "open") => ({ id, title, type: "task", status,
  workspaceId: "personal", properties: { projectId: "p1", ...properties }, createdAt: 0, updatedAt: 0 });
const feedback = (plannedMinutes, chosenStart = "2026-10-02T07:00:00Z") =>
  ({ decision: "accepted", plannedMinutes, chosenStart });

test("planning learns only after three comparable samples and respects explicit estimates", () => {
  const target = task("target", "Write report");
  const peers = [task("a", "Write memo", { planningHistory: [feedback(25)] }),
    task("b", "Write notes", { planningHistory: [feedback(45)] })];
  assert.equal(learnPlanning(target, peers, "Europe/Prague").estimateSource, "default");
  peers.push(task("c", "Write letter", { planningHistory: [feedback(100)] }));
  assert.deepEqual(learnPlanning(target, peers, "Europe/Prague"), {
    estimatedMinutes: 45, estimateSource: "learned", estimateSamples: 3, preferredMinute: 540, timeSamples: 3,
  });
  assert.equal(learnPlanning(task("explicit", "Write report", { estimatedMinutes: 35 }), peers, "Europe/Prague").estimatedMinutes, 35);
  assert.equal(learnPlanning(task("other", "Review report"), peers, "Europe/Prague").estimatedMinutes, 60);
});

test("learned planned duration is bounded and rejected feedback is ignored", () => {
  const peers = [1, 2, 3].map((n) => task(String(n), "Write item", { planningHistory: [feedback(450)] }));
  peers.push(task("dismissed", "Write item", { planningHistory: [{ decision: "dismissed", plannedMinutes: 10 }] }));
  const result = learnPlanning(task("target", "Write report"), peers, "Europe/Prague");
  assert.equal(result.estimatedMinutes, 120);
  assert.equal(result.estimateSamples, 3);
});

test("even number of planning samples uses the conventional median", () => {
  const peers = [20, 30, 100, 120].map((minutes, index) =>
    task(String(index), "Write item", { planningHistory: [feedback(minutes)] }));
  const result = learnPlanning(task("target", "Write report"), peers, "Europe/Prague");
  assert.equal(result.estimatedMinutes, 65);
  assert.equal(result.estimateSamples, 4);
});

test("evening review compares approved plan with status and finds the next working date", () => {
  const tasks = [
    task("completed", "Write report", { plannedStart: "2026-10-02T08:00:00Z" }, "completed"),
    task("open", "Write memo", { plannedStart: "2026-10-02T10:00:00Z" }),
    task("moved", "Write notes", { planningFeedback: { date: "2026-10-02", decision: "tomorrow" } }),
    task("dismissed", "Write later", { planningFeedback: { date: "2026-10-02", decision: "dismissed" } }),
  ];
  const review = reviewPlan(tasks, "2026-10-02", "Europe/Prague", [1, 2, 3, 4, 5]);
  assert.deepEqual([review.planned, review.completed, review.open, review.moved, review.dismissed, review.nextWorkday],
    [2, 1, 1, 1, 1, "2026-10-05"]);
  assert.equal(review.carryover.length, 2);
  assert.equal(nextWorkingDate("2026-10-02", []), "");
});

test("review retains an accepted block after later feedback replaced the latest marker", () => {
  const item = task("one", "Write report", {
    planningHistory: [{ date: "2026-10-02", decision: "accepted" }, { date: "2026-10-03", decision: "adjusted" }],
    planningFeedback: { date: "2026-10-03", decision: "adjusted" },
  });
  assert.equal(reviewPlan([item], "2026-10-02", "Europe/Prague", [1, 2, 3, 4, 5]).planned, 1);
});

test("review carries an accepted then moved task only once", () => {
  const item = task("one", "Write report", {
    planningHistory: [{ date: "2026-10-02", decision: "accepted" }, { date: "2026-10-02", decision: "tomorrow" }],
    planningFeedback: { date: "2026-10-02", decision: "tomorrow" },
  });
  const review = reviewPlan([item], "2026-10-02", "Europe/Prague", [1, 2, 3, 4, 5]);
  assert.equal(review.planned, 1);
  assert.equal(review.moved, 1);
  assert.deepEqual(review.carryover.map((entry) => entry.id), ["one"]);
});

test("day-plan decisions require the exact current proposal or unscheduled task", () => {
  const plan = { calendar: "ready", planBlocks: [{ taskId: "a", start: "2026-10-02T08:00:00Z", end: "2026-10-02T09:00:00Z" }],
    unscheduled: [{ taskId: "b" }] };
  const exact = { taskId: "a", start: "2026-10-02T08:00:00Z", end: "2026-10-02T09:00:00Z" };
  assert.equal(matchesDayPlanCandidate(plan, { ...exact, decision: "accepted" }), true);
  assert.equal(matchesDayPlanCandidate(plan, { ...exact, decision: "tomorrow" }), true);
  assert.equal(matchesDayPlanCandidate(plan, { ...exact, start: "2026-10-02T09:00:00Z", decision: "dismissed" }), false);
  assert.equal(matchesDayPlanCandidate(plan, { taskId: "b", start: "", end: "", decision: "tomorrow" }), true);
  assert.equal(matchesDayPlanCandidate(plan, { taskId: "b", start: "", end: "", decision: "accepted" }), false);
  assert.equal(matchesDayPlanCandidate({ ...plan, calendar: "stale" }, { ...exact, decision: "accepted" }), false);
});
