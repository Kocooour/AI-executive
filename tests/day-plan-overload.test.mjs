import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-day-plan-overload-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");
const plan = await import("../lib/day-plan.ts");

const now = Date.now();
const today = plan.currentDayPlanDate(now);
for (let index = 0; index < 12; index += 1) {
  const entity = { id: `task:${index}`, type: "task", title: `Task ${index}`, status: "open", workspaceId: "personal",
    properties: { when: today, estimatedMinutes: 120 }, createdAt: now + index, updatedAt: now + index };
  store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
}

test("without a connected calendar the day plan orders tasks but draws no capacity conclusion", () => {
  const result = plan.buildDayPlan("personal", today, now);
  assert.notEqual(result.calendar, "ready");
  assert.equal(result.freeMinutes, null);
  assert.equal(result.planBlocks.length, 0);
  assert.equal(result.unscheduled.length, 12);
  assert.equal(result.requiredMinutes, 12 * 120);
  assert.equal(result.overloaded, false);
});
