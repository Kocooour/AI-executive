import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-task-suggestions-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const { inferNewProjectSuggestion, suggestTask } = await import("../lib/task-suggestions.ts");

function add(entity) {
  store.getDatabase().prepare("INSERT OR REPLACE INTO entities (id,payload,updated_at) VALUES (?,?,?)")
    .run(entity.id, JSON.stringify(entity), entity.updatedAt);
}

test("project-like multi-step work proposes a new editable project", () => {
  const proposal = inferNewProjectSuggestion({
    title: "Naplánovat rekonstrukci koupelny včetně rozpočtu a dodavatele",
    existingProjectScore: 0,
    areaId: "area:home",
    areaTitle: "Dům",
    language: "cs",
  });
  assert.ok(proposal);
  assert.equal(proposal.title, "Rekonstrukci koupelny");
  assert.equal(proposal.areaId, "area:home");
  assert.equal(proposal.confidence, "high");
  assert.match(proposal.reason, /vícekrokový/);
});

test("ordinary single actions do not propose projects", () => {
  assert.equal(inferNewProjectSuggestion({
    title: "Koupit mléko",
    existingProjectScore: 0,
    language: "cs",
  }), null);
  assert.equal(inferNewProjectSuggestion({
    title: "Call Peter tomorrow",
    existingProjectScore: 0,
    language: "en",
  }), null);
  assert.equal(inferNewProjectSuggestion({
    title: "Naplánovat schůzku s Petrem",
    existingProjectScore: 0,
    language: "cs",
  }), null);
});

test("an explicit short duration is suggested without a ten-minute floor", () => {
  const result = suggestTask({ title: "Zavolat rodině 4 min", workspaceId: "personal", language: "cs" });
  assert.equal(result.estimatedMinutes, 4);
});

test("a relevant active project suppresses duplicate project proposals", () => {
  const now = Date.now();
  add({ id: "workspace:personal", type: "workspace", title: "Personal", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
  add({ id: "project:bathroom", type: "project", title: "Rekonstrukce koupelny", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
  const result = suggestTask({
    title: "Naplánovat rekonstrukci koupelny včetně rozpočtu",
    workspaceId: "personal",
    language: "cs",
  });
  assert.equal(result.projectId, "project:bathroom");
  assert.equal(result.newProjectSuggestion, null);
});

test("suggestTask carries the most likely area into a novel project proposal", () => {
  const now = Date.now();
  add({ id: "area:home", type: "area", title: "Dům", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
  const result = suggestTask({
    title: "Naplánovat projekt Dům bez bariér včetně rozpočtu",
    workspaceId: "personal",
    language: "cs",
  });
  assert.ok(result.newProjectSuggestion);
  assert.equal(result.newProjectSuggestion.areaId, "area:home");
  assert.equal(result.newProjectSuggestion.areaTitle, "Dům");
});
