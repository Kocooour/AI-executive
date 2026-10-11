import { createHash } from "node:crypto";
import type { AttentionItem } from "./attention";
import { getDatabase } from "./server-store";

export type AttentionState = "active" | "snoozed" | "dismissed" | "resolved" | "superseded";
export type VisibleAttentionItem = AttentionItem & { sourceFingerprint: string; lifecycleState: "active" };
interface StateRow {
  workspace_id: string;
  attention_key: string;
  subject_id: string;
  rule_id: string;
  state: AttentionState;
  source_fingerprint: string;
  snooze_until: number | null;
  changed_at: number;
}

export function attentionFingerprint(item: AttentionItem): string {
  const revisions = Object.entries(item.sourceRevisions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify([item.attentionKey, item.ruleVersion, revisions])).digest("hex");
}

function transition(item: AttentionItem, previous: StateRow | undefined, state: AttentionState, fingerprint: string, snoozeUntil: number | null, reason: string, now: number) {
  const database = getDatabase();
  if (previous && previous.state === state && previous.source_fingerprint === fingerprint && previous.snooze_until === snoozeUntil) return;
  database.prepare(`INSERT INTO attention_states (workspace_id, attention_key, subject_id, rule_id, state, source_fingerprint, snooze_until, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, attention_key) DO UPDATE SET subject_id=excluded.subject_id, rule_id=excluded.rule_id,
    state=excluded.state, source_fingerprint=excluded.source_fingerprint, snooze_until=excluded.snooze_until, changed_at=excluded.changed_at`)
    .run(item.workspaceId, item.attentionKey, item.subjectId, item.ruleId, state, fingerprint, snoozeUntil, now);
  database.prepare(`INSERT INTO attention_history (workspace_id, attention_key, from_state, to_state, reason, source_fingerprint, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(item.workspaceId, item.attentionKey, previous?.state || null, state, reason, fingerprint, now);
}

function transitionMissing(previous: StateRow, state: "resolved" | "superseded", now: number) {
  const database = getDatabase();
  database.prepare("UPDATE attention_states SET state=?, snooze_until=NULL, changed_at=? WHERE workspace_id=? AND attention_key=?")
    .run(state, now, previous.workspace_id, previous.attention_key);
  database.prepare(`INSERT INTO attention_history (workspace_id, attention_key, from_state, to_state, reason, source_fingerprint, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(previous.workspace_id, previous.attention_key, previous.state, state,
      state === "superseded" ? "occurrence_replaced" : "condition_ended", previous.source_fingerprint, now);
}

const datedRules = new Set(["deadline", "waiting_follow_up", "planned_date_passed"]);

export function reconcileAttention(workspaceId: string, candidates: AttentionItem[], now: number, ongoing: Set<string> = new Set()) {
  const database = getDatabase();
  const rows = database.prepare("SELECT * FROM attention_states WHERE workspace_id=?").all(workspaceId) as unknown as StateRow[];
  const byKey = new Map(rows.map((row) => [row.attention_key, row]));
  const currentKeys = new Set(candidates.map((candidate) => candidate.attentionKey));
  const visible: VisibleAttentionItem[] = [];
  const hidden = { snoozed: 0, dismissed: 0 };
  for (const candidate of candidates) {
    if (candidate.workspaceId !== workspaceId) throw new Error("Attention workspace mismatch");
    const fingerprint = attentionFingerprint(candidate);
    const previous = byKey.get(candidate.attentionKey);
    let state = previous?.state || "active";
    if (!previous) transition(candidate, undefined, "active", fingerprint, null, "detected", now);
    else if (previous.source_fingerprint !== fingerprint) {
      transition(candidate, previous, "active", fingerprint, null, "source_changed", now);
      state = "active";
    } else if (state === "snoozed" && (previous.snooze_until === null || previous.snooze_until <= now)) {
      transition(candidate, previous, "active", fingerprint, null, "snooze_expired", now);
      state = "active";
    } else if (state === "resolved" || state === "superseded") {
      transition(candidate, previous, "active", fingerprint, null, "condition_returned", now);
      state = "active";
    }
    if (state === "active") visible.push({ ...candidate, sourceFingerprint: fingerprint, lifecycleState: "active" });
    else if (state === "snoozed" || state === "dismissed") hidden[state] += 1;
  }
  for (const previous of rows) {
    if (currentKeys.has(previous.attention_key) || previous.state === "resolved" || previous.state === "superseded") continue;
    // A changed deadline, follow-up date or planned date replaces the item of the old date.
    const family = (rule: string) => (rule.startsWith("deadline_") ? "deadline" : rule);
    const replacement = candidates.some((candidate) => candidate.subjectId === previous.subject_id && datedRules.has(family(candidate.ruleId)) && family(candidate.ruleId) === family(previous.rule_id))
      // A follow-up moved to a later date (or cleared) of a task that still waits replaces the old
      // one too, even though the new one is not due yet.
      || ((previous.rule_id === "waiting_follow_up" || previous.rule_id === "planned_date_passed") && ongoing.has(`${previous.rule_id}:${previous.subject_id}`));
    transitionMissing(previous, replacement ? "superseded" : "resolved", now);
  }
  return { items: visible, hidden };
}

export function setAttentionState(item: AttentionItem, action: "snooze" | "dismiss", expectedFingerprint: string, until: number | null, now: number) {
  const fingerprint = attentionFingerprint(item);
  if (expectedFingerprint !== fingerprint) throw new Error("Attention item changed; refresh and try again");
  const previous = getDatabase().prepare("SELECT * FROM attention_states WHERE workspace_id=? AND attention_key=?")
    .get(item.workspaceId, item.attentionKey) as unknown as StateRow | undefined;
  if (previous?.source_fingerprint !== fingerprint || previous.state !== "active") throw new Error("Attention item is no longer active; refresh and try again");
  if (action === "snooze") {
    if (!Number.isSafeInteger(until) || until! <= now || until! > now + 30 * 24 * 3_600_000) throw new Error("Snooze time is invalid");
    transition(item, previous, "snoozed", fingerprint, until, "user_snoozed", now);
  } else {
    transition(item, previous, "dismissed", fingerprint, null, "user_dismissed", now);
  }
}
