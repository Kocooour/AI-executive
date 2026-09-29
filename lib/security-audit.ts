import { createHash } from "node:crypto";
import { getDatabase } from "./server-store";

const recentCoalescedEvents = new Map<string, number>();
const COALESCE_WINDOW_MS = 60_000;

function actorHash(_request: Request) {
  return createHash("sha256").update("single-owner").digest("hex").slice(0, 24);
}

export function recordSecurityEvent(
  request: Request,
  action: string,
  outcome: "allowed" | "rejected" | "failed",
  details: Record<string, unknown> = {},
) {
  try {
    const database = getDatabase();
    const safeDetails = JSON.stringify(details).slice(0, 2000);
    const actor = actorHash(request);
    const coalesce = outcome !== "allowed" || action.endsWith(".read");
    const coalesceKey = `${action}|${outcome}|${actor}|${safeDetails}`;
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
    database
      .prepare(
        "INSERT INTO security_events (created_at, action, outcome, actor_hash, details) VALUES (?, ?, ?, ?, ?)",
      )
      .run(now, action.slice(0, 120), outcome, actor, safeDetails);
    database.prepare(`
      DELETE FROM security_events
      WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT 1000)
    `).run();
  } catch (error) {
    console.error("Security audit logging failed", error);
  }
}
