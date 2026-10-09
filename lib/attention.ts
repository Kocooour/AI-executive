import type { Entity, Relation } from "./db";

export type AttentionRule = "deadline_overdue" | "deadline_soon" | "waiting_follow_up" | "planned_date_passed" | "project_no_next_action" | "project_idle";
export interface AttentionClaimActivity {
  id: string;
  workspaceId: string;
  projectId: string;
  predicate: string;
  revision: number;
  updatedAt: number;
  confirmed: boolean;
  current: boolean;
}
export interface AttentionItem {
  attentionKey: string;
  workspaceId: string;
  subjectType: "task" | "project";
  subjectId: string;
  title: string;
  ruleId: AttentionRule;
  ruleVersion: 1;
  // 1 overdue, 2 due soon, 3 waiting, 4 planned date passed and project hygiene (README, Attention
  // contract).
  severity: 1 | 2 | 3 | 4;
  reasonCode: AttentionRule;
  reason: string;
  reasonFacts: { deadlineAllDay?: boolean; lastActivityAt?: number; thresholdHours: number; waitingFor?: string; waitingSince?: number; followUpDate?: string; plannedDate?: string };
  relevantAt: number;
  relevantDate: string;
  timezone: string;
  confidence: "confirmed" | "limited";
  sourceIds: string[];
  sourceRevisions: Record<string, number>;
  evaluatedDataRevision: number;
  evaluatedAt: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(date: string): boolean {
  if (!datePattern.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  return Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === date;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function localDate(at: number, timezone: string): string {
  let format = dateFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormats.set(timezone, format);
  }
  const parts = format.formatToParts(at);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function endOfLocalDate(date: string, timezone: string): number | null {
  if (!validDate(date)) return null;
  const nominal = Date.parse(`${date}T00:00:00Z`);
  let lo = nominal - 2 * DAY;
  let hi = nominal + 2 * DAY;
  // First millisecond of the following local day, including DST transitions.
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDate(mid, timezone) > date) hi = mid;
    else lo = mid + 1;
  }
  return localDate(lo - 1, timezone) === date ? lo : null;
}

// The first millisecond of a local date.
function startOfLocalDate(date: string, timezone: string): number | null {
  if (!validDate(date)) return null;
  const previous = new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  return endOfLocalDate(previous, timezone);
}

function deadline(value: unknown, timezone: string): { at: number; date: string; allDay: boolean } | null {
  if (typeof value !== "string") return null;
  if (datePattern.test(value)) {
    const at = endOfLocalDate(value, timezone);
    return at === null ? null : { at, date: value, allDay: true };
  }
  const match = instantPattern.exec(value);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || "0") > 59) return null;
  if (match[5] !== "Z" && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4, 6)) > 59)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? { at, date: localDate(at, timezone), allDay: false } : null;
}

function stamp(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function key(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(":");
}

function priority(item: AttentionItem, entityById: Map<string, Entity>): number {
  const value = entityById.get(item.subjectId)?.properties.priority;
  return ({ high: 0, medium: 1, low: 2, none: 3 } as Record<string, number>)[String(value || "none")] ?? 3;
}

// Waiting tasks whose follow-up is not due (yet): an item of an earlier follow-up date of such a
// task was replaced by the new date, not ended (lib/attention-lifecycle.ts).
export function waitingSubjects(entities: Entity[], workspaceId: string): Set<string> {
  return new Set(entities.filter((entity) => entity.workspaceId === workspaceId && entity.type === "task" && entity.status === "open" && entity.properties.waiting === true).map((entity) => entity.id));
}

export function evaluateAttention(input: {
  entities: Entity[];
  relations: Relation[];
  claims?: AttentionClaimActivity[];
  workspaceId: string;
  timezone: string;
  evaluatedAt: number;
  dataRevision: number;
}): AttentionItem[] {
  const { workspaceId, timezone, evaluatedAt, dataRevision } = input;
  if (!Number.isFinite(evaluatedAt) || !Number.isSafeInteger(dataRevision) || dataRevision < 0) throw new Error("Invalid attention evaluation");
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  const entities = input.entities.filter((entity) => entity.workspaceId === workspaceId);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const relations = input.relations.filter((relation) => relation.workspaceId === workspaceId && relation.relationType === "belongs_to_project" && entityById.has(relation.sourceEntityId) && entityById.has(relation.targetEntityId));
  const claims = (input.claims || []).filter((claim) => claim.workspaceId === workspaceId && claim.confirmed && entityById.get(claim.projectId)?.type === "project");
  const output: AttentionItem[] = [];
  function add(subject: Entity, ruleId: AttentionRule, severity: 1 | 2 | 3 | 4, relevantAt: number, relevantDate: string, reason: string, sources: Array<{ id: string; revision: number }>, confidence: AttentionItem["confidence"], reasonFacts: AttentionItem["reasonFacts"], occurrenceKey?: string) {
    const occurrence = occurrenceKey ?? (ruleId.startsWith("deadline_") ? relevantAt.toString() : "current");
    output.push({
      attentionKey: key(workspaceId, ruleId, "v1", subject.id, occurrence), workspaceId,
      subjectType: subject.type as "task" | "project", subjectId: subject.id, title: subject.title,
      ruleId, ruleVersion: 1, severity, reasonCode: ruleId, reason, reasonFacts, relevantAt, relevantDate, timezone,
      confidence, sourceIds: sources.map((source) => source.id).sort(),
      sourceRevisions: Object.fromEntries(sources.map((source) => [source.id, source.revision])),
      evaluatedDataRevision: dataRevision, evaluatedAt,
    });
  }
  for (const task of entities) {
    if (task.type !== "task" || task.status !== "open") continue;
    const due = deadline(task.properties.deadline, timezone);
    if (!due) continue;
    const overdue = due.allDay ? evaluatedAt >= due.at : evaluatedAt > due.at;
    const delta = due.at - evaluatedAt;
    if (overdue) add(task, "deadline_overdue", 1, due.at, due.date,
      `Deadline ${due.date} (${timezone}) has passed${due.allDay ? " at the end of its local day" : ""}.`, [{ id: task.id, revision: task.updatedAt }], "confirmed", { deadlineAllDay: due.allDay, thresholdHours: 0 });
    else if (delta >= 0 && delta <= 48 * HOUR) add(task, "deadline_soon", 2, due.at, due.date,
      `Deadline ${due.date} (${timezone}) is within 48 hours.`, [{ id: task.id, revision: task.updatedAt }], "confirmed", { deadlineAllDay: due.allDay, thresholdHours: 48 });
  }
  // Waiting for someone or something: the follow-up date has come, or without a date a week has
  // passed since the task was marked as waiting. A change of the date is a new occurrence.
  for (const task of entities) {
    if (task.type !== "task" || task.status !== "open" || task.properties.waiting !== true) continue;
    const waitingFor = typeof task.properties.waitingFor === "string" ? task.properties.waitingFor.slice(0, 120) : "";
    const followUp = typeof task.properties.followUpDate === "string" && validDate(task.properties.followUpDate) ? task.properties.followUpDate : "";
    // When the task was marked as waiting. It is written together with the task, so it cannot be
    // later than the task's own time; a value that is (edited data) falls back to when the task
    // was created. The bound is the record's time, not the clock, so the answer does not change
    // while the task stays as it is.
    const marked = Number(task.properties.waitingSince);
    const since = (Number.isSafeInteger(marked) && marked > 0 && marked <= task.updatedAt ? marked : null) ?? stamp(task.createdAt) ?? stamp(task.updatedAt);
    let relevantAt: number | null = null;
    let relevantDate = "";
    if (followUp) {
      const start = startOfLocalDate(followUp, timezone);
      if (start !== null && evaluatedAt >= start) { relevantAt = start; relevantDate = followUp; }
    } else if (since !== null && evaluatedAt - since >= 7 * DAY) {
      relevantAt = since + 7 * DAY;
      relevantDate = localDate(relevantAt, timezone);
    }
    if (relevantAt === null) continue;
    add(task, "waiting_follow_up", 3, relevantAt, relevantDate,
      followUp ? `Follow-up date ${followUp} (${timezone}) has come${waitingFor ? ` (waiting for: ${waitingFor})` : ""}.`
        : `Waiting for at least 7 days${waitingFor ? ` (waiting for: ${waitingFor})` : ""} without a follow-up date.`,
      [{ id: task.id, revision: task.updatedAt }], "confirmed",
      { thresholdHours: followUp ? 0 : 7 * 24, ...(waitingFor ? { waitingFor } : {}), ...(since !== null ? { waitingSince: since } : {}), ...(followUp ? { followUpDate: followUp } : {}) },
      // Keyed by the date itself (not its instant), so a change of time zone does not bring a
      // dismissed item back.
      followUp ? `date-${followUp}` : `since-${since}`);
  }
  // The day a task was planned for ("when") has passed and the task is still open (owner decision
  // 2026-10-09). Not for a task that already has a deadline item, waits for someone, or is set
  // aside for someday. A new date is a new occurrence.
  const withDeadlineItem = new Set(output.filter((item) => item.ruleId.startsWith("deadline_")).map((item) => item.subjectId));
  for (const task of entities) {
    if (task.type !== "task" || task.status !== "open" || withDeadlineItem.has(task.id)) continue;
    if (task.properties.waiting === true || task.properties.someday === true) continue;
    const planned = typeof task.properties.when === "string" && validDate(task.properties.when) ? task.properties.when : "";
    const passedAt = planned ? endOfLocalDate(planned, timezone) : null;
    if (passedAt === null || evaluatedAt < passedAt) continue;
    add(task, "planned_date_passed", 4, passedAt, planned,
      `Planned date ${planned} (${timezone}) has passed and the task is still open.`,
      [{ id: task.id, revision: task.updatedAt }], "confirmed", { thresholdHours: 0, plannedDate: planned }, `date-${planned}`);
  }
  for (const project of entities) {
    if (project.type !== "project" || project.status !== "active") continue;
    const linked = relations.filter((relation) => relation.targetEntityId === project.id);
    const tasks = linked.map((relation) => entityById.get(relation.sourceEntityId)).filter((entity): entity is Entity => entity?.type === "task");
    const legacyTasks = entities.filter((entity) => entity.type === "task" && entity.properties.projectId === project.id && !tasks.some((task) => task.id === entity.id));
    const projectTasks = [...tasks, ...legacyTasks];
    if (projectTasks.length === 0 && !deadline(project.properties.deadline, timezone)) continue;
    const projectClaims = claims.filter((claim) => claim.projectId === project.id);
    const sources = [{ id: project.id, revision: project.updatedAt },
      ...projectTasks.map((task) => ({ id: task.id, revision: task.updatedAt })),
      ...linked.map((relation) => ({ id: relation.id, revision: relation.createdAt })),
      ...projectClaims.map((claim) => ({ id: `claim:${claim.id}`, revision: claim.revision }))];
    const timestamps = [project.createdAt, project.updatedAt, ...projectTasks.map((task) => task.updatedAt), ...linked.map((relation) => relation.createdAt), ...projectClaims.map((claim) => claim.updatedAt)]
      .map(stamp).filter((value): value is number => value !== null && value <= evaluatedAt);
    if (!timestamps.length) continue;
    const lastActivity = Math.max(...timestamps);
    const hasAction = projectTasks.some((task) => task.status === "open" && task.properties.someday !== true && task.properties.waiting !== true && task.properties.blocked !== true);
    const explicitWaiting = project.properties.waiting === true || projectClaims.some((claim) => claim.current && claim.predicate === "waiting_for");
    if (!hasAction && !explicitWaiting && evaluatedAt - lastActivity >= DAY) {
      add(project, "project_no_next_action", 4, lastActivity + DAY, localDate(lastActivity + DAY, timezone),
        `No open actionable task linked to this project for at least 24 hours (last recorded change ${new Date(lastActivity).toISOString()}).`, sources, "limited", { lastActivityAt: lastActivity, thresholdHours: 24 });
    }
    if (evaluatedAt - lastActivity >= 14 * DAY) {
      add(project, "project_idle", 4, lastActivity + 14 * DAY, localDate(lastActivity + 14 * DAY, timezone),
        `No recorded project, linked task, or confirmed context activity for at least 14 days (last recorded change ${new Date(lastActivity).toISOString()}).`, sources, "limited", { lastActivityAt: lastActivity, thresholdHours: 14 * 24 });
    }
  }
  return output.sort((a, b) => a.severity - b.severity || a.relevantAt - b.relevantAt || priority(a, entityById) - priority(b, entityById) || (a.attentionKey < b.attentionKey ? -1 : a.attentionKey > b.attentionKey ? 1 : 0));
}
