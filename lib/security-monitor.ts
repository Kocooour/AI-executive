import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sendSecurityNotification } from "./notifications";
import { getDatabase } from "./server-store";

interface SecuritySignal {
  id: number;
  createdAt: number;
  action: string;
  outcome: "allowed" | "rejected" | "failed";
  actorHash: string;
  details: Record<string, unknown>;
}

interface SecurityAlert {
  id: string;
  severity: "warning" | "critical";
  rule: string;
  title: string;
  summary: string;
  actorHash: string;
  firstAt: number;
  lastAt: number;
  eventCount: number;
}

const safeReason = (details: Record<string, unknown>) => String(details.reason || "unknown").slice(0, 80);
const safeMethod = (details: Record<string, unknown>) => String(details.method || "UNKNOWN").slice(0, 12);
const safePath = (details: Record<string, unknown>) => String(details.path || "/unknown").slice(0, 200);

function recentCount(
  actorHash: string,
  since: number,
  where: string,
  ...parameters: Array<string | number>
) {
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM security_events
    WHERE actor_hash = ? AND created_at >= ? AND (${where})
  `).get(actorHash, since, ...parameters) as { count?: number } | undefined;
  return Number(row?.count || 0);
}

function classify(signal: SecuritySignal) {
  if (signal.outcome === "allowed") return null;
  const reason = safeReason(signal.details);
  const method = safeMethod(signal.details);
  const route = safePath(signal.details);

  if (reason === "rate-limit") {
    return {
      severity: "critical" as const,
      rule: "rate-limit-triggered",
      title: "Lumi: rate limit triggered",
      summary: `${method} ${route} was blocked by a rate limit.`,
      count: 1,
      windowMs: 10 * 60_000,
    };
  }

  if (reason === "unauthenticated" && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return {
      severity: "critical" as const,
      rule: "unauthenticated-mutation",
      title: "Lumi: blocked unauthorized write",
      summary: `${method} ${route} was rejected before any data changed.`,
      count: 1,
      windowMs: 5 * 60_000,
    };
  }

  if (signal.action.startsWith("auth.")) {
    const count = recentCount(
      signal.actorHash,
      signal.createdAt - 10 * 60_000,
      "action LIKE 'auth.%' AND outcome != 'allowed'",
    );
    if (count >= 3) {
      return {
        severity: "critical" as const,
        rule: "authentication-failures",
        title: "Lumi: repeated authentication failures",
        summary: `${count} authentication attempts from one source were rejected in 10 minutes.`,
        count,
        windowMs: 10 * 60_000,
      };
    }
  }

  if (method === "GET" && reason === "unauthenticated") {
    const count = recentCount(
      signal.actorHash,
      signal.createdAt - 5 * 60_000,
      "outcome != 'allowed' AND details LIKE '%\"method\":\"GET\"%'",
    );
    if (count >= 5) {
      return {
        severity: "warning" as const,
        rule: "protected-route-reconnaissance",
        title: "Lumi: protected route probing",
        summary: `${count} unauthenticated reads from one source were rejected in 5 minutes.`,
        count,
        windowMs: 5 * 60_000,
      };
    }
  }
  return null;
}

function outboxDirectory() {
  const configured = process.env.AI_EXECUTIVE_SECURITY_OUTBOX_DIR?.trim();
  return configured || path.join(
    process.env.AI_EXECUTIVE_DATA_DIR || path.join(process.cwd(), ".data"),
    "security-outbox",
  );
}

function writeHermesOutbox(alert: SecurityAlert) {
  const directory = outboxDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o770 });
  const payload = {
    schema: 1,
    id: alert.id,
    severity: alert.severity,
    rule: alert.rule,
    title: alert.title,
    summary: alert.summary,
    eventCount: alert.eventCount,
    firstAt: new Date(alert.firstAt).toISOString(),
    lastAt: new Date(alert.lastAt).toISOString(),
    source: alert.actorHash,
  };
  const finalPath = path.join(directory, `${alert.id}.json`);
  const temporaryPath = path.join(directory, `.${alert.id}.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o640, flag: "wx" });
  // The hardened application unit uses UMask=0077. Restore the narrow group
  // read bit explicitly so only the dedicated Hermes group can consume it.
  chmodSync(temporaryPath, 0o640);
  renameSync(temporaryPath, finalPath);
  return Date.now();
}

function createOrUpdateAlert(signal: SecuritySignal) {
  const match = classify(signal);
  if (!match) return;
  const window = Math.floor(signal.createdAt / match.windowMs);
  const fingerprint = createHash("sha256")
    .update(`${match.rule}|${signal.actorHash}|${window}`)
    .digest("hex");
  const id = randomUUID();
  const database = getDatabase();
  database.prepare(`
    INSERT INTO security_alerts (
      id, fingerprint, severity, rule, title, summary, actor_hash,
      first_at, last_at, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_at = excluded.last_at,
      event_count = MAX(security_alerts.event_count, excluded.event_count),
      summary = excluded.summary
  `).run(
    id,
    fingerprint,
    match.severity,
    match.rule,
    match.title,
    match.summary,
    signal.actorHash,
    signal.createdAt,
    signal.createdAt,
    match.count,
  );
}

export function evaluateSecuritySignal(signal: SecuritySignal) {
  try {
    createOrUpdateAlert(signal);
  } catch (error) {
    console.error("Security alert evaluation failed", error instanceof Error ? error.message : error);
  }
}

function queuedAlerts(channel: "hermes" | "push") {
  const column = channel === "hermes" ? "hermes_enqueued_at" : "push_sent_at";
  return getDatabase().prepare(`
    SELECT * FROM security_alerts
    WHERE ${column} IS NULL
    ORDER BY first_at ASC
    LIMIT 20
  `).all() as Array<Record<string, unknown>>;
}

function alertFromRow(row: Record<string, unknown>): SecurityAlert {
  return {
      id: String(row.id),
      severity: row.severity === "critical" ? "critical" : "warning",
      rule: String(row.rule),
      title: String(row.title),
      summary: String(row.summary),
      actorHash: String(row.actor_hash),
      firstAt: Number(row.first_at),
      lastAt: Number(row.last_at),
      eventCount: Number(row.event_count),
  };
}

export async function processSecurityAlerts() {
  const database = getDatabase();
  for (const row of queuedAlerts("hermes")) {
    const alert = alertFromRow(row);
    try {
      const enqueuedAt = writeHermesOutbox(alert);
      database.prepare(`
        UPDATE security_alerts
        SET hermes_enqueued_at = ?, delivery_attempts = delivery_attempts + 1, last_error = NULL
        WHERE id = ?
      `).run(enqueuedAt, alert.id);
    } catch (error) {
      database.prepare(`
        UPDATE security_alerts
        SET delivery_attempts = delivery_attempts + 1, last_error = ?
        WHERE id = ?
      `).run(`Hermes outbox: ${error instanceof Error ? error.message : "failed"}`, alert.id);
    }
  }
  for (const row of queuedAlerts("push")) {
    const alert = alertFromRow(row);
    try {
      const result = await sendSecurityNotification(alert.title, alert.summary, alert.severity);
      if (result.sent > 0) {
        database.prepare("UPDATE security_alerts SET push_sent_at = ?, last_error = NULL WHERE id = ?")
          .run(Date.now(), alert.id);
      } else {
        database.prepare("UPDATE security_alerts SET last_error = ? WHERE id = ?")
          .run("Web Push: no registered device received the alert", alert.id);
      }
    } catch (error) {
      database.prepare("UPDATE security_alerts SET last_error = ? WHERE id = ?")
        .run(`Web Push: ${error instanceof Error ? error.message : "failed"}`, alert.id);
    }
  }
}
