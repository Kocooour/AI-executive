import assert from "node:assert/strict";
import test from "node:test";
import { projectAreaPreviewTone, projectPreviewSummary, projectPreviewTone } from "../lib/project-list-preview.ts";

const project = (status = "active") => ({ status });
const summary = (overrides = {}) => ({
  total: 7, done: 2, open: 5, overdue: 0, projectOverdue: false, next: null,
  attention: null, lastActivityAt: 0, lastActivityFromLinked: false, ...overrides,
});

test("area tones are visual-only, consistent for known areas and stable through reorder", () => {
  assert.equal(projectAreaPreviewTone({ id: "a", title: "Osobní" }), "personal");
  assert.equal(projectAreaPreviewTone({ id: "b", title: "Práce" }), "work");
  assert.equal(projectAreaPreviewTone({ id: "c", title: "Rodina" }), "family");
  assert.equal(projectAreaPreviewTone({ id: "d", title: "FAMILY" }), "family");
  assert.equal(projectAreaPreviewTone(null), "none");
  const area = { id: "stable-unknown-area", title: "Sport" };
  assert.equal(projectAreaPreviewTone(area), projectAreaPreviewTone({ ...area }));
  assert.match(projectAreaPreviewTone(area), /^extra-[abc]$/);
});

test("circular project state is empty unless explicitly completed; attention means outline only", () => {
  const ordinary = summary({ next: { title: "Call team" } });
  assert.equal(projectPreviewTone(project(), ordinary), "plain");
  assert.equal(projectPreviewTone(project(), summary({ attention: { kind: "noNext" } })), "warning");
  assert.equal(projectPreviewTone(project(), summary({ attention: { kind: "overdue", count: 2 } })), "danger");
  assert.equal(projectPreviewTone(project(), summary({ projectOverdue: true, next: { title: "Next" } })), "danger");
  assert.equal(projectPreviewTone(project("completed"), summary({ projectOverdue: true })), "complete");
});

test("project row shows only one issue or next action, never progress or counts", () => {
  const active = project();
  assert.equal(projectPreviewSummary(active, summary({ next: { title: "Review contract" } }), "en"), "Next step: Review contract");
  assert.equal(projectPreviewSummary(active, summary({ next: { title: "Zavolat" } }), "cs"), "Další krok: Zavolat");
  assert.equal(projectPreviewSummary(active, summary({
    next: { title: "Call team" }, attention: { kind: "overdue", count: 4 },
  }), "en"), "Overdue");
  assert.equal(projectPreviewSummary(active, summary({ projectOverdue: true, next: { title: "Call team" } }), "cs"), "Po termínu");
  assert.equal(projectPreviewSummary(active, summary({ attention: { kind: "noNext" } }), "en"), "Next step needed");
  assert.equal(projectPreviewSummary(active, summary(), "cs"), null);
  assert.equal(projectPreviewSummary(project("completed"), summary({ attention: { kind: "overdue", count: 2 } }), "cs"), null);
});
