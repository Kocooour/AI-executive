import type { AttentionItem } from "./attention";
import { activeWorkspaces, reconcileWorkspace, withAttentionTransaction } from "./attention-service";
import { getNotificationPreferences, listPushTargets, sendPushToTarget, type PushTargetResult } from "./notifications";
import { getDatabase, readSnapshot } from "./server-store";

// Proactive push for attention items: one message when a task's deadline newly becomes "soon" or
// overdue. Only tasks are announced, never projects (owner decision 2026-10-07). It never writes to tasks, respects snooze and dismiss, and stays silent during quiet hours.

export const ATTENTION_PUSH_RULES = ["deadline_overdue", "deadline_soon"] as const;
export const ATTENTION_PUSH_QUIET_START = "22:00";
export const ATTENTION_PUSH_QUIET_END = "08:00";
export const ATTENTION_PUSH_DAILY_LIMIT = 3;
const DAY = 24 * 3_600_000;
const BASELINE_KEY = "attention:baseline";
const MAX_ATTEMPTS = 3;
const STALE_PENDING_MS = 15 * 60_000;
let passRunning = false;

const announceable = (item: AttentionItem) =>
  item.subjectType === "task" && (ATTENTION_PUSH_RULES as readonly string[]).includes(item.ruleId);

// Identity of one announcement. It must not depend on the configured timezone: the attention key of an
// all-day deadline contains the end of the local day, which moves when the timezone preference changes.
export const attentionDeliveryKey = (item: Pick<AttentionItem, "workspaceId" | "ruleId" | "subjectId" | "relevantAt" | "relevantDate" | "reasonFacts">) =>
  `attention:${item.workspaceId}:${item.ruleId}:${item.subjectId}:${item.reasonFacts.deadlineAllDay ? item.relevantDate : item.relevantAt}`;

function localTime(now: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

export function inQuietHours(now: number, timezone: string, start = ATTENTION_PUSH_QUIET_START, end = ATTENTION_PUSH_QUIET_END) {
  const time = localTime(now, timezone);
  return start <= end ? time >= start && time < end : time >= start || time < end;
}

// Pure decision: which of the currently visible items to announce now.
export function planAttentionPushes(input: {
  items: AttentionItem[];
  handledKeys: ReadonlySet<string>;
  sentInLast24h: number;
  now: number;
  timezone: string;
  dailyLimit?: number;
}): { send: AttentionItem[]; held: "quiet_hours" | "daily_limit" | null } {
  const pending = input.items
    .filter((item) => announceable(item) && !input.handledKeys.has(attentionDeliveryKey(item)))
    .sort((a, b) => a.severity - b.severity || a.relevantAt - b.relevantAt || (a.attentionKey < b.attentionKey ? -1 : a.attentionKey > b.attentionKey ? 1 : 0));
  if (!pending.length) return { send: [], held: null };
  if (inQuietHours(input.now, input.timezone)) return { send: [], held: "quiet_hours" };
  const room = Math.max(0, (input.dailyLimit ?? ATTENTION_PUSH_DAILY_LIMIT) - input.sentInLast24h);
  return { send: pending.slice(0, room), held: pending.length > room ? "daily_limit" : null };
}

export function attentionPushPayload(item: AttentionItem) {
  const when = item.reasonFacts.deadlineAllDay
    ? new Intl.DateTimeFormat("cs-CZ", { timeZone: "UTC", day: "numeric", month: "numeric" }).format(new Date(`${item.relevantDate}T12:00:00Z`))
    : new Intl.DateTimeFormat("cs-CZ", { timeZone: item.timezone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.relevantAt));
  // Owner decision 2026-10-07: a short title and the reason are shown, including on the lock screen.
  const characters = Array.from(String(item.title || "").trim().replace(/\s+/g, " ")); // by code point, so an emoji is never cut in half
  return {
    title: characters.length > 80 ? `${characters.slice(0, 79).join("").trimEnd()}…` : characters.join(""),
    body: item.ruleId === "deadline_overdue" ? `Termín ${when} uplynul.` : `Termín ${when} je do 48 hodin.`,
    url: `/?task=${encodeURIComponent(item.subjectId)}`,
    tag: `attention-${item.subjectId}`,
  };
}

// Delivery is tracked per subscribed device, so a device that failed is retried without
// notifying the devices that already received the message.
export interface AttentionPushSender {
  targets(): string[];
  sendTo(target: string, payload: Record<string, unknown>): Promise<PushTargetResult>;
}
const defaultSender: AttentionPushSender = { targets: listPushTargets, sendTo: sendPushToTarget };
const deviceKey = (itemKey: string, target: string) => `attention-device:${itemKey}:${target}`;

export async function processAttentionNotifications(now = Date.now(), sender: AttentionPushSender = defaultSender) {
  // One pass at a time: a slow push service must not let the next tick start a second batch.
  if (passRunning) return { state: "busy" as const, sent: 0 };
  passRunning = true;
  try {
    return await runPass(now, sender);
  } finally {
    passRunning = false;
  }
}

async function runPass(now: number, sender: AttentionPushSender) {
  const preferences = getNotificationPreferences();
  const database = getDatabase();
  if (!preferences.enabled || !preferences.attentionPush) {
    // Turning the feature back on starts from a fresh baseline instead of announcing the backlog.
    database.prepare("DELETE FROM notification_deliveries WHERE delivery_key = ?").run(BASELINE_KEY);
    return { state: "disabled" as const, sent: 0 };
  }
  const record = database.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)`);
  // A new item is claimed with a fresh row; an item nobody has received yet is claimed again for a retry.
  const claim = database.prepare(`INSERT INTO notification_deliveries
    (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at) VALUES (?, ?, ?, 'pending', 1, ?)
    ON CONFLICT(delivery_key) DO UPDATE SET status = 'pending', attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, error = NULL
    WHERE notification_deliveries.status = 'failed'`);
  const plan = withAttentionTransaction(() => {
    // A pass interrupted between claiming and sending (restart, crash) is closed as not delivered.
    database.prepare(`UPDATE notification_deliveries SET status = 'undelivered', error = 'Interrupted before sending'
      WHERE delivery_key LIKE 'attention:%' AND status = 'pending' AND last_attempt_at < ?`).run(now - STALE_PENDING_MS);
    const snapshot = readSnapshot();
    const items = activeWorkspaces(snapshot).flatMap((workspaceId) =>
      reconcileWorkspace(snapshot, workspaceId, preferences.timezone, now).items);
    const current = items.filter(announceable);
    if (!database.prepare("SELECT 1 FROM notification_deliveries WHERE delivery_key = ?").get(BASELINE_KEY)) {
      // First run: everything already on Home counts as known. Only later changes are announced.
      for (const item of current) record.run(attentionDeliveryKey(item), item.subjectId, item.relevantDate, "baseline", 0, now);
      record.run(BASELINE_KEY, "attention", "baseline", "baseline", 0, now);
      return { baseline: true, send: [] as AttentionItem[], retry: [] as AttentionItem[], held: null };
    }
    const rows = database.prepare("SELECT delivery_key, status, attempts FROM notification_deliveries WHERE delivery_key LIKE 'attention:%'")
      .all() as Array<{ delivery_key: string; status: string; attempts: number }>;
    // Handled = announced, baselined, given up on, or being sent. An item nobody received is retried up to MAX_ATTEMPTS.
    const handledKeys = new Set(rows.filter((row) => !(row.status === "failed" && row.attempts < MAX_ATTEMPTS)).map((row) => row.delivery_key));
    // "partial": at least one device has it, another failed. Only the failed devices are tried again.
    const partialKeys = new Set(rows.filter((row) => row.status === "partial").map((row) => row.delivery_key));
    // Delivered and in-flight items count toward the limit so overlapping work can never exceed it.
    const sentInLast24h = Number((database.prepare(`SELECT COUNT(*) AS count FROM notification_deliveries
      WHERE delivery_key LIKE 'attention:%' AND ((status IN ('sent', 'partial') AND sent_at > ?) OR (status = 'pending' AND last_attempt_at > ?))`,
    ).get(now - DAY, now - DAY) as { count: number }).count);
    const decision = planAttentionPushes({ items: current, handledKeys, sentInLast24h, now, timezone: preferences.timezone });
    // Claim inside the transaction so a retry or a second tick cannot announce the same item twice.
    for (const item of decision.send) claim.run(attentionDeliveryKey(item), item.subjectId, item.relevantDate, now);
    // Finishing a partial delivery is not a new announcement: no daily limit, but still no messages at night.
    const retry = inQuietHours(now, preferences.timezone) ? [] : current.filter((item) => partialKeys.has(attentionDeliveryKey(item)));
    return { baseline: false, ...decision, retry };
  });
  if (plan.baseline) return { state: "baseline" as const, sent: 0 };
  let sent = 0;
  for (const item of plan.retry) await deliver(item, now, sender, true);
  for (const item of plan.send) if (await deliver(item, now, sender, false)) sent += 1;
  return { state: plan.held || (plan.send.length ? "sent" as const : "idle" as const), sent };
}

// Sends one item to the devices that still need it and records the outcome per device.
// Returns true when this call delivered the item to its first device.
async function deliver(item: AttentionItem, now: number, sender: AttentionPushSender, onlyFailedDevices: boolean) {
  const database = getDatabase();
  const itemKey = attentionDeliveryKey(item);
  const prefix = deviceKey(itemKey, "");
  const known = new Map((database.prepare("SELECT delivery_key, status, attempts FROM notification_deliveries WHERE substr(delivery_key, 1, ?) = ?")
    .all(prefix.length, prefix) as Array<{ delivery_key: string; status: string; attempts: number }>)
    .map((row) => [row.delivery_key.slice(prefix.length), row]));
  const hadDelivery = [...known.values()].some((row) => row.status === "sent");
  const saveDevice = database.prepare(`INSERT INTO notification_deliveries
    (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at, sent_at) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(delivery_key) DO UPDATE SET status = excluded.status, attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, sent_at = excluded.sent_at`);
  const payload = attentionPushPayload(item);
  for (const target of sender.targets()) {
    const row = known.get(target);
    if (row ? row.status !== "failed" || row.attempts >= MAX_ATTEMPTS : onlyFailedDevices) continue;
    let result: PushTargetResult;
    try { result = await sender.sendTo(target, payload); } catch { result = "failed"; }
    saveDevice.run(deviceKey(itemKey, target), item.subjectId, item.relevantDate, result, now, result === "sent" ? now : null);
    known.set(target, { delivery_key: "", status: result, attempts: (row?.attempts || 0) + 1 });
  }
  const devices = [...known.values()];
  const delivered = devices.some((row) => row.status === "sent");
  const retryable = devices.some((row) => row.status === "failed" && row.attempts < MAX_ATTEMPTS);
  const finish = database.prepare("UPDATE notification_deliveries SET status = ?, sent_at = COALESCE(sent_at, ?), error = ?, attempts = MAX(attempts, ?) WHERE delivery_key = ?");
  if (delivered) finish.run(retryable ? "partial" : "sent", now, null, 0, itemKey);
  // No subscribed device at all: recorded as not delivered and not retried, so a device that
  // subscribes later does not receive a backlog. The item stays visible on Home.
  else if (!devices.length) finish.run("undelivered", null, "No subscribed device", 0, itemKey);
  // Nobody received it: try again on a later pass, or give up once every device used its attempts.
  else finish.run("failed", null, "Push failed on every device", retryable ? 0 : MAX_ATTEMPTS, itemKey);
  return delivered && !hadDelivery;
}
