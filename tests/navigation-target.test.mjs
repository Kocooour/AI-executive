import assert from "node:assert/strict";
import test from "node:test";

const { targetFromSearch, searchForTarget, viewExitFromProject } = await import("../lib/view-url.ts");
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



test("the Projects list URL is always the list, regardless of stale history state", () => {
  const priorHistoryState = { lumiProject: "prior-project" };
  assert.equal(priorHistoryState.lumiProject, "prior-project");
  assert.deepEqual(targetFromSearch("?view=Projects", views, "Home"), { kind: "view", view: "Projects" });
  assert.equal(targetFromSearch("?view=Projects&projectId=linked", views, "Home")?.kind, "project");
  assert.equal(targetFromSearch("?view=Projects&projectId=x&unknown=1", views, "Home"), null);
});

test("an explicit view choice from a project pushes a new step, Back restores the project", () => {
  const projectUrl = searchForTarget({ kind: "project", id: "p" }, "Home");
  const homeUrl = searchForTarget({ kind: "view", view: "Home" }, "Home");
  const history = [homeUrl, projectUrl];
  let index = history.length - 1;
  for (const destination of ["Home", "Projects"]) {
    const transition = viewExitFromProject({
      currentSearch: history[index],
      currentProjectId: "p",
      nextView: destination,
      knownViews: views,
      startView: "Home",
    });
    assert.deepEqual(transition, { search: destination === "Home" ? "" : "?view=Projects", mode: "push" });
    history.splice(index + 1, Infinity, transition.search);
    index++;
    assert.equal(history[--index], projectUrl, "browser Back still reaches the project");
    assert.equal(history[++index], transition.search, "browser Forward reaches the chosen view");
    index--; // Return to the project before trying another choice.
  }
  assert.equal(viewExitFromProject({
    currentSearch: "?view=Projects", currentProjectId: "p", nextView: "Home", knownViews: views, startView: "Home",
  }), null);
  assert.equal(viewExitFromProject({
    currentSearch: projectUrl, currentProjectId: "someone-else", nextView: "Home", knownViews: views, startView: "Home",
  }), null);
});
