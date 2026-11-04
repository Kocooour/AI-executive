import assert from "node:assert/strict";
import test from "node:test";

const { resolveLegacyRecordLink, legacyRecordBelongsToProject } = await import("../lib/legacy-record-deep-link.ts");

const records = [
  { id: "workspace:personal", type: "workspace", workspaceId: "personal" },
  { id: "workspace:shared", type: "workspace", workspaceId: "shared" },
  { id: "p", type: "project", workspaceId: "personal" },
  { id: "q", type: "project", workspaceId: "shared" },
  { id: "t", type: "task", workspaceId: "personal" },
  { id: "n", type: "note", workspaceId: "personal" },
  { id: "s", type: "note", workspaceId: "shared", properties: { projectId: "q" } },
  { id: "orphan", type: "task", workspaceId: "deleted" },
  { id: "p2", type: "project", workspaceId: "personal" },
  { id: "moved", type: "task", workspaceId: "personal", properties: { projectId: "p" } },
];
const relations = [
  { sourceEntityId: "t", targetEntityId: "p", workspaceId: "personal", relationType: "belongs_to_project" },
  { sourceEntityId: "n", targetEntityId: "p", workspaceId: "personal", relationType: "belongs_to_project" },
  { sourceEntityId: "moved", targetEntityId: "p2", workspaceId: "personal", relationType: "belongs_to_project" },
];
const task = (id, view = "Today", projectId) =>
  ({ kind: "task", id, view, ...(projectId === undefined ? {} : { projectId }) });
const note = (id, view = "Notes", projectId) =>
  ({ kind: "note", id, view, ...(projectId === undefined ? {} : { projectId }) });

test("direct task/note links select an existing legacy workspace or preserve aggregate all", () => {
  assert.deepEqual(resolveLegacyRecordLink(records, relations, task("t"), "shared"), {
    record: records[4], projectId: null, selectWorkspaceId: "personal",
  });
  assert.deepEqual(resolveLegacyRecordLink(records, relations, note("n"), "all"), {
    record: records[5], projectId: null, selectWorkspaceId: null,
  });
  assert.deepEqual(resolveLegacyRecordLink(records, relations, note("s"), "shared"), {
    record: records[6], projectId: null, selectWorkspaceId: null,
  });
});

test("project task/note route requires a real matching parent in the same workspace", () => {
  assert.deepEqual(resolveLegacyRecordLink(records, relations, task("t", "Projects", "p"), "personal"), {
    record: records[4], projectId: "p", selectWorkspaceId: null,
  });
  assert.deepEqual(resolveLegacyRecordLink(records, relations, note("n", "Projects", "p"), "shared"), {
    record: records[5], projectId: "p", selectWorkspaceId: "personal",
  });
  assert.deepEqual(resolveLegacyRecordLink(records, relations, note("s", "Projects", "q"), "personal"), {
    record: records[6], projectId: "q", selectWorkspaceId: "shared",
  });
});

test("missing, wrong type, orphan, unrelated and cross-workspace parent links fail closed", () => {
  const invalid = [
    task("missing"), note("t"), task("n"), task("orphan"),
    task("t", "Projects", "missing"),
    task("t", "Projects", "q"),
    note("n", "Projects", "q"),
    task("t", "Projects", "s"),
    task("t", "Today", "p"),
    note("n", "Notes", "p"),
  ];
  for (const target of invalid)
    assert.equal(resolveLegacyRecordLink(records, relations, target, "personal"), null, JSON.stringify(target));
  assert.equal(resolveLegacyRecordLink([], [], task("t"), "personal"), null);
  assert.equal(resolveLegacyRecordLink(records, relations, { kind: "project", id: "p" }, "personal"), null);
  assert.equal(resolveLegacyRecordLink(records, relations, null, "personal"), null);
});

test("a forged relation from a different workspace never satisfies project ancestry", () => {
  const forged = [{ sourceEntityId: "t", targetEntityId: "p",
    workspaceId: "shared", relationType: "belongs_to_project" }];
  assert.equal(resolveLegacyRecordLink(records, forged, task("t", "Projects", "p"), "personal"), null);
});

test("current project edges beat stale legacy projectId in both URL and inspector navigation", () => {
  const moved = records.find((row) => row.id === "moved");
  assert.ok(moved);
  assert.equal(legacyRecordBelongsToProject(moved, "p", relations), false);
  assert.equal(legacyRecordBelongsToProject(moved, "p2", relations), true);
  assert.equal(resolveLegacyRecordLink(records, relations, task("moved", "Projects", "p"), "personal"), null);
  assert.deepEqual(resolveLegacyRecordLink(records, relations, task("moved", "Projects", "p2"), "personal"), {
    record: moved, projectId: "p2", selectWorkspaceId: null,
  });
});

test("legacy property-only parent is accepted only with no project edges", () => {
  const note = records.find((row) => row.id === "s");
  assert.ok(note);
  assert.equal(legacyRecordBelongsToProject(note, "q", relations), true);
  const conflict = [{ sourceEntityId: "s", targetEntityId: "q", workspaceId: "personal", relationType: "belongs_to_project" }];
  assert.equal(legacyRecordBelongsToProject(note, "q", conflict), false);
  assert.equal(resolveLegacyRecordLink(records, conflict, { kind: "note", id: "s", view: "Projects", projectId: "q" }, "shared"), null);
  const duplicate = [relations[0], { ...relations[0] }];
  assert.equal(legacyRecordBelongsToProject(records[4], "p", duplicate), false);
});
