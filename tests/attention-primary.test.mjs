import assert from "node:assert/strict";
import test from "node:test";

const { attentionPrimaryAction } = await import("../lib/home-today.ts");

const overdue = { subjectType: "task", ruleId: "deadline_overdue" };
const openTask = { type: "task", status: "open" };

test("a fresh writable task can use the date chip", () => {
  assert.equal(attentionPrimaryAction(overdue, openTask, true, false), "defer");
  assert.equal(attentionPrimaryAction({ ...overdue, ruleId: "planned_date_passed" }, openTask, true), "defer");
});

test("a stale, cached or unsynced attention evaluation cannot offer a quick date edit", () => {
  assert.equal(attentionPrimaryAction(overdue, openTask, true, true), "open");
  assert.equal(attentionPrimaryAction({ ...overdue, ruleId: "deadline_soon" }, openTask, true, true), "open");
});

test("read-only, missing, completed, project and waiting subjects still open details", () => {
  assert.equal(attentionPrimaryAction(overdue, openTask, false, false), "open");
  assert.equal(attentionPrimaryAction(overdue, undefined, true, false), "open");
  assert.equal(attentionPrimaryAction(overdue, { type: "task", status: "completed" }, true, false), "open");
  assert.equal(attentionPrimaryAction({ subjectType: "project", ruleId: "project_idle" }, { type: "project", status: "active" }, true, false), "open");
  assert.equal(attentionPrimaryAction({ subjectType: "task", ruleId: "waiting_follow_up" }, openTask, true, false), "open");
});
