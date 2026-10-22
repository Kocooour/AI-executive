import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-day-plan-reasons-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");
const plan = await import("../lib/day-plan.ts");
const { taskDueSummary } = await import("../app/ui/format.ts");

const now = Date.now();
const today = plan.currentDayPlanDate(now);
const shift = (days) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const add = (id, properties) => {
  const entity = { id, type: "task", title: id, status: "open", workspaceId: "personal", properties: { estimatedMinutes: 20, ...properties }, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(id, JSON.stringify(entity), now);
};
add("t:deadline-passed", { deadline: shift(-2) });
add("t:planned-passed", { when: shift(-2) });
add("t:planned-passed-deadline-later", { when: shift(-2), deadline: shift(5) });
add("t:both-passed", { when: shift(-3), deadline: shift(-1) });
add("t:deadline-today", { deadline: today });
add("t:planned-today", { when: today });
add("t:planned-today-deadline-tomorrow", { when: today, deadline: shift(1) });
add("t:flag-today", { today: true });
add("t:planned-passed-deadline-today", { when: shift(-2), deadline: today });
add("t:planned-passed-deadline-soon", { when: shift(-2), deadline: shift(1) });

const find = (id) => { const r = plan.buildDayPlan("personal", today, now); return [...r.planBlocks, ...r.unscheduled].find((x) => x.taskId === id); };

test("a passed deadline is overdue; a passed planned day is labelled planned", () => {
  assert.equal(find("t:deadline-passed").reason, "overdue");
  assert.equal(find("t:deadline-passed").whyNow[0], "overdue");
  assert.equal(find("t:both-passed").reason, "overdue");
  for (const id of ["t:planned-passed", "t:planned-passed-deadline-later"]) {
    assert.equal(find(id).reason, "planned");
    assert.equal(find(id).whyNow[0], "planned_passed");
    assert.equal(find(id).whyNow.includes("overdue"), false);
  }
});

test("only a deadline today says due today; a planned day says planned today", () => {
  assert.equal(find("t:deadline-today").reason, "today");
  assert.equal(find("t:deadline-today").whyNow[0], "due_today");
  for (const id of ["t:planned-today", "t:planned-today-deadline-tomorrow"]) {
    assert.equal(find(id).reason, "today");
    assert.equal(find(id).whyNow[0], "planned_today");
  }
  assert.equal(find("t:flag-today").reason, "today");
  assert.equal(find("t:flag-today").whyNow[0], "flagged_today");
  assert.ok(find("t:planned-today-deadline-tomorrow").whyNow.includes("deadline_close"));
});

test("a deadline today outranks a passed planned day in the label", () => {
  assert.equal(find("t:planned-passed-deadline-today").reason, "today");
  assert.equal(find("t:planned-passed-deadline-today").whyNow[0], "due_today");
  assert.ok(find("t:planned-passed-deadline-soon").whyNow.includes("deadline_close"));
});

test("ordering is unchanged: planned-passed ranks with the former overdue score", () => {
  const r = plan.buildDayPlan("personal", today, now);
  const order = r.unscheduled.map((x) => x.taskId);
  assert.ok(order.indexOf("t:planned-passed") < order.indexOf("t:deadline-today"));
});

const row = (properties) => ({ id: "x", type: "task", title: "x", status: "open", workspaceId: "personal", properties, createdAt: 1, updatedAt: 1 });
test("taskDueSummary separates deadline from planned day", () => {
  const T = "2026-10-22";
  const NOW = new Date(2026, 9, 22, 10);
  assert.match(taskDueSummary(row({ deadline: "2026-10-19" }), T, "cs", NOW), /^Po termínu · /);
  assert.match(taskDueSummary(row({ when: "2026-10-01", deadline: "2026-10-19" }), T, "cs", NOW), /^Po termínu · /);
  assert.match(taskDueSummary(row({ deadline: "2026-10-23" }), T, "cs", NOW), /^Termín se blíží · /);
  assert.match(taskDueSummary(row({ deadline: T }), T, "en", NOW), /^Due soon · /);
  assert.match(taskDueSummary(row({ when: "2026-10-19" }), T, "cs", NOW), /^Plánováno na /);
  assert.match(taskDueSummary(row({ when: "2026-10-19" }), T, "en", NOW), /^Planned for /);
  assert.match(taskDueSummary(row({ when: "2026-10-01", deadline: "2026-10-30" }), T, "cs", NOW), /^Plánováno na /);
  assert.equal(taskDueSummary(row({ when: T }), T, "cs", NOW), "");
  assert.equal(taskDueSummary(row({ when: "2026-10-23" }), T, "cs", NOW), "");
  assert.equal(taskDueSummary(row({}), T, "cs", NOW), "");
});
