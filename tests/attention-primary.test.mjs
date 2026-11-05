import assert from "node:assert/strict";
import test from "node:test";

const { attentionPrimaryAction, attentionEvidenceIsVisible, attentionSubjectChangedSinceEvaluation } = await import("../lib/home-today.ts");

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

test("a synced task changed after evaluation invalidates that recommendation", () => {
  const evidenceAt = 1_000;
  assert.equal(attentionSubjectChangedSinceEvaluation({ updatedAt: 1_001 }, evidenceAt), true);
  assert.equal(attentionSubjectChangedSinceEvaluation({ updatedAt: 1_000 }, evidenceAt), false);
  assert.equal(attentionSubjectChangedSinceEvaluation({ updatedAt: 999 }, evidenceAt), false);
  assert.equal(attentionSubjectChangedSinceEvaluation(undefined, evidenceAt), false);
  // This is independent of sync status: stale evidence must not offer an edit.
  const changed = attentionSubjectChangedSinceEvaluation({ updatedAt: 1_001 }, evidenceAt);
  assert.equal(attentionPrimaryAction(overdue, openTask, true, changed), "open");
  // A modal opened before the task edit must also fail its evidence-time guard.
  const current = { workspaceId: "personal", items: [
    { attentionKey: "rule-1", sourceFingerprint: "same", subjectId: "task-1" },
  ] };
  const source = { key: "rule-1", fingerprint: "same", workspaceId: "personal", taskId: "task-1" };
  assert.equal(attentionEvidenceIsVisible(source, current, true), true);
  assert.equal(changed, true);
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
