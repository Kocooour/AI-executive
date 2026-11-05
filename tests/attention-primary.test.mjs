import assert from "node:assert/strict";
import test from "node:test";

const { attentionPrimaryAction, attentionEvidenceIsVisible } = await import("../lib/home-today.ts");

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

test("an open Attention dialog is revoked after a successful refresh drops its source", () => {
  const original = { key: "rule-1", fingerprint: "old", workspaceId: "personal", taskId: "task-1" };
  const current = { workspaceId: "personal", items: [
    { attentionKey: "rule-1", sourceFingerprint: "old", subjectId: "task-1" },
  ] };
  assert.equal(attentionEvidenceIsVisible(original, current, false), true);
  assert.equal(attentionEvidenceIsVisible(original, { ...current, items: [] }, false), false);
  assert.equal(attentionEvidenceIsVisible(original, null, false), false);
});

test("an open Attention dialog cannot reuse changed evidence or a different task/workspace", () => {
  const ref = { key: "rule-1", fingerprint: "original", workspaceId: "personal", taskId: "task-1" };
  const record = { attentionKey: "rule-1", sourceFingerprint: "original", subjectId: "task-1" };
  const current = { workspaceId: "personal", items: [record] };
  assert.equal(attentionEvidenceIsVisible(ref, current, false), true);
  assert.equal(attentionEvidenceIsVisible(ref, { ...current, items: [{ ...record, sourceFingerprint: "changed" }] }, false), false);
  assert.equal(attentionEvidenceIsVisible(ref, { ...current, items: [{ ...record, subjectId: "task-2" }] }, false), false);
  assert.equal(attentionEvidenceIsVisible(ref, { ...current, items: [{ ...record, attentionKey: "rule-2" }] }, false), false);
  assert.equal(attentionEvidenceIsVisible(ref, { ...current, workspaceId: "shared" }, false), false);
});

test("a recommendation hidden by Show fewer cannot keep an old Attention dialog", () => {
  const ref = { key: "rule-6", fingerprint: "same", workspaceId: "personal", taskId: "task-6" };
  const items = Array.from({ length: 6 }, (_, index) => ({
    attentionKey: `rule-${index + 1}`, sourceFingerprint: "same", subjectId: `task-${index + 1}`,
  }));
  const current = { workspaceId: "personal", items };
  assert.equal(attentionEvidenceIsVisible(ref, current, true), true);
  assert.equal(attentionEvidenceIsVisible(ref, current, false), false);
});
