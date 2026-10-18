import assert from "node:assert/strict";
import test from "node:test";
const { taskRowValue } = await import("../app/ui/task-row-value.ts");
const day = "2026-10-18";
const record = (type = "task", props = {}, extra = {}) => ({
  id: "1", type, status: "open", workspaceId: "personal", title: "Example",
  properties: props, createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 10, 12), ...extra,
});
const value = (entity, options = {}) => taskRowValue(entity, "cs", day, { held: false, unsent: false, openTaskCount: 0, ...options });

test("pending and held-back states replace ordinary metadata", () => {
  const entity = record("task", { deadline: "2026-10-10" });
  assert.deepEqual(value(entity, { unsent: true }), { text: "čeká na odeslání", kind: "sync", tone: "warning" });
  assert.deepEqual(value(entity, { held: true, unsent: true }), { text: "Nejde uložit", kind: "sync", tone: "warning" });
});
test("overdue and future dates outrank estimates, with red only for overdue", () => {
  assert.equal(value(record("task", { when: "2026-10-21", deadline: "2026-10-10", estimatedMinutes: 50 })).tone, "danger");
  assert.equal(value(record("task", { when: "2026-10-21", estimatedMinutes: 50 })).kind, "date");
  assert.equal(value(record("task", { estimatedMinutes: 50 })).text, "50 min");
  assert.equal(value(record("task", { deadline: "2026-10-01" }, { status: "completed" })).tone, "default");
  assert.equal(value(record("task", { waiting: true, estimatedMinutes: 50 })).kind, "state");
});
test("projects show open-task count; notes show update date; empty areas stay silent", () => {
  assert.equal(value(record("project"), { openTaskCount: 1 }).text, "1 úkol");
  assert.equal(value(record("project"), { openTaskCount: 3 }).text, "3 úkoly");
  assert.equal(value(record("project"), { openTaskCount: 8 }).text, "8 úkolů");
  assert.equal(value(record("area")).kind, "none");
  assert.equal(value(record("note")).kind, "date");
});
