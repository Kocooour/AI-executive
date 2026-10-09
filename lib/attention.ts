import type { Entity, Relation } from "./db";

export type AttentionRule = "deadline_overdue" | "deadline_soon" | "waiting_follow_up" | "project_no_next_action" | "project_idle";
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
  // 1 overdue, 2 due soon, 3 waiting, 4 project hygiene (README, Attention contract).
  severity: 1 | 2 | 3 | 4;
  reasonCode: AttentionRule;
  reason: string;
  reasonFacts: { deadlineAllDay?: boolean; lastActivityAt?: number; thresholdHours: number; waitingFor?: string; waitingSince?: number; followUpDate?: string };
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

function localDate(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
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
  function add(subject: Entity, ruleId: AttentionRule, severity: 1 | 2 | 3 | 4, relevantAt: number, relevantDate: string, reason: string, sources: Array<{ id: string; revision: number }>, confidence: AttentionItem["confidence"], reasonFacts: AttentionItem["reasonFacts"]) {
    const occurrence = ruleId.startsWith("deadline_") || ruleId === "waiting_follow_up" ? relevantAt.toString() : "current";
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
    const since = stamp(Number(task.properties.waitingSince)) ?? stamp(task.updatedAt);
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
      { thresholdHours: followUp ? 0 : 7 * 24, ...(waitingFor ? { waitingFor } : {}), ...(since !== null ? { waitingSince: since } : {}), ...(followUp ? { followUpDate: followUp } : {}) });
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
