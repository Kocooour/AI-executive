import assert from "node:assert/strict";
import test from "node:test";

const { targetFromSearch, searchForTarget } = await import("../lib/view-url.ts");
const views = ["Home", "Inbox", "Today", "Upcoming", "Projects", "Notes", "Settings"];

test("view, project, task and note targets encode to stable typed URLs", () => {
  const targets = [
    { kind: "view", view: "Today" },
    { kind: "project", id: "project:α +/%" },
    { kind: "task", id: "task-17", view: "Today" },
    { kind: "task", id: "task/17", view: "Projects", projectId: "project:α" },
    { kind: "note", id: "note-17", view: "Notes" },
    { kind: "note", id: "note-17", view: "Projects", projectId: "project:α" },
  ];
  for (const target of targets) {
    assert.deepEqual(targetFromSearch(searchForTarget(target, "Home"), views, "Home"), target);
  }
  assert.equal(searchForTarget({ kind: "view", view: "Home" }, "Home"), "");
  assert.equal(searchForTarget({ kind: "project", id: "p" }, "Home"), "?view=Projects&projectId=p");
});

test("direct project links retain target independent of history.state or session", () => {
  const url = "?view=Projects&projectId=p-opaque";
  assert.deepEqual(targetFromSearch(url, views, "Home"), { kind: "project", id: "p-opaque" });
  assert.deepEqual(targetFromSearch("?view=Projects", views, "Home"), { kind: "view", view: "Projects" });
  assert.deepEqual(targetFromSearch("", views, "Home"), { kind: "view", view: "Home" });
  assert.deepEqual(targetFromSearch("", views, "Inbox"), { kind: "view", view: "Inbox" });
});

test("ambiguous, forged, malformed and unexpected URL parameters do not choose a record", () => {
  const bad = [
    "?view=Projects&projectId=p&projectId=q",
    "?view=Today&projectId=p",
    "?view=Projects&projectId=",
    "?view=Projects&projectId=p&noteId=n&taskId=t",
    "?view=Projects&projectId=p&workspaceId=other",
    "?view=Projects&projectId=p&unknown=1",
    "?view=Projects&view=Home&projectId=p",
    "?view=Missing",
    "?view=Today&noteId=n&taskId=t",
    "?view=Projects&projectId=%00",
    "?view=Projects&projectId=" + "a".repeat(257),
    "?task=legacy-notification", // handled by the independent legacy notification entry point
  ];
  for (const url of bad) assert.equal(targetFromSearch(url, views, "Home"), null, url);
});

test("task/notes cannot claim a parent project outside the Projects view", () => {
  assert.equal(targetFromSearch("?view=Today&projectId=p&taskId=t", views, "Home"), null);
  assert.equal(targetFromSearch("?view=Notes&projectId=p&noteId=n", views, "Home"), null);
  assert.deepEqual(targetFromSearch("?view=Projects&projectId=p&noteId=n", views, "Home"), {
    kind: "note", id: "n", view: "Projects", projectId: "p",
  });
});
