import { createHmac, randomUUID } from "node:crypto";
import { trustedClientIdentity } from "./http-security";
import { evaluateSecuritySignal } from "./security-monitor";
import { getDatabase } from "./server-store";

const recentCoalescedEvents = new Map<string, number>();
const COALESCE_WINDOW_MS = 60_000;

function actorHash(request: Request) {
  const key =
    process.env.AI_EXECUTIVE_AUDIT_KEY ||
    process.env.AI_EXECUTIVE_SESSION_SECRET ||
    "development-only-audit-key";
  return createHmac("sha256", key)
    .update(trustedClientIdentity(request))
    .digest("hex")
    .slice(0, 24);
}

export function recordSecurityEvent(
  request: Request,
  action: string,
  outcome: "allowed" | "rejected" | "failed",
  details: Record<string, unknown> = {},
) {
  try {
    const database = getDatabase();
    const pathname = (() => {
      try {
        return new URL(request.url).pathname.slice(0, 200);
      } catch {
        return "/unknown";
      }
    })();
    const enrichedDetails = {
      ...details,
      requestId: randomUUID(),
      method: request.method.slice(0, 12),
      path: pathname,
    };
    const safeDetails = JSON.stringify(enrichedDetails).slice(0, 2000);
    const actor = actorHash(request);
    const coalesce = outcome === "allowed" && action.endsWith(".read");
    const coalesceKey = `${action}|${outcome}|${actor}|${request.method}|${pathname}|${JSON.stringify(details)}`;
    const now = Date.now();
    if (coalesce && (recentCoalescedEvents.get(coalesceKey) || 0) > now - COALESCE_WINDOW_MS) {
      return;
    }
    if (coalesce) {
      recentCoalescedEvents.set(coalesceKey, now);
      if (recentCoalescedEvents.size > 500) {
        for (const [key, createdAt] of recentCoalescedEvents) {
          if (createdAt <= now - COALESCE_WINDOW_MS) recentCoalescedEvents.delete(key);
        }
      }
    }
    const inserted = database
      .prepare(
        "INSERT INTO security_events (created_at, action, outcome, actor_hash, details) VALUES (?, ?, ?, ?, ?)",
      )
      .run(now, action.slice(0, 120), outcome, actor, safeDetails);
    database.prepare(`
      DELETE FROM security_events
      WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT 1000)
    `).run();
    evaluateSecuritySignal({
      id: Number(inserted.lastInsertRowid),
      createdAt: now,
      action: action.slice(0, 120),
      outcome,
      actorHash: actor,
      details: enrichedDetails,
    });
  } catch (error) {
    console.error("Security audit logging failed", error);
  }
}
