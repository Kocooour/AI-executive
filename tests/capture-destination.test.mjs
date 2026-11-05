import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDestinationKey, captureNeedsShareConsent, initialCaptureWorkspace,
} from "../lib/capture-destination.ts";

test("UI-08a: standalone quick capture starts private even if another workspace is selected", () => {
  assert.equal(initialCaptureWorkspace(null, "personal"), "personal");
  assert.equal(initialCaptureWorkspace("", "personal"), "personal");
  assert.equal(initialCaptureWorkspace("shared-family", "personal"), "shared-family");
});

test("UI-08a: every non-personal destination needs explicit shared consent", () => {
  assert.equal(captureNeedsShareConsent("personal", "personal"), false);
  assert.equal(captureNeedsShareConsent("shared-family", "personal"), true);
  assert.equal(captureNeedsShareConsent("deleted-workspace", "personal"), true);
});

test("UI-08a: a consent is bound to exact type, workspace, project, area and action", () => {
  const target = {
    type: "task", workspaceId: "shared-family", projectId: "project:1",
    areaId: "", projectAction: "existing",
  };
  const key = captureDestinationKey(target);
  assert.equal(key, captureDestinationKey({ ...target }));
  for (const other of [
    { ...target, type: "note" },
    { ...target, workspaceId: "shared-work" },
    { ...target, projectId: "project:2" },
    { ...target, areaId: "area:2" },
    { ...target, projectAction: "none" },
  ]) {
    assert.notEqual(key, captureDestinationKey(other));
  }
});

test("UI-08a: an accepted suggested new project has a distinct consent target", () => {
  const base = { type: "task", workspaceId: "shared-family" };
  assert.notEqual(
    captureDestinationKey({ ...base, projectAction: "new" }),
    captureDestinationKey({ ...base, projectAction: "none" }),
  );
});
