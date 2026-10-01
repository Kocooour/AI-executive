import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Entity } from "./db";
import { getNotificationPreferences, sendExecutiveNotification } from "./notifications";
import { getDatabase, readSnapshot } from "./server-store";
import { calendarAvailability } from "./calendar";
import { alfredAgent, beginPACTRun, ensurePACTDefaults, finishPACTRun } from "./pact";

export type BriefingKind = "morning" | "evening";

export interface ExecutiveBriefing {
  id: string;
  kind: BriefingKind;
  workspaceId: string;
  workspaceName: string;
  localDate: string;
  title: string;
  summary: string;
  topTasks: Array<{ id: string; title: string; reason: string }>;
  overdueCount: number;
  riskCount: number;
  completedCount: number;
  remainingCount: number;
  capacity: number;
  overloaded: boolean;
  calendar?: { configured: boolean; fresh: boolean; freeHours: number; busyHours: number };
  suggestions: string[];
  createdAt: number;
}

function localParts(now: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: weekdays[parts.weekday],
  };
}

function taskDate(task: Entity) {
  const when = typeof task.properties.when === "string" ? task.properties.when.slice(0, 10) : "";
  const deadline = typeof task.properties.deadline === "string" ? task.properties.deadline.slice(0, 10) : "";
  return { when, deadline, earliest: [when, deadline].filter(Boolean).sort()[0] || "" };
}

const priorityScore = (value: unknown) => ({ high: 30, medium: 20, low: 10 }[String(value)] || 0);

export function buildExecutiveBriefing(
  kind: BriefingKind,
  workspaceId: string,
  now = Date.now(),
): ExecutiveBriefing {
  const preferences = getNotificationPreferences();
  const local = localParts(now, preferences.timezone);
  const snapshot = readSnapshot();
  const workspace = snapshot.entities.find(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
  if (!workspace || workspaceId === "all") throw new Error("Briefing workspace does not exist");
  const allTasks = snapshot.entities.filter(
    (entity) => entity.type === "task" && entity.workspaceId === workspaceId,
  );
  const open = allTasks.filter((task) => task.status === "open");
  const completedToday = allTasks.filter((task) => {
    if (task.status !== "completed") return false;
    const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
    return activity.some((entry) => {
      const at = Number((entry as { at?: unknown }).at || 0);
      const action = String((entry as { action?: unknown }).action || "");
      return at && action.includes("completed") && localParts(at, preferences.timezone).date === local.date;
    });
  });
  const ranked = open.map((task) => {
    const dates = taskDate(task);
    const overdue = Boolean(
      (dates.deadline && dates.deadline < local.date) ||
      (dates.when && dates.when < local.date),
    );
    const today = dates.when === local.date || dates.deadline === local.date;
    const stickyToday = task.properties.today === true && !dates.when;
    const nearDeadline = Boolean(dates.deadline && dates.deadline > local.date && dates.deadline <= addDays(local.date, 2));
    const score = (overdue ? 100 : 0) + (today ? 70 : 0) + (stickyToday ? 40 : 0) +
      (nearDeadline ? 25 : 0) + priorityScore(task.properties.priority);
    const reason = overdue
      ? "po termínu"
      : today
        ? "naplánováno na dnes"
        : nearDeadline
          ? "blíží se termín"
          : priorityScore(task.properties.priority) >= 30
            ? "vysoká priorita"
            : stickyToday
              ? "označeno na dnes"
              : "další otevřený úkol";
    return { task, dates, overdue, nearDeadline, today: today || stickyToday, score, reason };
  }).sort((a, b) => b.score - a.score || a.dates.earliest.localeCompare(b.dates.earliest) || a.task.createdAt - b.task.createdAt);
  const dueToday = ranked.filter((item) => item.today || item.overdue);
  const overdueCount = ranked.filter((item) => item.overdue).length;
  const riskCount = ranked.filter((item) => item.overdue || item.nearDeadline).length;
  const workload = dueToday.length;
  const availability = calendarAvailability(workspaceId, local.date, preferences.timezone, preferences.workdayStart, preferences.workdayEnd);
  const overloaded = availability.configured && availability.fresh
    ? workload > Math.max(1, Math.floor(availability.freeHours))
    : workload > preferences.dailyTaskCapacity;
  const topTasks = ranked.slice(0, 3).map(({ task, reason }) => ({ id: task.id, title: task.title, reason }));
  const suggestions: string[] = [];
  if (overdueCount) suggestions.push(`Prověř ${overdueCount} úkolů po termínu a potvrď nový realistický termín.`);
  if (overloaded) suggestions.push(
    availability.configured && availability.fresh
      ? `Dnešní zátěž (${workload} úkolů) je pravděpodobně vyšší než ${availability.freeHours.toFixed(1)} h volného času; navrhni přesun méně důležitých úkolů.`
      : `Dnešní zátěž (${workload}) překračuje orientační kapacitu ${preferences.dailyTaskCapacity}; navrhni přesun méně důležitých úkolů.`,
  );
  if (availability.configured && !availability.fresh) suggestions.push("Kalendář není čerstvý, proto nyní netvrdím, které bloky jsou volné. Nejprve ho obnov.");
  if (availability.configured && availability.fresh && availability.windows[0]) {
    const window = availability.windows[0];
    const time = new Intl.DateTimeFormat("cs-CZ", { timeZone: preferences.timezone, hour: "2-digit", minute: "2-digit" });
    suggestions.push(`První volný blok je ${time.format(new Date(window.start))}–${time.format(new Date(window.end))} (${window.hours.toFixed(1)} h).`);
  }
  if (kind === "evening" && open.length) suggestions.push("Nedokončené úkoly zůstaly beze změny. O přesunu rozhodni přes Ask AI a potvrď návrh.");
  if (!suggestions.length) suggestions.push(kind === "morning" ? "Začni prvním doporučeným úkolem." : "Není potřeba nic přesouvat.");
  const summary = kind === "morning"
    ? `${topTasks.length ? `Vybral jsem ${topTasks.length} hlavní úkoly.` : "Na dnešek nemáš žádný otevřený úkol."} ${overdueCount ? `${overdueCount} je po termínu.` : "Nic není po termínu."}`
    : `Dnes dokončeno: ${completedToday.length}. Otevřeno zůstává: ${open.length}.`;
  return {
    id: randomUUID(), kind, workspaceId, workspaceName: workspace.title, localDate: local.date,
    title: kind === "morning" ? "Ranní přehled" : "Večerní rekapitulace",
    summary, topTasks, overdueCount, riskCount, completedCount: completedToday.length,
    remainingCount: open.length, capacity: preferences.dailyTaskCapacity, overloaded, suggestions, createdAt: now,
    calendar: { configured: availability.configured, fresh: availability.fresh, freeHours: availability.freeHours, busyHours: availability.busyHours },
  };
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function saveBriefing(briefing: ExecutiveBriefing, deliveryKey: string) {
  const result = getDatabase().prepare(`
    INSERT OR IGNORE INTO executive_briefings
      (id, delivery_key, kind, workspace_id, local_date, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(briefing.id, deliveryKey, briefing.kind, briefing.workspaceId, briefing.localDate, JSON.stringify(briefing), briefing.createdAt);
  return Number(result.changes) === 1;
}

function enqueueTelegram(briefing: ExecutiveBriefing) {
  const outbox = process.env.AI_EXECUTIVE_BRIEFING_OUTBOX_DIR;
  if (!outbox) return false;
  mkdirSync(outbox, { recursive: true });
  const payload = {
    schema: 1,
    id: briefing.id,
    kind: briefing.kind,
    workspace: briefing.workspaceName.slice(0, 120),
    localDate: briefing.localDate,
    summary: briefing.summary.slice(0, 500),
    topTasks: briefing.topTasks.map((task) => ({ title: task.title.slice(0, 240), reason: task.reason })),
    suggestions: briefing.suggestions.map((value) => value.slice(0, 400)),
  };
  const temporary = path.join(outbox, `.${briefing.id}.tmp`);
  const destination = path.join(outbox, `${briefing.id}.json`);
  writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o640, flag: "wx" });
  renameSync(temporary, destination);
  return true;
}

export function listExecutiveBriefings(workspaceId?: string, limit = 7) {
  const rows = workspaceId
    ? getDatabase().prepare("SELECT payload FROM executive_briefings WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?").all(workspaceId, limit)
    : getDatabase().prepare("SELECT payload FROM executive_briefings ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((row) => JSON.parse(String((row as { payload: string }).payload)) as ExecutiveBriefing);
}

async function deliverBriefing(briefing: ExecutiveBriefing) {
  const preferences = getNotificationPreferences();
  const row = getDatabase().prepare(
    "SELECT push_sent_at, telegram_enqueued_at, attempts, last_attempt_at FROM executive_briefings WHERE id = ?",
  ).get(briefing.id) as { push_sent_at: number | null; telegram_enqueued_at: number | null; attempts: number; last_attempt_at: number | null } | undefined;
  if (!row) return { pushSent: false, telegramEnqueued: false, error: "Briefing not found" };
  const now = Date.now();
  if (row.last_attempt_at && now - row.last_attempt_at < 5 * 60_000) {
    return { pushSent: Boolean(row.push_sent_at), telegramEnqueued: Boolean(row.telegram_enqueued_at), error: "" };
  }
  let pushSent = Boolean(row.push_sent_at);
  let telegramEnqueued = Boolean(row.telegram_enqueued_at);
  const errors: string[] = [];
  try {
    if (preferences.briefingPush && !pushSent) {
      const result = await sendExecutiveNotification(briefing.kind, `${briefing.summary} Otevři aplikaci pro bezpečný detail.`, briefing.id);
      pushSent = result.total > 0 && result.failed === 0;
      if (!pushSent) errors.push("Push zatím nemá dostupné zařízení");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : "Push delivery failed");
  }
  try {
    if (preferences.briefingTelegram && !telegramEnqueued) {
      telegramEnqueued = enqueueTelegram(briefing);
      if (!telegramEnqueued) errors.push("Telegram adaptér není nainstalovaný");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : "Telegram enqueue failed");
  }
  getDatabase().prepare(`
    UPDATE executive_briefings
    SET attempts = attempts + 1, last_attempt_at = ?,
        push_sent_at = COALESCE(push_sent_at, ?),
        telegram_enqueued_at = COALESCE(telegram_enqueued_at, ?), error = ?
    WHERE id = ?
  `).run(now, pushSent ? now : null, telegramEnqueued ? now : null, errors.join("; ").slice(0, 500) || null, briefing.id);
  return { pushSent, telegramEnqueued, error: errors.join("; ") };
}

export async function createExecutiveBriefing(kind: BriefingKind, workspaceId: string, now = Date.now(), manual = false) {
  ensurePACTDefaults();
  const runId = beginPACTRun(
    alfredAgent.id,
    workspaceId,
    manual ? "manual" : "scheduled",
    `executive-briefing:${kind}`,
  );
  try {
    const briefing = buildExecutiveBriefing(kind, workspaceId, now);
    const deliveryKey = manual ? `manual:${briefing.id}` : `${kind}:${workspaceId}:${briefing.localDate}`;
    if (!saveBriefing(briefing, deliveryKey)) {
      const existing = getDatabase().prepare("SELECT payload FROM executive_briefings WHERE delivery_key = ?").get(deliveryKey) as { payload?: string } | undefined;
      const saved = existing?.payload ? JSON.parse(existing.payload) as ExecutiveBriefing : listExecutiveBriefings(workspaceId, 1)[0];
      const delivery = saved ? await deliverBriefing(saved) : { pushSent: false, telegramEnqueued: false, error: "" };
      finishPACTRun(runId, "completed", `briefing:${kind};created:false;delivery-retry:${Boolean(saved)}`);
      return { created: false, briefing: saved, ...delivery };
    }
    if (manual) {
      finishPACTRun(runId, "completed", `briefing:${kind};created:true;delivery:manual-suppressed`);
      return { created: true, briefing, pushSent: false, telegramEnqueued: false, error: "" };
    }
    const delivery = await deliverBriefing(briefing);
    finishPACTRun(
      runId,
      "completed",
      `briefing:${kind};created:true;push:${delivery.pushSent};telegram:${delivery.telegramEnqueued};delivery-error:${Boolean(delivery.error)}`,
    );
    return { created: true, briefing, ...delivery };
  } catch (error) {
    finishPACTRun(runId, "failed", `briefing:${kind};error:${error instanceof Error ? error.name : "unknown"}`);
    throw error;
  }
}

export async function processExecutiveBriefings(now = Date.now()) {
  const preferences = getNotificationPreferences();
  if (!preferences.briefingEnabled) return { due: 0, created: 0 };
  const local = localParts(now, preferences.timezone);
  if (!preferences.workdays.includes(local.weekday)) return { due: 0, created: 0 };
  const schedule: Array<[BriefingKind, boolean, string]> = [
    ["morning", preferences.morningBriefEnabled, preferences.morningBriefTime],
    ["evening", preferences.eveningReviewEnabled, preferences.eveningReviewTime],
  ];
  let due = 0;
  let created = 0;
  const pending = getDatabase().prepare(`
    SELECT payload, push_sent_at, telegram_enqueued_at FROM executive_briefings
    WHERE delivery_key NOT LIKE 'manual:%'
      AND (push_sent_at IS NULL OR telegram_enqueued_at IS NULL)
      AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
    ORDER BY created_at DESC LIMIT 10
  `).all(now - 5 * 60_000);
  for (const row of pending) {
    const candidate = row as { payload: string; push_sent_at: number | null; telegram_enqueued_at: number | null };
    if (
      (preferences.briefingPush && !candidate.push_sent_at) ||
      (preferences.briefingTelegram && !candidate.telegram_enqueued_at)
    ) await deliverBriefing(JSON.parse(String(candidate.payload)) as ExecutiveBriefing);
  }
  for (const [kind, enabled, time] of schedule) {
    if (!enabled || local.time < time) continue;
    // A briefing may be caught up after a restart, but a morning report is not
    // sent once the evening window has begun.
    if (kind === "morning" && local.time >= preferences.eveningReviewTime) continue;
    due += 1;
    const result = await createExecutiveBriefing(kind, preferences.briefingWorkspaceId, now);
    if (result.created) created += 1;
  }
  return { due, created };
}
