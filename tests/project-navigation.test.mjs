import assert from "node:assert/strict";
import test from "node:test";

const { activeSidebarProjects, groupProjectsByArea, projectsNeedAttention } = await import("../lib/project-navigation.ts");

const entity = (id, type, overrides = {}) => ({
  id, type, title: id, status: type === "task" ? "open" : "active", workspaceId: "personal", properties: {}, createdAt: 1000, updatedAt: 1000, ...overrides,
});
const relation = (id, sourceEntityId, targetEntityId, relationType, workspaceId = "personal") => ({
  id, sourceEntityId, targetEntityId, relationType, workspaceId, createdAt: 1,
});
const TODAY = "2026-10-22";

test("sidebar projects: active, current workspace, manual order, at most seven; none in the aggregate", () => {
  const projects = Array.from({ length: 9 }, (_, index) => entity(`p${index}`, "project", { createdAt: 1000 + index }));
  projects[0].properties = { manualOrders: { "personal:project:all": 5000 } };
  projects.push(entity("done", "project", { status: "completed", createdAt: 1 }), entity("other", "project", { workspaceId: "work", createdAt: 1 }));
  const shown = activeSidebarProjects(projects, "personal");
  assert.deepEqual(shown.map((project) => project.id), ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  assert.deepEqual(activeSidebarProjects(projects, "work").map((project) => project.id), ["other"]);
  assert.deepEqual(activeSidebarProjects(projects, "all"), []);
});

test("Projects dot: a passed deadline or no open task, only for active projects", () => {
  const p = entity("p", "project");
  const link = relation("r", "t", "p", "belongs_to_project");
  const task = (properties = {}, overrides = {}) => entity("t", "task", { properties, ...overrides });
  // healthy: one open task, deadline today or later, or no deadline
  assert.equal(projectsNeedAttention([task()], [p], [link], TODAY), false);
  assert.equal(projectsNeedAttention([task({ deadline: TODAY })], [p], [link], TODAY), false);
  assert.equal(projectsNeedAttention([task({ deadline: "2026-10-30" })], [p], [link], TODAY), false);
  // a planned day in the past is not a deadline
  assert.equal(projectsNeedAttention([task({ when: "2026-10-01" })], [p], [link], TODAY), false);
  // passed deadline
  assert.equal(projectsNeedAttention([task({ deadline: "2026-10-21" })], [p], [link], TODAY), true);
  // an empty deadline is not "earlier than today"
  assert.equal(projectsNeedAttention([task({ deadline: "" })], [p], [link], TODAY), false);
  // no open task: none at all, only completed ones, or a relation across workspaces
  assert.equal(projectsNeedAttention([], [p], [], TODAY), true);
  assert.equal(projectsNeedAttention([task({}, { status: "completed" })], [p], [link], TODAY), true);
  assert.equal(projectsNeedAttention([task({}, { workspaceId: "work" })], [p], [relation("r", "t", "p", "belongs_to_project", "work")], TODAY), true);
  // other relation types do not make a task a project step
  assert.equal(projectsNeedAttention([task()], [p], [relation("r", "t", "p", "belongs_to_area")], TODAY), true);
  // inactive projects and no projects never ask for attention
  assert.equal(projectsNeedAttention([], [entity("p", "project", { status: "completed" })], [], TODAY), false);
  assert.equal(projectsNeedAttention([], [], [], TODAY), false);
  // one needy project among healthy ones is enough
  const ok = entity("ok", "project");
  assert.equal(projectsNeedAttention([task()], [ok, p], [relation("r", "t", "ok", "belongs_to_project")], TODAY), true);
});

test("project groups: areas in manual order, then projects without an area, each group in project order", () => {
  const areas = [entity("work", "area", { createdAt: 10 }), entity("home", "area", { createdAt: 20 }), entity("empty", "area", { createdAt: 30 })];
  const projects = [
    entity("a", "project", { createdAt: 1 }), entity("b", "project", { createdAt: 2 }), entity("c", "project", { createdAt: 3 }),
    entity("d", "project", { createdAt: 4 }), entity("e", "project", { createdAt: 5, workspaceId: "work" }),
  ];
  const relations = [
    relation("1", "a", "home", "belongs_to_area"),
    relation("2", "b", "work", "belongs_to_area"),
    relation("3", "c", "work", "belongs_to_area"),
    relation("4", "c", "home", "belongs_to_area"), // the first area in order wins
    relation("5", "e", "work", "belongs_to_area", "work"), // area of another workspace: not applicable
    relation("6", "d", "missing", "belongs_to_area"),
  ];
  const groups = groupProjectsByArea(projects, areas, relations);
  assert.deepEqual(groups.map((group) => [group.area?.id ?? null, group.projects.map((project) => project.id)]),
    [["work", ["b", "c"]], ["home", ["a"]], [null, ["d", "e"]]]);
  areas[0].properties = { manualOrders: { "personal:area:all": 9999 } };
  assert.deepEqual(groupProjectsByArea(projects, areas, relations).map((group) => group.area?.id ?? null), ["home", "work", null]);
  assert.deepEqual(groupProjectsByArea([], areas, relations), []);
});

test("project groups: a cross-workspace relation cannot shadow a valid area; keys cannot collide with an area id", () => {
  const areas = [entity("a-first", "area", { createdAt: 10, workspaceId: "work" }), entity("none", "area", { createdAt: 20 })];
  const projects = [entity("p", "project"), entity("q", "project", { createdAt: 2 })];
  const relations = [
    // The lower-ranked area is in another workspace: ignored, so the valid area "none" is used.
    relation("1", "p", "a-first", "belongs_to_area"),
    relation("2", "p", "none", "belongs_to_area"),
    // A relation recorded in another workspace than the project's is ignored too.
    relation("3", "q", "none", "belongs_to_area", "work"),
  ];
  const groups = groupProjectsByArea(projects, areas, relations);
  assert.deepEqual(groups.map((group) => [group.area?.id ?? null, group.projects.map((project) => project.id)]), [["none", ["p"]], [null, ["q"]]]);
  assert.equal(new Set(groups.map((group) => group.key)).size, 2);
  assert.equal(groups[0].key, "area:none");
  assert.equal(groups[1].key, "loose");
});
