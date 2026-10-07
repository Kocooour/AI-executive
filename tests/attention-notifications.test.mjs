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
  const emoji = push.attentionPushPayload(item("t4", "deadline_overdue", { title: "a".repeat(78) + "😀😀😀" }));
  assert.equal(emoji.title, "a".repeat(78) + "😀…");
  assert.equal(push.attentionPushPayload(item("t5", "deadline_overdue", { title: "   " })).title, "");
});

test("the delivery identity does not depend on the configured timezone", () => {
  const prague = item("t1", "deadline_overdue", { attentionKey: "personal|deadline_overdue|v1|t1|1791324000000", relevantAt: 1791324000000 });
  const tokyo = { ...prague, attentionKey: "personal|deadline_overdue|v1|t1|1791298800000", relevantAt: 1791298800000, timezone: "Asia/Tokyo" };
  assert.equal(push.attentionDeliveryKey(prague), push.attentionDeliveryKey(tokyo));
  assert.notEqual(push.attentionDeliveryKey(prague), push.attentionDeliveryKey({ ...prague, relevantDate: "2026-10-06" }));
  assert.notEqual(push.attentionDeliveryKey(prague), push.attentionDeliveryKey({ ...prague, ruleId: "deadline_soon" }));
  const timed = item("t1", "deadline_soon", { reasonFacts: { deadlineAllDay: false, thresholdHours: 48 }, relevantAt: 5 });
  assert.notEqual(push.attentionDeliveryKey(timed), push.attentionDeliveryKey({ ...timed, relevantAt: 6 }));
});

// ---- scheduler pass against a real (temporary) database, with the push sender replaced
const add = (entity) => store.getDatabase().prepare("INSERT OR REPLACE INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
const task = (id, deadline, extra = {}) => ({ id, type: "task", title: `Úkol ${id}`, status: "open", workspaceId: "personal", properties: { deadline }, createdAt: 1, updatedAt: 1, ...extra });
const deliveries = () => store.getDatabase().prepare("SELECT delivery_key, status FROM notification_deliveries WHERE delivery_key LIKE 'attention:%' ORDER BY delivery_key").all()
  .map((row) => `${row.status}:${row.delivery_key === "attention:baseline" ? "(marker)" : row.delivery_key.split(":").at(-2)}`);
const statusOf = (id) => store.getDatabase().prepare("SELECT status, attempts, error FROM notification_deliveries WHERE entity_id = ? AND delivery_key LIKE 'attention:%' AND delivery_key NOT LIKE 'attention-device:%'").all(id).map((row) => `${row.status}/${row.attempts}/${row.error ?? ""}`);
// A fake push sender. `devices` maps a device name to a function returning "sent" | "gone" | "failed" (or throwing).
const sender = (devices = { phone: () => "sent" }) => {
  const calls = [];
  const send = { targets: () => Object.keys(devices), sendTo: async (target, payload) => { calls.push({ ...payload, target }); return devices[target](payload); } };
  return { calls, send };
};
const DAY10 = at("2026-10-07T08:00:00Z"); // 10:00 in Prague
// Forgets every earlier announcement and records the current tasks as known, so a test starts with an empty daily limit.
const freshBaseline = async (now) => {
  store.getDatabase().prepare("DELETE FROM notification_deliveries WHERE delivery_key LIKE 'attention%'").run();
  assert.deepEqual(await push.processAttentionNotifications(now, sender().send), { state: "baseline", sent: 0 });
};

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
  const none = sender({});
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

test("an item nobody received is retried on later passes, at most three attempts, and no push error text is stored", async () => {
  add(task("flaky", "2026-10-08"));
  const failing = sender({ phone: () => { throw new Error("boom https://push.example/SECRET"); } });
  for (let pass = 0; pass < 5; pass += 1) await push.processAttentionNotifications(at("2026-10-10T08:00:00Z") + pass * 300_000, failing.send);
  assert.equal(failing.calls.length, 3);
  assert.deepEqual(statusOf("flaky"), ["failed/3/Push failed on every device"]);
  assert.equal(JSON.stringify(store.getDatabase().prepare("SELECT * FROM notification_deliveries WHERE entity_id = 'flaky'").all()).includes("SECRET"), false);
  add(task("flaky2", "2026-10-08"));
  let attempt = 0;
  const recovering = sender({ phone: () => (attempt += 1) === 1 ? "failed" : "sent" });
  await push.processAttentionNotifications(at("2026-10-10T09:00:00Z"), recovering.send);
  assert.deepEqual(statusOf("flaky2"), ["failed/1/Push failed on every device"]);
  assert.equal((await push.processAttentionNotifications(at("2026-10-10T09:05:00Z"), recovering.send)).sent, 1);
  assert.deepEqual(statusOf("flaky2"), ["sent/2/"]);
});

test("changing the timezone does not announce known items again", async () => {
  add(task("tz", "2026-10-09"));
  const before = sender();
  await push.processAttentionNotifications(at("2026-10-11T08:00:00Z"), before.send);
  assert.deepEqual(before.calls.map((call) => call.title), ["Úkol tz"]);
  notifications.saveNotificationPreferences({ timezone: "Asia/Tokyo" });
  const after = sender();
  await push.processAttentionNotifications(at("2026-10-11T08:05:00Z"), after.send); // 17:05 in Tokyo
  assert.deepEqual(after.calls, []);
  notifications.saveNotificationPreferences({ timezone: "Europe/Prague" });
});

test("overlapping passes do not run twice and in-flight sends count toward the daily limit", async () => {
  for (const id of ["o1", "o2", "o3", "o4"]) add(task(id, "2026-10-10"));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const slow = { targets: () => ["phone"], sendTo: async (target, payload) => { calls.push(payload.title); await gate; return "sent"; } };
  const first = push.processAttentionNotifications(at("2026-10-13T08:00:00Z"), slow);
  assert.deepEqual(await push.processAttentionNotifications(at("2026-10-13T08:00:01Z"), slow), { state: "busy", sent: 0 });
  release();
  assert.deepEqual(await first, { state: "daily_limit", sent: 3 });
  assert.equal(calls.length, 3);
  const later = sender();
  assert.deepEqual(await push.processAttentionNotifications(at("2026-10-13T08:10:00Z"), later.send), { state: "daily_limit", sent: 0 });
  assert.equal((await push.processAttentionNotifications(at("2026-10-14T08:10:00Z"), later.send)).sent, 1);
});

test("a pass interrupted after claiming is closed as not delivered and not resent", async () => {
  add(task("crashed", "2026-10-12"));
  store.getDatabase().prepare("INSERT INTO notification_deliveries (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at) VALUES (?, ?, ?, 'pending', 1, ?)")
    .run("attention:personal:deadline_overdue:crashed:2026-10-12", "crashed", "2026-10-12", at("2026-10-15T08:00:00Z"));
  const next = sender();
  await push.processAttentionNotifications(at("2026-10-15T08:30:00Z"), next.send);
  assert.equal(next.calls.some((call) => call.title === "Úkol crashed"), false);
  assert.deepEqual(statusOf("crashed"), ["undelivered/1/Interrupted before sending"]);
});

test("when one device receives the message and another fails, only the failed device is retried", async () => {
  await freshBaseline(at("2026-10-16T07:55:00Z"));
  add(task("mixed", "2026-10-09"));
  let tabletAttempts = 0;
  const devices = sender({ phone: () => "sent", tablet: () => (tabletAttempts += 1) <= 2 ? "failed" : "sent" });
  const first = await push.processAttentionNotifications(at("2026-10-16T08:00:00Z"), devices.send);
  assert.deepEqual([first.sent, statusOf("mixed")], [1, ["partial/1/"]]);
  const second = await push.processAttentionNotifications(at("2026-10-16T08:05:00Z"), devices.send);
  assert.deepEqual([second.sent, statusOf("mixed")], [0, ["partial/1/"]]);
  await push.processAttentionNotifications(at("2026-10-16T08:10:00Z"), devices.send);
  assert.deepEqual(statusOf("mixed"), ["sent/1/"]);
  assert.deepEqual(devices.calls.filter((call) => call.title === "Úkol mixed").map((call) => call.target), ["phone", "tablet", "tablet", "tablet"]);
  await push.processAttentionNotifications(at("2026-10-16T08:15:00Z"), devices.send);
  assert.equal(devices.calls.filter((call) => call.title === "Úkol mixed").length, 4);
});

test("a device that keeps failing is given up after three attempts and one that is gone is not retried", async () => {
  await freshBaseline(at("2026-10-17T07:55:00Z"));
  add(task("stuck", "2026-10-09"));
  const devices = sender({ phone: () => "sent", tablet: () => "failed", old: () => "gone" });
  for (let pass = 0; pass < 5; pass += 1) await push.processAttentionNotifications(at("2026-10-17T08:00:00Z") + pass * 300_000, devices.send);
  assert.deepEqual(statusOf("stuck"), ["sent/1/"]);
  const targets = devices.calls.filter((call) => call.title === "Úkol stuck").map((call) => call.target);
  assert.deepEqual([targets.filter((t) => t === "phone").length, targets.filter((t) => t === "tablet").length, targets.filter((t) => t === "old").length], [1, 3, 1]);
});

test("finishing a partial delivery waits for the morning and does not use the daily limit", async () => {
  await freshBaseline(at("2026-10-18T19:45:00Z"));
  add(task("late-retry", "2026-10-09"));
  let tablet = "failed";
  const devices = sender({ phone: () => "sent", tablet: () => tablet });
  await push.processAttentionNotifications(at("2026-10-18T19:50:00Z"), devices.send); // 21:50 in Prague
  tablet = "sent";
  await push.processAttentionNotifications(at("2026-10-18T20:30:00Z"), devices.send); // 22:30, quiet
  assert.deepEqual(statusOf("late-retry"), ["partial/1/"]);
  await push.processAttentionNotifications(at("2026-10-19T06:05:00Z"), devices.send); // 08:05
  assert.deepEqual(statusOf("late-retry"), ["sent/1/"]);
});
