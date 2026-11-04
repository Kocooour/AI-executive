import assert from "node:assert/strict";
import test from "node:test";
import { taskPreviewCanToggle } from "../lib/task-detail-preview.ts";

test("mobile task completion is limited to active concrete legacy workspace and a valid status", () => {
  const task = { type: "task", status: "open", workspaceId: "personal" };
  assert.equal(taskPreviewCanToggle(task, "personal", false), true);
  assert.equal(taskPreviewCanToggle({ ...task, status: "completed" }, "personal", false), true);
  assert.equal(taskPreviewCanToggle(task, "all", false), false);
  assert.equal(taskPreviewCanToggle(task, "shared", false), false);
  assert.equal(taskPreviewCanToggle(task, "personal", true), false);
  assert.equal(taskPreviewCanToggle({ ...task, status: "archived" }, "personal", false), false);
  assert.equal(taskPreviewCanToggle({ ...task, type: "project" }, "personal", false), false);
  assert.equal(taskPreviewCanToggle(null, "personal", false), false);
});
