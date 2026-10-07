import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-current-priorities-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");
const pact = await import("../lib/pact.ts");
const { buildCurrentPriorities } = await import("../lib/current-priorities.ts");

const now = Date.parse("2026-10-07T10:00:00Z");
const add = (entity) => store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)")
  .run(entity.id, JSON.stringify(entity), entity.updatedAt);
const entity = (id, type, properties = {}, extra = {}) => ({ id, type, title: id, status: type === "task" ? "open" : "active",
  workspaceId: "personal", properties, createdAt: now, updatedAt: now, ...extra });
if (!store.readSnapshot().entities.some((item) => item.type === "workspace" && item.workspaceId === "personal")) {
  add(entity("workspace:personal", "workspace", { kind: "personal" }, { title: "Personal" }));
}
add(entity("task:overdue", "task", { deadline: "2026-10-05" }));
add(entity("task:high", "task", { priority: "high" }));
add(entity("task:done", "task", { when: "2026-10-07" }, { status: "completed" }));
for (let index = 0; index < 12; index += 1) add(entity(`task:today-${index}`, "task", { when: "2026-10-07" }, { createdAt: now + index }));

test("current priorities rank overdue work first and list at most three tasks", () => {
  const result = buildCurrentPriorities("personal", now);
  assert.equal(result.localDate, "2026-10-07");
  assert.deepEqual(result.topTasks.map((task) => [task.id, task.reason]), [
    ["task:overdue", "po termínu"], ["task:today-0", "naplánováno na dnes"], ["task:today-1", "naplánováno na dnes"],
  ]);
  assert.equal(result.overdueCount, 1);
  assert.equal(result.topTasks.some((task) => task.id === "task:done"), false);
});

test("without a connected calendar no capacity or free-time conclusion is offered", () => {
  const { suggestions } = buildCurrentPriorities("personal", now);
  assert.equal(suggestions.some((text) => /zátěž|kapacit|volný blok|volného času/i.test(text)), false);
  assert.equal(suggestions.length, 1);
});

test("the read-only aggregate and unknown workspaces are rejected", () => {
  assert.throws(() => buildCurrentPriorities("all", now));
  assert.throws(() => buildCurrentPriorities("missing", now));
});

test("retired briefing agents are switched off and their rows are kept", () => {
  const database = store.getDatabase();
  pact.ensurePACTDefaults();
  database.prepare("INSERT OR REPLACE INTO pact_agents (id, payload, version, enabled, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
    .run("morning-planner", JSON.stringify({ id: "morning-planner", name: "Morning Planner", version: 1, tools: [], triggerModes: ["manual", "scheduled"] }), now, now);
  const listed = pact.listPACTAgents().map((agent) => agent.id);
  assert.equal(listed.includes("morning-planner"), false);
  assert.equal(listed.includes("evening-reviewer"), false);
  assert.deepEqual(listed.filter((id) => id !== "aifred").sort(), ["meeting-prep", "project-manager"]);
  assert.equal(database.prepare("SELECT enabled FROM pact_agents WHERE id = 'morning-planner'").get().enabled, 0);
  assert.equal(pact.getPACTAgent("morning-planner"), null);
});
