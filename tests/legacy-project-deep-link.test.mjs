import assert from "node:assert/strict";
import test from "node:test";

const { resolveLegacyProjectLink } = await import("../lib/legacy-project-deep-link.ts");

const records = [
  { id: "workspace:personal", type: "workspace", workspaceId: "personal" },
  { id: "workspace:shared", type: "workspace", workspaceId: "shared" },
  { id: "personal-project", type: "project", workspaceId: "personal" },
  { id: "shared-project", type: "project", workspaceId: "shared" },
  { id: "same-id-task", type: "task", workspaceId: "personal" },
  { id: "orphan-project", type: "project", workspaceId: "deleted" },
];

test("legacy All work retains aggregate scope after a project deep-link reload", () => {
  assert.deepEqual(resolveLegacyProjectLink(records, "personal-project", "all"), {
    projectId: "personal-project", selectWorkspaceId: null,
  });
  assert.deepEqual(resolveLegacyProjectLink(records, "shared-project", "all"), {
    projectId: "shared-project", selectWorkspaceId: null,
  });
});

test("a deep link to a project in a different known legacy workspace selects that scope", () => {
  assert.deepEqual(resolveLegacyProjectLink(records, "shared-project", "personal"), {
    projectId: "shared-project", selectWorkspaceId: "shared",
  });
  assert.deepEqual(resolveLegacyProjectLink(records, "shared-project", "shared"), {
    projectId: "shared-project", selectWorkspaceId: null,
  });
});

test("an unknown, deleted, wrong-type or orphan target is never resolved", () => {
  assert.equal(resolveLegacyProjectLink(records, "deleted", "all"), null);
  assert.equal(resolveLegacyProjectLink(records, "same-id-task", "all"), null);
  assert.equal(resolveLegacyProjectLink(records, "orphan-project", "all"), null);
  assert.equal(resolveLegacyProjectLink([], "personal-project", "personal"), null);
});
