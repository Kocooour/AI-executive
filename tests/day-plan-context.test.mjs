import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-day-plan-context-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");
const claims = await import("../lib/context-claims.ts");
const plan = await import("../lib/day-plan.ts");

function add(entity) { store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt); }
const now = Date.now();
const today = plan.currentDayPlanDate(now);
add({ id: "project:priority", type: "project", title: "Priority project", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
add({ id: "task:priority", type: "task", title: "Priority task", status: "open", workspaceId: "personal",
  properties: { projectId: "project:priority", when: today, estimatedMinutes: 25 }, createdAt: now, updatedAt: now });

function confirmed(predicate, value, overrides = {}) {
  const created = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "project:priority" }, predicate, literal: { type: "string", value }, freshness: "current", sensitivity: "normal", ...overrides }).claim;
  return claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" }).claim;
}

test("day plan explains deadline, duration and eligible confirmed context only", () => {
  confirmed("importance", "high");
  confirmed("waiting_for", "Jana");
  confirmed("importance", "secret high", { sensitivity: "sensitive" });
  confirmed("waiting_for", "Old stakeholder", { freshness: "stale" });
  const item = [...plan.buildDayPlan("personal", today, now).planBlocks, ...plan.buildDayPlan("personal", today, now).unscheduled]
    .find((candidate) => candidate.taskId === "task:priority");
  assert.ok(item);
  assert.equal(item.whyNow.includes("context_importance"), true);
  assert.equal(item.whyNow.includes("context_waiting"), true);
  assert.equal(item.whyNow.includes("duration:25"), true);
  assert.equal(item.whyNow.some((reason) => /secret|Old/.test(reason)), false);
});

test("context-only selection never claims a high task priority", () => {
  add({ id: "task:context-only", type: "task", title: "Waiting task", status: "open", workspaceId: "personal",
    properties: { projectId: "project:priority", estimatedMinutes: 20 }, createdAt: now + 1, updatedAt: now + 1 });
  const item = [...plan.buildDayPlan("personal", today, now).planBlocks, ...plan.buildDayPlan("personal", today, now).unscheduled]
    .find((candidate) => candidate.taskId === "task:context-only");
  assert.ok(item);
  assert.equal(item.reason, "context");
  assert.equal(item.whyNow.includes("high_priority"), false);
  assert.equal(item.whyNow.includes("context_importance"), true);
});

test("a task waiting for someone is not offered in the day plan", () => {
  add({ id: "task:waiting", type: "task", title: "Waiting task", status: "open", workspaceId: "personal",
    properties: { when: today, estimatedMinutes: 20, waiting: true, waitingFor: "Jana" }, createdAt: now, updatedAt: now });
  const result = plan.buildDayPlan("personal", today, now);
  assert.equal([...result.planBlocks, ...result.unscheduled].some((candidate) => candidate.taskId === "task:waiting"), false);
});
