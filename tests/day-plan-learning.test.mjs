import assert from "node:assert/strict";
import test from "node:test";
import { learnPlanning } from "../lib/day-plan-learning.ts";
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

test("measured work takes precedence after three sessions while an explicit estimate remains authoritative", () => {
  const measured = [25, 40, 95].map((minutes, index) => task(String(index), "Write item", {
    workSessionHistory: [{ sessionId: `s${index}`, actualMinutes: minutes, completedAt: Date.now() }],
    planningHistory: [feedback(120)],
  }));
  const learned = learnPlanning(task("target", "Write report"), measured, "Europe/Prague");
  assert.deepEqual([learned.estimatedMinutes, learned.estimateSource, learned.estimateSamples], [40, "actual", 3]);
  const explicit = learnPlanning(task("explicit", "Write report", { estimatedMinutes: 15 }), measured, "Europe/Prague");
  assert.deepEqual([explicit.estimatedMinutes, explicit.estimateSource], [15, "explicit"]);
});

test("explicit and learned estimates keep whole minutes below ten", () => {
  const peers = [3, 5, 8].map((minutes, index) => task(String(index), "Write item", {
    planningHistory: [feedback(minutes)],
  }));
  const explicit = learnPlanning(task("explicit", "Write report", { estimatedMinutes: 4 }), peers, "Europe/Prague");
  assert.deepEqual([explicit.estimatedMinutes, explicit.estimateSource], [4, "explicit"]);
  const learned = learnPlanning(task("target", "Write report"), peers, "Europe/Prague");
  assert.deepEqual([learned.estimatedMinutes, learned.estimateSource], [5, "learned"]);
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
