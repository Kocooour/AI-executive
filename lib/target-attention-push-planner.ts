/**
 * R2d.5d.1 — pure, identity-bound per-user push planner (staging only).
 *
 * No database, no network, no clock: every input is passed in. It mirrors the
 * semantics of the legacy single-user `planAttentionPushes`
 * (lib/attention-notifications.ts) for ONE user:
 *  - only tasks with `deadline_overdue` / `deadline_soon` are announceable
 *    (never `planned_date_passed`, never projects);
 *  - nothing while push is off, the user paused, or inside the user's OWN quiet
 *    window evaluated in the user's stored time zone;
 *  - at most `dailyLimit` announcements per rolling 24 h (callers pass the
 *    count of delivered + in-flight ones);
 *  - order: severity, then relevantAt, then delivery key;
 *  - already handled keys (announced, baselined, given up, in flight) are skipped.
 *
 * Callers must pass ONLY the actor's ACTIVE-view candidates from
 * `readAuthorizedAttentionCandidatePage`. As defence in depth, a candidate whose
 * lifecycle is not "active" (snoozed/dismissed) is ignored here. Retry of a
 * failed delivery is expressed by the caller leaving the key out of `handled`
 * (legacy: failed with attempts < MAX_ATTEMPTS); the baseline on first enable is
 * the caller's job: record the current candidates as `baseline` and send nothing.
 */
import { createHash } from "node:crypto";
import type { AttentionCandidate, AttentionRuleId } from "./target-attention-read-model";

export const TARGET_ATTENTION_PUSH_RULES = ["deadline_overdue", "deadline_soon"] as const;
export type TargetAttentionPushRule = typeof TARGET_ATTENTION_PUSH_RULES[number];
export const TARGET_ATTENTION_PUSH_MAX_ATTEMPTS = 3;
const DAY = 24 * 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !DATE.test(v)) return false;
  const t = Date.parse(v + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The user's own notification settings (row of personal_notification_settings). */
export interface TargetNotificationSettings {
  timeZone: string;
  attentionPush: boolean | 0 | 1;
  quietStart: string;
  quietEnd: string;
  dailyLimit: number;
  paused: boolean | 0 | 1;
}

export interface PlannedTargetAttentionPush {
  deliveryKey: string;
  taskId: string;
  ruleId: TargetAttentionPushRule;
  occurrenceOn: string;
}
export type TargetAttentionPushHold = "quiet_hours" | "daily_limit" | "disabled" | null;

/**
 * Identity of one announcement: rule + task + occurrence date. Independent of
 * time zone, user, Area, title and revision; per-user uniqueness comes from the
 * (user_id, delivery_key) primary key, so the key never carries other users' data.
 */
export function targetAttentionDeliveryKey(ruleId: string, taskId: string, occurrenceOn: string): string {
  if (!(TARGET_ATTENTION_PUSH_RULES as readonly string[]).includes(ruleId) ||
      typeof taskId !== "string" || !taskId || !isDate(occurrenceOn))
    throw new TypeError("invalid attention delivery identity");
  return "tad1:" + createHash("sha256").update("lumi:r2d5:attention-delivery:v1\0")
    .update(JSON.stringify([ruleId, taskId, occurrenceOn])).digest("hex");
}

function localHhmm(nowMs: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB",
    { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

/** Quiet window [start, end) in the given zone; a window that wraps midnight is supported. Throws on a bad zone/format. */
export function inTargetQuietHours(nowMs: number, timeZone: string, start: string, end: string): boolean {
  if (!HHMM.test(start) || !HHMM.test(end) || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new TypeError("invalid quiet window");
  const time = localHhmm(nowMs, timeZone);
  return start <= end ? time >= start && time < end : time >= start || time < end;
}

const flag = (v: unknown) => v === true || v === 1;
export const announceableTargetAttentionCandidate = (c: AttentionCandidate): boolean => announceable(c);
const announceable = (c: AttentionCandidate) =>
  !!c && c.subjectType === "task" && c.lifecycle === "active" &&
  (TARGET_ATTENTION_PUSH_RULES as readonly string[]).includes(c.ruleId) &&
  typeof c.taskId === "string" && c.taskId.length > 0 &&
  isDate(c.relevantOn) &&
  Number.isFinite(c.relevantAt) && Number.isFinite(c.severity);

export function planTargetAttentionPushes(input: {
  candidates: readonly AttentionCandidate[];
  settings: TargetNotificationSettings;
  handled: ReadonlySet<string>;
  sentInLast24h: number;
  nowMs: number;
}): { send: PlannedTargetAttentionPush[]; held: TargetAttentionPushHold } {
  const s = input.settings;
  // Off, paused or malformed settings fail closed: nothing is ever sent.
  if (!s || !flag(s.attentionPush) || flag(s.paused)) return { send: [], held: "disabled" };
  if (typeof s.timeZone !== "string" || !HHMM.test(s.quietStart) || !HHMM.test(s.quietEnd) ||
      !Number.isInteger(s.dailyLimit) || s.dailyLimit < 0 || s.dailyLimit > 10 ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
      !Number.isSafeInteger(input.sentInLast24h) || input.sentInLast24h < 0)
    return { send: [], held: "disabled" };
  const seen = new Set<string>();
  const pending = input.candidates.filter(announceable).map(c => ({
    c, key: targetAttentionDeliveryKey(c.ruleId, c.taskId, c.relevantOn),
  })).filter(p => {
    if (input.handled.has(p.key) || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  }).sort((a, b) => a.c.severity - b.c.severity || a.c.relevantAt - b.c.relevantAt ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!pending.length) return { send: [], held: null };
  let quiet: boolean;
  try { quiet = inTargetQuietHours(input.nowMs, s.timeZone, s.quietStart, s.quietEnd); }
  catch { return { send: [], held: "disabled" }; }
  if (quiet) return { send: [], held: "quiet_hours" };
  const room = Math.max(0, s.dailyLimit - input.sentInLast24h);
  return {
    send: pending.slice(0, room).map(p => ({
      deliveryKey: p.key, taskId: p.c.taskId, ruleId: p.c.ruleId as TargetAttentionPushRule,
      occurrenceOn: p.c.relevantOn,
    })),
    held: pending.length > room ? "daily_limit" : null,
  };
}

/** Rolling-24 h window start for counting delivered/in-flight announcements. */
export const targetAttentionWindowStartMs = (nowMs: number) => nowMs - DAY;

/**
 * Lock-screen payload built from ONLY the recipient's own authorized candidate.
 * Owner decision 2026-10-07: a short title and the reason are shown, including
 * on the lock screen; here that is acceptable only because the candidate came
 * from the actor's own ACL-checked read and the payload goes to that actor's
 * own targets. No other user's or Area's data can enter: all fields derive from
 * the single candidate. Deadlines are calendar dates, formatted in UTC so no
 * zone can shift the day.
 */
export function targetAttentionPushPayload(candidate: AttentionCandidate):
  { title: string; body: string; url: string; tag: string } | null {
  if (!announceable(candidate)) return null;
  const when = new Intl.DateTimeFormat("cs-CZ", { timeZone: "UTC", day: "numeric", month: "numeric" })
    .format(new Date(`${candidate.relevantOn}T12:00:00Z`));
  const characters = Array.from(String(candidate.title || "").trim().replace(/\s+/g, " ")); // by code point
  const rule: AttentionRuleId = candidate.ruleId;
  return {
    title: characters.length > 80 ? `${characters.slice(0, 79).join("").trimEnd()}…` : characters.join(""),
    body: rule === "deadline_overdue" ? `Termín ${when} uplynul.` : `Termín ${when} je do 48 hodin.`,
    url: `/?task=${encodeURIComponent(candidate.taskId)}`,
    tag: `attention-${candidate.taskId}`,
  };
}
