import webpush, { type PushSubscription } from "web-push";
import { createHash } from "node:crypto";
import { getDatabase, readSnapshot } from "./server-store";

export interface NotificationPreferences {
  enabled: boolean;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  workdays: number[];
  briefingEnabled: boolean;
  morningBriefEnabled: boolean;
  morningBriefTime: string;
  eveningReviewEnabled: boolean;
  eveningReviewTime: string;
  briefingWorkspaceId: string;
  briefingPush: boolean;
  briefingTelegram: boolean;
  dailyTaskCapacity: number;
}

const defaultPreferences: NotificationPreferences = {
  enabled: true,
  timezone: "Europe/Prague",
  workdayStart: "08:00",
  workdayEnd: "18:00",
  workdays: [1, 2, 3, 4, 5],
  briefingEnabled: false,
  morningBriefEnabled: true,
  morningBriefTime: "07:30",
  eveningReviewEnabled: true,
  eveningReviewTime: "18:00",
  briefingWorkspaceId: "personal",
  briefingPush: true,
  briefingTelegram: false,
  dailyTaskCapacity: 5,
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

function getVapidSubject() {
  const explicit = process.env.VAPID_SUBJECT?.trim();
  if (explicit) return explicit;

  const configuredOrigins = [
    process.env.AI_EXECUTIVE_PASSKEY_ORIGINS,
    process.env.AI_EXECUTIVE_ALLOWED_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const httpsOrigin = configuredOrigins.find((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });

  // Apple Push Service rejects non-public subjects such as *.local with
  // BadJwtToken. Prefer the configured public app origin when available.
  return httpsOrigin || "mailto:admin@example.com";
}

function configureWebPush() {
  const keys = getVapidKeys();
  webpush.setVapidDetails(
    getVapidSubject(),
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
  if (
    (input.timezone !== undefined &&
      (typeof input.timezone !== "string" || !input.timezone.trim() || input.timezone.length > 100)) ||
    (input.workdayStart !== undefined &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.workdayStart)) ||
    (input.workdayEnd !== undefined &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.workdayEnd)) ||
    (input.morningBriefTime !== undefined &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.morningBriefTime)) ||
    (input.eveningReviewTime !== undefined &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.eveningReviewTime)) ||
    (input.briefingWorkspaceId !== undefined &&
      (typeof input.briefingWorkspaceId !== "string" || !/^[A-Za-z0-9:_-]{1,120}$/.test(input.briefingWorkspaceId))) ||
    (input.dailyTaskCapacity !== undefined &&
      (!Number.isInteger(input.dailyTaskCapacity) || input.dailyTaskCapacity < 1 || input.dailyTaskCapacity > 50)) ||
    (input.workdays !== undefined &&
      (!Array.isArray(input.workdays) ||
        input.workdays.length > 7 ||
        new Set(input.workdays).size !== input.workdays.length ||
        input.workdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)))
  ) {
    throw new Error("Invalid notification preferences");
  }
  const next: NotificationPreferences = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    timezone:
      typeof input.timezone === "string" && input.timezone.trim() && input.timezone.length <= 100
        ? input.timezone.trim()
        : current.timezone,
    workdayStart: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.workdayStart || "")
      ? input.workdayStart!
      : current.workdayStart,
    workdayEnd: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.workdayEnd || "")
      ? input.workdayEnd!
      : current.workdayEnd,
    workdays: Array.isArray(input.workdays)
      ? input.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : current.workdays,
    briefingEnabled: typeof input.briefingEnabled === "boolean" ? input.briefingEnabled : current.briefingEnabled,
    morningBriefEnabled: typeof input.morningBriefEnabled === "boolean" ? input.morningBriefEnabled : current.morningBriefEnabled,
    morningBriefTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.morningBriefTime || "")
      ? input.morningBriefTime! : current.morningBriefTime,
    eveningReviewEnabled: typeof input.eveningReviewEnabled === "boolean" ? input.eveningReviewEnabled : current.eveningReviewEnabled,
    eveningReviewTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.eveningReviewTime || "")
      ? input.eveningReviewTime! : current.eveningReviewTime,
    briefingWorkspaceId: typeof input.briefingWorkspaceId === "string"
      ? input.briefingWorkspaceId : current.briefingWorkspaceId,
    briefingPush: typeof input.briefingPush === "boolean" ? input.briefingPush : current.briefingPush,
    briefingTelegram: typeof input.briefingTelegram === "boolean" ? input.briefingTelegram : current.briefingTelegram,
    dailyTaskCapacity: Number.isInteger(input.dailyTaskCapacity)
      ? input.dailyTaskCapacity! : current.dailyTaskCapacity,
  };
  try {
    new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format();
  } catch {
    throw new Error("Invalid timezone");
  }
  if (!readSnapshot().entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === next.briefingWorkspaceId,
  )) {
    throw new Error("Briefing workspace does not exist");
  }
  setMetadata("notificationPreferences", JSON.stringify(next));
  return next;
}

export function saveSubscription(subscription: PushSubscription) {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  if (
    subscription.endpoint.length > 8192 ||
    subscription.keys.p256dh.length > 2048 ||
    subscription.keys.auth.length > 2048 ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(subscription.keys.p256dh) ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(subscription.keys.auth)
  ) {
    throw new Error("Push subscription is too large");
  }
  const endpoint = new URL(subscription.endpoint);
  const allowedHosts = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
  ];
  const allowed = endpoint.protocol === "https:" &&
    (!endpoint.port || endpoint.port === "443") && (
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

export function currentAttentionTaskCount(now = Date.now()) {
  const timezone = getNotificationPreferences().timezone;
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const tomorrowDate = new Date(`${today}T12:00:00Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  return readSnapshot().entities.filter((entity) => {
    if (entity.type !== "task" || entity.status !== "open") return false;
    const dueDates = [entity.properties.when, entity.properties.deadline]
      .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
    return dueDates.some((due) => due <= tomorrow);
  }).length;
}

async function sendToAll(payload: Record<string, unknown>) {
  configureWebPush();
  let sent = 0;
  let failed = 0;
  const targets = subscriptions();
  for (const target of targets) {
    try {
      await sendTarget(target.subscription, payload);
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
      if (statusCode === 404 || statusCode === 410) removeSubscription(target.endpoint);
      else console.error("Push delivery failed", error);
    }
  }
  return { sent, failed, total: targets.length };
}

function sendTarget(subscription: PushSubscription, payload: Record<string, unknown>) {
  configureWebPush();
  return webpush.sendNotification(subscription, JSON.stringify({
    ...payload,
    appBadge: currentAttentionTaskCount(),
  }), {
    TTL: 60 * 60 * 24,
    urgency: "normal",
  });
}

export async function sendTestNotification() {
  return sendToAll({
    title: "Lumi",
    body: "Notifications are ready on this device.",
    url: "/?view=Today",
    tag: "ai-executive-test",
  });
}

export async function sendSecurityNotification(
  title: string,
  body: string,
  severity: "warning" | "critical",
) {
  return sendToAll({
    title,
    body,
    url: "/?view=Settings",
    tag: `ai-executive-security-${severity}`,
    requireInteraction: severity === "critical",
  });
}

export async function sendExecutiveNotification(
  kind: "morning" | "evening",
  body: string,
  briefingId: string,
) {
  const database = getDatabase();
  const targets = subscriptions();
  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    const endpointKey = createHash("sha256").update(target.endpoint).digest("hex").slice(0, 20);
    const deliveryKey = `briefing:${briefingId}:${endpointKey}`;
    const existing = database.prepare("SELECT status FROM notification_deliveries WHERE delivery_key = ?")
      .get(deliveryKey) as { status?: string } | undefined;
    if (existing?.status === "sent") continue;
    database.prepare(`
      INSERT INTO notification_deliveries
        (delivery_key, entity_id, reminder_at, status, attempts, last_attempt_at)
      VALUES (?, ?, ?, 'pending', 1, ?)
      ON CONFLICT(delivery_key) DO UPDATE SET
        status = 'pending', attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, error = NULL
      WHERE notification_deliveries.status != 'sent'
    `).run(deliveryKey, briefingId, kind, Date.now());
    try {
      await sendTarget(target.subscription, {
        title: kind === "morning" ? "Ranní přehled" : "Večerní rekapitulace",
        body,
        url: "/?view=Home&briefing=latest",
        tag: `ai-executive-briefing-${kind}`,
      });
      database.prepare("UPDATE notification_deliveries SET status = 'sent', sent_at = ?, error = NULL WHERE delivery_key = ?")
        .run(Date.now(), deliveryKey);
      sent += 1;
    } catch (error) {
      failed += 1;
      const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
      if (statusCode === 404 || statusCode === 410) removeSubscription(target.endpoint);
      database.prepare("UPDATE notification_deliveries SET status = 'failed', error = ? WHERE delivery_key = ?")
        .run(error instanceof Error ? error.message : "Push failed", deliveryKey);
    }
  }
  return { sent, failed, total: targets.length };
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
