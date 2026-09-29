import webpush, { type PushSubscription } from "web-push";
import { createHash } from "node:crypto";
import { getDatabase, readSnapshot } from "./server-store";

export interface NotificationPreferences {
  enabled: boolean;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  workdays: number[];
}

const defaultPreferences: NotificationPreferences = {
  enabled: true,
  timezone: "Europe/Prague",
  workdayStart: "08:00",
  workdayEnd: "18:00",
  workdays: [1, 2, 3, 4, 5],
};

function metadata(key: string) {
  const row = getDatabase()
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

function setMetadata(key: string, value: string) {
  getDatabase()
    .prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    .run(key, value);
}

function getVapidKeys() {
  const saved = metadata("vapidKeys");
  if (saved) return JSON.parse(saved) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  setMetadata("vapidKeys", JSON.stringify(keys));
  return keys;
}

function configureWebPush() {
  const keys = getVapidKeys();
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@ai-executive.local",
    keys.publicKey,
    keys.privateKey,
  );
  return keys;
}

export function getNotificationState() {
  const keys = configureWebPush();
  const preferences = getNotificationPreferences();
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS count FROM push_subscriptions")
    .get() as { count: number };
  return {
    publicKey: keys.publicKey,
    subscriptionCount: Number(row.count),
    preferences,
  };
}

export function getNotificationPreferences(): NotificationPreferences {
  const value = metadata("notificationPreferences");
  if (!value) return defaultPreferences;
  try {
    const parsed = JSON.parse(value) as Partial<NotificationPreferences>;
    return {
      ...defaultPreferences,
      ...parsed,
      workdays: Array.isArray(parsed.workdays)
        ? parsed.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : defaultPreferences.workdays,
    };
  } catch {
    return defaultPreferences;
  }
}

export function saveNotificationPreferences(input: Partial<NotificationPreferences>) {
  const current = getNotificationPreferences();
  const next: NotificationPreferences = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    timezone:
      typeof input.timezone === "string" && input.timezone.trim()
        ? input.timezone.trim()
        : current.timezone,
    workdayStart: /^\d{2}:\d{2}$/.test(input.workdayStart || "")
      ? input.workdayStart!
      : current.workdayStart,
    workdayEnd: /^\d{2}:\d{2}$/.test(input.workdayEnd || "")
      ? input.workdayEnd!
      : current.workdayEnd,
    workdays: Array.isArray(input.workdays)
      ? input.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : current.workdays,
  };
  try {
    new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format();
  } catch {
    throw new Error("Invalid timezone");
  }
  setMetadata("notificationPreferences", JSON.stringify(next));
  return next;
}

export function saveSubscription(subscription: PushSubscription) {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  const endpoint = new URL(subscription.endpoint);
  const allowedHosts = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
  ];
  const allowed = endpoint.protocol === "https:" && (
    allowedHosts.includes(endpoint.hostname) || endpoint.hostname.endsWith(".notify.windows.com")
  );
  if (!allowed) throw new Error("Unsupported push service");
  const now = Date.now();
  getDatabase()
    .prepare(`
      INSERT INTO push_subscriptions (endpoint, payload, created_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        payload = excluded.payload,
        last_seen_at = excluded.last_seen_at
    `)
    .run(subscription.endpoint, JSON.stringify(subscription), now, now);
}

export function removeSubscription(endpoint: string) {
  if (!endpoint) return;
  getDatabase().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function subscriptions() {
  return getDatabase()
    .prepare("SELECT endpoint, payload FROM push_subscriptions")
    .all()
    .map((row) => ({
      endpoint: String((row as { endpoint: string }).endpoint),
      subscription: JSON.parse(String((row as { payload: string }).payload)) as PushSubscription,
    }));
}

async function sendToAll(payload: Record<string, unknown>) {
  configureWebPush();
  let sent = 0;
  for (const target of subscriptions()) {
    try {
      await sendTarget(target.subscription, payload);
      sent += 1;
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
      if (statusCode === 404 || statusCode === 410) removeSubscription(target.endpoint);
      else console.error("Push delivery failed", error);
    }
  }
  return sent;
}

function sendTarget(subscription: PushSubscription, payload: Record<string, unknown>) {
  configureWebPush();
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 60 * 60 * 24,
    urgency: "normal",
  });
}

export async function sendTestNotification() {
  return sendToAll({
    title: "AI Executive",
    body: "Notifications are ready on this device.",
    url: "/?view=Today",
    tag: "ai-executive-test",
  });
}

function normalizedReminder(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function processDueReminders(now = Date.now()) {
  const preferences = getNotificationPreferences();
  if (!preferences.enabled) return { due: 0, sent: 0 };
  const database = getDatabase();
  let due = 0;
  let sent = 0;
  for (const task of readSnapshot().entities) {
    if (task.type !== "task" || task.status !== "open") continue;
    const reminderAt = normalizedReminder(task.properties.reminderAt);
    if (reminderAt === null || reminderAt > now) continue;
    due += 1;
    const occurrence = `${task.id}:${String(task.properties.reminderAt)}`;
    for (const target of subscriptions()) {
      const endpointKey = createHash("sha256").update(target.endpoint).digest("hex").slice(0, 20);
      const deliveryKey = `${occurrence}:${endpointKey}`;
      const existing = database
        .prepare("SELECT status, last_attempt_at FROM notification_deliveries WHERE delivery_key = ?")
        .get(deliveryKey) as { status: string; last_attempt_at: number } | undefined;
      if (existing?.status === "sent") continue;
      let claimed = false;
      if (!existing) {
        const result = database
          .prepare(`
            INSERT OR IGNORE INTO notification_deliveries
              (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at)
            VALUES (?, ?, ?, 'pending', 1, ?)
          `)
          .run(deliveryKey, task.id, String(task.properties.reminderAt), now);
        claimed = Number(result.changes) === 1;
      } else if (now - Number(existing.last_attempt_at) >= 5 * 60_000) {
        const result = database
          .prepare(`
            UPDATE notification_deliveries
            SET status = 'pending', attempts = attempts + 1, last_attempt_at = ?, error = NULL
            WHERE delivery_key = ? AND status != 'sent' AND last_attempt_at = ?
          `)
          .run(now, deliveryKey, existing.last_attempt_at);
        claimed = Number(result.changes) === 1;
      }
      if (!claimed) continue;
      try {
        await sendTarget(target.subscription, {
          title: task.title,
          body: String(task.properties.notes || "This commitment needs your attention."),
          url: `/?task=${encodeURIComponent(task.id)}`,
          tag: `task-${task.id}`,
        });
        database
          .prepare(`
            UPDATE notification_deliveries
            SET status = 'sent', sent_at = ?, error = NULL
            WHERE delivery_key = ?
          `)
          .run(Date.now(), deliveryKey);
        sent += 1;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
        if (statusCode === 404 || statusCode === 410) removeSubscription(target.endpoint);
        database
          .prepare("UPDATE notification_deliveries SET status = 'failed', error = ? WHERE delivery_key = ?")
          .run(error instanceof Error ? error.message : "Push failed", deliveryKey);
      }
    }
  }
  return { due, sent };
}
