import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-attention-push-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import("../lib/server-store.ts");
const notifications = await import("../lib/notifications.ts");
const push = await import("../lib/attention-notifications.ts");

const TZ = "Europe/Prague";
const at = (iso) => Date.parse(iso);
const item = (id, ruleId, overrides = {}) => ({
  attentionKey: `personal|${ruleId}|v1|${id}|1`, workspaceId: "personal", subjectType: "task", subjectId: id, title: `Task ${id}`,
  ruleId, ruleVersion: 1, severity: ruleId === "deadline_overdue" ? 1 : 2, reasonCode: ruleId, reason: "", reasonFacts: { deadlineAllDay: true, thresholdHours: 48 },
  relevantAt: at("2026-10-05T22:00:00Z"), relevantDate: "2026-10-05", timezone: TZ, confidence: "confirmed", sourceIds: [id], sourceRevisions: { [id]: 1 },
  evaluatedDataRevision: 1, evaluatedAt: 0, ...overrides,
});
const plan = (overrides) => push.planAttentionPushes({ items: [], handledKeys: new Set(), sentInLast24h: 0, now: at("2026-10-07T10:00:00Z"), timezone: TZ, ...overrides });

test("only deadline rules are announced, overdue first, each item once", () => {
  const items = [item("soon", "deadline_soon"), item("project", "project_idle", { subjectType: "project", severity: 3 }),
    item("project-deadline", "deadline_overdue", { subjectType: "project" }), item("late", "deadline_overdue")];
  assert.deepEqual(plan({ items }).send.map((entry) => entry.subjectId), ["late", "soon"]);
  const handledKeys = new Set([push.attentionDeliveryKey(items[3])]);
  assert.deepEqual(plan({ items, handledKeys }).send.map((entry) => entry.subjectId), ["soon"]);
  assert.deepEqual(plan({ items: [] }), { send: [], held: null });
});

test("quiet hours follow the configured timezone and hold everything", () => {
  const items = [item("late", "deadline_overdue")];
  assert.equal(push.inQuietHours(at("2026-10-07T19:59:00Z"), TZ), false); // 21:59 in Prague
  assert.equal(push.inQuietHours(at("2026-10-07T20:00:00Z"), TZ), true);  // 22:00
  assert.equal(push.inQuietHours(at("2026-10-08T05:59:00Z"), TZ), true);  // 07:59
  assert.equal(push.inQuietHours(at("2026-10-08T06:00:00Z"), TZ), false); // 08:00
  assert.equal(push.inQuietHours(at("2026-01-15T06:30:00Z"), TZ), true);  // 07:30 in winter time
  assert.deepEqual(plan({ items, now: at("2026-10-07T21:00:00Z") }), { send: [], held: "quiet_hours" });
  assert.equal(plan({ items, now: at("2026-10-08T06:00:00Z") }).send.length, 1);
});

test("at most three a day; the rest wait", () => {
  const items = ["a", "b", "c", "d", "e"].map((id, index) => item(id, "deadline_overdue", { relevantAt: index }));
  const first = plan({ items });
  assert.deepEqual([first.send.map((entry) => entry.subjectId), first.held], [["a", "b", "c"], "daily_limit"]);
  assert.deepEqual(plan({ items, sentInLast24h: 2 }).send.map((entry) => entry.subjectId), ["a"]);
  assert.deepEqual(plan({ items, sentInLast24h: 3 }), { send: [], held: "daily_limit" });
});

test("the message carries a short title, the reason and a link to the task", () => {
  assert.deepEqual(push.attentionPushPayload(item("t1", "deadline_overdue", { title: "  Faktura   pro klienta " })),
    { title: "Faktura pro klienta", body: "Termín 5. 10. uplynul.", url: "/?task=t1", tag: "attention-t1" });
  const timed = push.attentionPushPayload(item("t 2", "deadline_soon", { reasonFacts: { deadlineAllDay: false, thresholdHours: 48 }, relevantAt: at("2026-10-08T13:30:00Z"), relevantDate: "2026-10-08" }));
  assert.equal(timed.body, "Termín 8. 10. 15:30 je do 48 hodin.");
  assert.equal(timed.url, "/?task=t%202");
  const long = push.attentionPushPayload(item("t3", "deadline_overdue", { title: "x".repeat(200) }));
  assert.equal(long.title.length, 80);
  assert.equal(long.title.endsWith("…"), true);
});

// ---- scheduler pass against a real (temporary) database, with the push sender replaced
const add = (entity) => store.getDatabase().prepare("INSERT OR REPLACE INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
const task = (id, deadline, extra = {}) => ({ id, type: "task", title: `Úkol ${id}`, status: "open", workspaceId: "personal", properties: { deadline }, createdAt: 1, updatedAt: 1, ...extra });
const deliveries = () => store.getDatabase().prepare("SELECT delivery_key, status FROM notification_deliveries WHERE delivery_key LIKE 'attention:%' ORDER BY delivery_key").all()
  .map((row) => `${row.status}:${row.delivery_key === "attention:baseline" ? "(marker)" : row.delivery_key.split(":").at(-2)}`);
const sender = (result = { sent: 1, failed: 0, total: 1 }) => { const calls = []; const send = async (payload) => { calls.push(payload); return result; }; return { calls, send }; };
const DAY10 = at("2026-10-07T08:00:00Z"); // 10:00 in Prague

test("first pass records a baseline and sends nothing; later items are sent once", async () => {
  if (!store.readSnapshot().entities.some((entity) => entity.type === "workspace")) add({ id: "workspace:personal", type: "workspace", title: "Personal", status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 });
  add(task("old", "2026-10-01"));
  const first = sender();
  assert.deepEqual(await push.processAttentionNotifications(DAY10, first.send), { state: "baseline", sent: 0 });
  assert.equal(first.calls.length, 0);
  add(task("new", "2026-10-06"));
  const second = sender();
  assert.deepEqual(await push.processAttentionNotifications(DAY10 + 60_000, second.send), { state: "sent", sent: 1 });
  assert.deepEqual(second.calls.map((call) => [call.title, call.body]), [["Úkol new", "Termín 6. 10. uplynul."]]);
  const third = sender();
  assert.equal((await push.processAttentionNotifications(DAY10 + 120_000, third.send)).sent, 0);
  assert.equal(third.calls.length, 0);
  assert.deepEqual(deliveries().sort(), ["baseline:(marker)", "baseline:old", "sent:new"]);
});

test("quiet hours defer the message to the morning and completed tasks are never announced", async () => {
  add(task("night", "2026-10-06"));
  add(task("done", "2026-10-06", { status: "completed" }));
  const night = sender();
  assert.deepEqual(await push.processAttentionNotifications(at("2026-10-07T21:30:00Z"), night.send), { state: "quiet_hours", sent: 0 });
  assert.equal(night.calls.length, 0);
  const morning = sender();
  assert.equal((await push.processAttentionNotifications(at("2026-10-08T06:05:00Z"), morning.send)).sent, 1);
  assert.deepEqual(morning.calls.map((call) => call.title), ["Úkol night"]);
});

test("no subscribed device is recorded as undelivered and not retried", async () => {
  add(task("nodevice", "2026-10-06"));
  const none = sender({ sent: 0, failed: 0, total: 0 });
  assert.equal((await push.processAttentionNotifications(at("2026-10-08T07:00:00Z"), none.send)).sent, 0);
  assert.equal(deliveries().includes("undelivered:nodevice"), true);
  const again = sender();
  await push.processAttentionNotifications(at("2026-10-08T07:10:00Z"), again.send);
  assert.equal(again.calls.length, 0);
});

test("turning the preference off stops sending and a later re-enable starts from a new baseline", async () => {
  notifications.saveNotificationPreferences({ attentionPush: false });
  add(task("while-off", "2026-10-06"));
  const off = sender();
  assert.deepEqual(await push.processAttentionNotifications(at("2026-10-09T08:00:00Z"), off.send), { state: "disabled", sent: 0 });
  notifications.saveNotificationPreferences({ attentionPush: true });
  const on = sender();
  assert.deepEqual(await push.processAttentionNotifications(at("2026-10-09T08:05:00Z"), on.send), { state: "baseline", sent: 0 });
  assert.equal(on.calls.length, 0);
  assert.equal(notifications.getNotificationPreferences().attentionPush, true);
});
