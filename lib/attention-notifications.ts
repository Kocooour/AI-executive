import type { AttentionItem } from "./attention";
import { reconcileAttention } from "./attention-lifecycle";
import { activeWorkspaces, evaluateWorkspace, withAttentionTransaction } from "./attention-service";
import { getNotificationPreferences, sendPushToAll } from "./notifications";
import { getDatabase, readSnapshot } from "./server-store";

// Proactive push for attention items: one message when a task's deadline newly becomes "soon" or
// overdue. Only tasks are announced, never projects (owner decision 2026-10-07). It never writes to tasks, respects snooze and dismiss, and stays silent during quiet hours.

export const ATTENTION_PUSH_RULES = ["deadline_overdue", "deadline_soon"] as const;
export const ATTENTION_PUSH_QUIET_START = "22:00";
export const ATTENTION_PUSH_QUIET_END = "08:00";
export const ATTENTION_PUSH_DAILY_LIMIT = 3;
const DAY = 24 * 3_600_000;
const BASELINE_KEY = "attention:baseline";

const announceable = (item: AttentionItem) =>
  item.subjectType === "task" && (ATTENTION_PUSH_RULES as readonly string[]).includes(item.ruleId);

export const attentionDeliveryKey = (item: Pick<AttentionItem, "workspaceId" | "attentionKey">) =>
  `attention:${item.workspaceId}:${item.attentionKey}`;

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
  const title = item.title.trim().replace(/\s+/g, " ");
  return {
    title: title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title,
    body: item.ruleId === "deadline_overdue" ? `Termín ${when} uplynul.` : `Termín ${when} je do 48 hodin.`,
    url: `/?task=${encodeURIComponent(item.subjectId)}`,
    tag: `attention-${item.subjectId}`,
  };
}

type Sender = (payload: Record<string, unknown>) => Promise<{ sent: number; failed: number; total: number }>;

export async function processAttentionNotifications(now = Date.now(), send: Sender = sendPushToAll) {
  const preferences = getNotificationPreferences();
  const database = getDatabase();
  if (!preferences.enabled || !preferences.attentionPush) {
    // Turning the feature back on starts from a fresh baseline instead of announcing the backlog.
    database.prepare("DELETE FROM notification_deliveries WHERE delivery_key = ?").run(BASELINE_KEY);
    return { state: "disabled" as const, sent: 0 };
  }
  const record = database.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const plan = withAttentionTransaction(() => {
    const snapshot = readSnapshot();
    const items = activeWorkspaces(snapshot).flatMap((workspaceId) =>
      reconcileAttention(workspaceId, evaluateWorkspace(snapshot, workspaceId, preferences.timezone, now), now).items);
    const current = items.filter(announceable);
    if (!database.prepare("SELECT 1 FROM notification_deliveries WHERE delivery_key = ?").get(BASELINE_KEY)) {
      // First run: everything already on Home counts as known. Only later changes are announced.
      for (const item of current) record.run(attentionDeliveryKey(item), item.subjectId, item.relevantDate, "baseline", 0, now);
      record.run(BASELINE_KEY, "attention", "baseline", "baseline", 0, now);
      return { baseline: true, send: [] as AttentionItem[], held: null };
    }
    const handledKeys = new Set(database.prepare("SELECT delivery_key FROM notification_deliveries WHERE delivery_key LIKE 'attention:%'")
      .all().map((row) => String((row as { delivery_key: string }).delivery_key)));
    const sentInLast24h = Number((database.prepare(
      "SELECT COUNT(*) AS count FROM notification_deliveries WHERE delivery_key LIKE 'attention:%' AND status = 'sent' AND sent_at > ?",
    ).get(now - DAY) as { count: number }).count);
    const decision = planAttentionPushes({ items: current, handledKeys, sentInLast24h, now, timezone: preferences.timezone });
    // Claim inside the transaction so a retry or a second tick cannot announce the same item twice.
    for (const item of decision.send) record.run(attentionDeliveryKey(item), item.subjectId, item.relevantDate, "pending", 1, now);
    return { baseline: false, ...decision };
  });
  if (plan.baseline || !plan.send.length) return { state: plan.baseline ? "baseline" as const : plan.held || "idle" as const, sent: 0 };
  const finish = database.prepare("UPDATE notification_deliveries SET status = ?, sent_at = ?, error = ? WHERE delivery_key = ?");
  let sent = 0;
  for (const item of plan.send) {
    const key = attentionDeliveryKey(item);
    try {
      const result = await send(attentionPushPayload(item));
      if (result.sent > 0) { finish.run("sent", Date.now(), null, key); sent += 1; }
      // No device or every device failed: recorded as not delivered and not retried, so a later
      // subscription does not receive a backlog. The item stays visible on Home.
      else finish.run("undelivered", null, result.total ? "Push failed on every device" : "No subscribed device", key);
    } catch (error) {
      finish.run("undelivered", null, error instanceof Error ? error.message.slice(0, 300) : "Push failed", key);
    }
  }
  return { state: plan.held || ("sent" as const), sent };
}
