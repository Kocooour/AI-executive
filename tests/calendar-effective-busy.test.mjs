import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

// The server's busy time (day plan, availability) ignores events the owner hid and events that became tasks.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-effective-busy-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_SESSION_SECRET = randomBytes(48).toString("base64");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const calendar = await import("../lib/calendar.ts");

const db = () => store.getDatabase();
const date = "2026-10-26";
const now = Date.now();
db().prepare(`INSERT INTO calendar_sources (id, workspace_id, provider, label, encrypted_url, status, last_sync_at, last_success_at, event_count, revision, created_at, updated_at)
  VALUES ('src','personal','ics','x','x','ready',?,?,3,1,?,?)`).run(now, now, now, now);
const addEvent = (id, uid, start, end) => {
  const occurrenceKey = `${uid}:${start}`;
  const event = { id, sourceId: "src", workspaceId: "personal", uid, occurrenceKey, title: id, start, end, allDay: false, timezone: "UTC", status: "confirmed", transparency: "OPAQUE", busy: true, private: false };
  db().prepare("INSERT INTO calendar_events (id, source_id, workspace_id, occurrence_key, payload, start_at, end_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, "src", "personal", occurrenceKey, JSON.stringify(event), Date.parse(start), Date.parse(end), now);
  return event;
};
const plain = addEvent("plain", "u1", `${date}T09:00:00.000Z`, `${date}T10:00:00.000Z`);
const hidden = addEvent("hidden", "u2", `${date}T11:00:00.000Z`, `${date}T12:00:00.000Z`);
const converted = addEvent("converted", "u3", `${date}T13:00:00.000Z`, `${date}T15:00:00.000Z`);
const free = () => calendar.calendarAvailability("personal", date, "UTC", "08:00", "18:00").freeHours;

test("all events are busy until the owner decides", () => {
  assert.equal(free(), 10 - 1 - 1 - 2);
});

test("a hidden event and an event that became a task stop occupying time", () => {
  const snapshot = store.readSnapshot();
  const workspace = snapshot.entities.find((entity) => entity.id === "workspace:personal");
  const withDecision = { ...workspace, updatedAt: workspace.updatedAt + 1, properties: { ...workspace.properties, calendarDecisions: { [`occ:src:${hidden.occurrenceKey}`]: "hidden", [`occ:src:${plain.occurrenceKey}`]: "notTask" } } };
  const task = { id: "task-1", type: "task", title: "Converted", status: "open", workspaceId: "personal", properties: { calendarEventId: converted.id, estimatedMinutes: 120 }, createdAt: now, updatedAt: now };
  const result = store.replaceSnapshot(snapshot.revision, [...snapshot.entities.filter((entity) => entity.id !== workspace.id), withDecision, task], snapshot.relations, [], [], snapshot.restoreGeneration);
  assert.equal(result.conflict, false);
  // Only the "not a task" event still occupies its hour.
  assert.equal(free(), 10 - 1);
  assert.deepEqual(calendar.effectiveBusyEventsFor("personal", [plain, hidden, converted]).map((event) => event.id), ["plain"]);
});
