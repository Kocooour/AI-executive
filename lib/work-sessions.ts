import { createHash, randomUUID } from "node:crypto";
import type { Entity } from "./db";
import { getDatabase } from "./server-store";
import { learnPlanning } from "./day-plan-learning";
import { getNotificationPreferences } from "./notifications";

export type WorkSessionState = "running" | "paused" | "completed";
export type WorkSessionAction = "start" | "pause" | "resume" | "finish";

export interface PublicWorkSession {
  id: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  state: WorkSessionState;
  revision: number;
  accumulatedMs: number;
  runningSince: number | null;
  elapsedMs: number;
  startedAt: number;
  completedAt: number | null;
  estimatedMinutes: number | null;
  overrun: boolean;
}

export class WorkSessionError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_transition") {
    super(message); this.status = status; this.code = code;
  }
}

type SessionRow = {
  id: string; workspace_id: string; task_id: string; state: WorkSessionState; revision: number;
  accumulated_ms: number; running_since: number | null; started_at: number; completed_at: number | null;
  estimated_minutes: number | null;
};

function validId(value: string, max = 240) {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9:_-]+$/.test(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) { return createHash("sha256").update(stable(value)).digest("hex"); }

function readTask(taskId: string) {
  const row = getDatabase().prepare("SELECT payload FROM entities WHERE id = ?").get(taskId) as { payload?: string } | undefined;
  return row?.payload ? JSON.parse(row.payload) as Entity : null;
}

function estimatedMinutesFor(task: Entity) {
  const database = getDatabase();
  const measured = measuredWorkHistory(task.workspaceId);
  const projects = new Map((database.prepare("SELECT payload FROM relations").all() as unknown as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as { workspaceId?: string; relationType?: string; sourceEntityId?: string; targetEntityId?: string })
    .filter((relation) => relation.workspaceId === task.workspaceId && relation.relationType === "belongs_to_project")
    .map((relation) => [String(relation.sourceEntityId), String(relation.targetEntityId)]));
  const peers = (database.prepare("SELECT payload FROM entities").all() as unknown as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Entity)
    .filter((entity) => entity.type === "task" && entity.workspaceId === task.workspaceId)
    .map((entity): Entity => ({ ...entity, properties: { ...entity.properties,
      projectId: projects.get(entity.id) || entity.properties.projectId,
      workSessionHistory: measured.get(entity.id) || [] } }));
  const current = peers.find((entity) => entity.id === task.id) || task;
  return learnPlanning(current, peers, getNotificationPreferences().timezone).estimatedMinutes;
}

function elapsed(row: SessionRow, now: number) {
  return Number(row.accumulated_ms) + (row.state === "running" && row.running_since !== null ? Math.max(0, now - Number(row.running_since)) : 0);
}

function localDate(now: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function moveDate(value: string, frequency: string, interval: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  if (frequency === "daily") date.setUTCDate(date.getUTCDate() + interval);
  else if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7 * interval);
  else if (frequency === "monthly") {
    const desired = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + interval);
    date.setUTCDate(Math.min(desired, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  } else if (frequency === "yearly") {
    const desired = date.getUTCDate(), month = date.getUTCMonth(); date.setUTCDate(1); date.setUTCFullYear(date.getUTCFullYear() + interval); date.setUTCMonth(month);
    date.setUTCDate(Math.min(desired, new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate()));
  } else return "";
  return date.toISOString().slice(0, 10);
}

function nextRecurringTask(task: Entity, now: number) {
  const raw = task.properties.recurrence || (task.properties.repeat ? { frequency: task.properties.repeat, interval: 1, mode: "scheduled" } : null);
  if (!raw || typeof raw !== "object") return null;
  const recurrence = raw as { frequency?: unknown; interval?: unknown; mode?: unknown };
  const interval = Math.max(1, Math.min(365, Math.round(Number(recurrence.interval) || 1)));
  const timezone = getNotificationPreferences().timezone;
  const base = recurrence.mode === "completion" ? localDate(now, timezone) : String(task.properties.when || localDate(now, timezone));
  const when = moveDate(base, String(recurrence.frequency || ""), interval);
  if (!when) return null;
  const seriesId = typeof task.properties.recurrenceSeriesId === "string" && task.properties.recurrenceSeriesId
    ? task.properties.recurrenceSeriesId : task.id;
  const properties = { ...task.properties, recurrenceSeriesId: seriesId, when, today: false, inbox: false,
    activity: [{ at: now, action: "created-recurring-occurrence" }] } as Record<string, unknown>;
  for (const key of ["completedAt", "actualMinutes", "workSessionHistory", "planningFeedback", "planningHistory", "plannedStart", "plannedEnd", "planningSource", "waiting", "waitingFor", "waitingSince", "followUpDate"]) delete properties[key];
  const reminder = Date.parse(String(task.properties.reminderAt || ""));
  if (Number.isFinite(reminder)) {
    const dayDelta = Math.round((Date.parse(`${when}T12:00:00Z`) - Date.parse(`${base}T12:00:00Z`)) / 86_400_000);
    properties.reminderAt = new Date(reminder + dayDelta * 86_400_000).toISOString();
  }
  const deadline = String(task.properties.deadline || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    const dayDelta = Math.round((Date.parse(`${when}T12:00:00Z`) - Date.parse(`${base}T12:00:00Z`)) / 86_400_000);
    properties.deadline = new Date(Date.parse(`${deadline}T12:00:00Z`) + dayDelta * 86_400_000).toISOString().slice(0, 10);
  }
  return { id: `${seriesId}:occurrence:${when}`, type: "task", title: task.title, status: "open", workspaceId: task.workspaceId,
    properties, createdAt: now, updatedAt: now } satisfies Entity;
}

function createRecurringOccurrence(task: Entity, now: number) {
  const next = nextRecurringTask(task, now);
  if (!next) return null;
  const database = getDatabase();
  if (database.prepare("SELECT 1 FROM tombstones WHERE id=?").get(next.id)) return null;
  const inserted = database.prepare("INSERT OR IGNORE INTO entities (id,payload,updated_at) VALUES (?,?,?)")
    .run(next.id, JSON.stringify(next), next.updatedAt);
  if (!Number(inserted.changes)) return next;
  const relations = database.prepare("SELECT payload FROM relations").all()
    .map((item) => JSON.parse(String((item as { payload: string }).payload)) as { sourceEntityId: string; targetEntityId: string; workspaceId: string; relationType: string })
    .filter((relation) => relation.sourceEntityId === task.id && relation.workspaceId === task.workspaceId);
  for (const relation of relations) {
    const copy = { ...relation, id: randomUUID(), sourceEntityId: next.id, createdAt: now };
    database.prepare("INSERT INTO relations (id,payload,created_at) VALUES (?,?,?)").run(copy.id, JSON.stringify(copy), now);
  }
  return next;
}

function publicSession(row: SessionRow, now = Date.now()): PublicWorkSession {
  const task = readTask(row.task_id);
  const estimated = Number(row.estimated_minutes);
  const estimatedMinutes = Number.isFinite(estimated) && estimated > 0 ? estimated : null;
  const elapsedMs = elapsed(row, now);
  return {
    id: row.id, workspaceId: row.workspace_id, taskId: row.task_id, taskTitle: task?.title || "Task",
    state: row.state, revision: Number(row.revision), accumulatedMs: Number(row.accumulated_ms),
    runningSince: row.running_since === null ? null : Number(row.running_since), elapsedMs,
    startedAt: Number(row.started_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
    estimatedMinutes, overrun: estimatedMinutes !== null && elapsedMs > estimatedMinutes * 60_000,
  };
}

export function measuredWorkHistory(workspaceId: string) {
  if (!validId(workspaceId, 120) || workspaceId === "all") return new Map<string, Array<Record<string, number | string>>>();
  const rows = getDatabase().prepare(`SELECT id,task_id,started_at,completed_at,accumulated_ms,estimated_minutes
    FROM work_sessions WHERE workspace_id=? AND state='completed' ORDER BY completed_at DESC LIMIT 1000`)
    .all(workspaceId) as unknown as Array<{ id: string; task_id: string; started_at: number; completed_at: number; accumulated_ms: number; estimated_minutes: number | null }>;
  const result = new Map<string, Array<Record<string, number | string>>>();
  for (const row of rows) {
    const history = result.get(row.task_id) || [];
    if (history.length >= 30) continue;
    history.push({ sessionId: row.id, startedAt: Number(row.started_at), completedAt: Number(row.completed_at),
      actualMs: Number(row.accumulated_ms), actualMinutes: Math.max(1, Math.round(Number(row.accumulated_ms) / 60_000)),
      ...(row.estimated_minutes ? { estimatedMinutes: Number(row.estimated_minutes) } : {}) });
    result.set(row.task_id, history);
  }
  return result;
}

function activeRow(workspaceId: string) {
  return getDatabase().prepare("SELECT * FROM work_sessions WHERE workspace_id = ? AND state IN ('running','paused') ORDER BY created_at DESC LIMIT 1")
    .get(workspaceId) as SessionRow | undefined;
}

export function getWorkSession(workspaceId: string) {
  if (!validId(workspaceId, 120) || workspaceId === "all") throw new WorkSessionError("Invalid workspace", 400, "invalid_workspace");
  const database = getDatabase();
  const workspace = database.prepare("SELECT 1 FROM entities WHERE id = ?").get(`workspace:${workspaceId}`);
  if (!workspace) throw new WorkSessionError("Workspace not found", 404, "workspace_not_found");
  const active = activeRow(workspaceId);
  const recent = database.prepare("SELECT * FROM work_sessions WHERE workspace_id = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 10")
    .all(workspaceId) as unknown as SessionRow[];
  return { active: active ? publicSession(active) : null, recent: recent.map((row) => publicSession(row, Number(row.completed_at) || Date.now())) };
}

function bumpStoreRevision(now: number) {
  const database = getDatabase();
  const current = Number((database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get() as { value?: string } | undefined)?.value || 0);
  const upsert = database.prepare("INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  upsert.run("revision", String(current + 1)); upsert.run("updatedAt", String(now));
}

function recordEvent(row: SessionRow, action: WorkSessionAction, from: string | null, now: number) {
  getDatabase().prepare(`INSERT INTO work_session_events
    (id,session_id,workspace_id,task_id,action,from_state,to_state,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), row.id, row.workspace_id, row.task_id, action, from, row.state, row.revision, now);
}

export function transitionWorkSession(input: {
  workspaceId: string; action: WorkSessionAction; idempotencyKey: string; taskId?: string;
  expectedTaskUpdatedAt?: number; expectedRevision: number; expectedState: "idle" | WorkSessionState;
}, clock = Date.now) {
  if (!validId(input.workspaceId, 120) || input.workspaceId === "all" || !validId(input.idempotencyKey, 200) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !["idle", "running", "paused", "completed"].includes(input.expectedState)) {
    throw new WorkSessionError("Invalid work session request", 400, "invalid_request");
  }
  const requestHash = hash(input);
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior = database.prepare("SELECT request_hash,result_payload FROM work_session_commands WHERE workspace_id=? AND idempotency_key=?")
      .get(input.workspaceId, input.idempotencyKey) as { request_hash: string; result_payload: string } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new WorkSessionError("Idempotency key was reused for another command", 409, "idempotency_conflict");
      database.exec("COMMIT");
      return JSON.parse(prior.result_payload) as { session: PublicWorkSession; taskCompleted: boolean; undoAvailable: false };
    }
    const now = clock();
    let taskCompleted = false;
    let row = activeRow(input.workspaceId);
    if (input.action === "start") {
      if (row) throw new WorkSessionError("Another task is already active. Finish it before starting a new one.", 409, "active_session_conflict");
      if (!input.taskId || !validId(input.taskId) || !Number.isSafeInteger(input.expectedTaskUpdatedAt)) throw new WorkSessionError("Task version is required", 400, "invalid_task");
      const task = readTask(input.taskId);
      if (!task || task.type !== "task" || task.workspaceId !== input.workspaceId || task.status !== "open") throw new WorkSessionError("Task is no longer available", 409, "task_changed");
      if (task.updatedAt !== input.expectedTaskUpdatedAt || input.expectedState !== "idle" || input.expectedRevision !== 0) throw new WorkSessionError("Task or work state changed; refresh and try again", 409, "stale_state");
      const id = randomUUID();
      const estimatedMinutes = estimatedMinutesFor(task);
      database.prepare(`INSERT INTO work_sessions
        (id,workspace_id,task_id,state,revision,accumulated_ms,running_since,started_at,estimated_minutes,created_at,updated_at)
        VALUES (?,?,?,'running',1,0,?,?,?,?,?)`).run(id, input.workspaceId, input.taskId, now, now, estimatedMinutes, now, now);
      database.prepare(`INSERT INTO work_session_intervals (id,session_id,workspace_id,task_id,started_at,created_at) VALUES (?,?,?,?,?,?)`)
        .run(randomUUID(), id, input.workspaceId, input.taskId, now, now);
      row = database.prepare("SELECT * FROM work_sessions WHERE id=?").get(id) as SessionRow;
      recordEvent(row, "start", null, now);
    } else {
      if (!row) throw new WorkSessionError("No active work session", 409, "no_active_session");
      if (row.revision !== input.expectedRevision || row.state !== input.expectedState) throw new WorkSessionError("Work state changed on another device; refreshed state is required", 409, "stale_state");
      const from = row.state;
      if (input.action === "pause") {
        if (row.state !== "running" || row.running_since === null) throw new WorkSessionError("Only a running task can be paused");
        const total = elapsed(row, now);
        database.prepare("UPDATE work_session_intervals SET ended_at=? WHERE session_id=? AND ended_at IS NULL").run(now, row.id);
        database.prepare("UPDATE work_sessions SET state='paused',revision=revision+1,accumulated_ms=?,running_since=NULL,updated_at=? WHERE id=?")
          .run(total, now, row.id);
      } else if (input.action === "resume") {
        if (row.state !== "paused") throw new WorkSessionError("Only a paused task can be resumed");
        database.prepare("UPDATE work_sessions SET state='running',revision=revision+1,running_since=?,updated_at=? WHERE id=?").run(now, now, row.id);
        database.prepare(`INSERT INTO work_session_intervals (id,session_id,workspace_id,task_id,started_at,created_at) VALUES (?,?,?,?,?,?)`)
          .run(randomUUID(), row.id, row.workspace_id, row.task_id, now, now);
      } else if (input.action === "finish") {
        if (row.state !== "running" && row.state !== "paused") throw new WorkSessionError("Only an active task can be finished");
        const total = elapsed(row, now);
        if (row.state === "running") database.prepare("UPDATE work_session_intervals SET ended_at=? WHERE session_id=? AND ended_at IS NULL").run(now, row.id);
        const task = readTask(row.task_id);
        if (task && (task.type !== "task" || task.workspaceId !== input.workspaceId || !["open", "completed"].includes(task.status))) throw new WorkSessionError("Task changed and cannot be completed safely", 409, "task_changed");
        const actualMinutes = Math.max(1, Math.round(total / 60_000));
        if (task) {
          const wasOpen = task.status === "open";
          const workHistory = Array.isArray(task.properties.workSessionHistory) ? task.properties.workSessionHistory : [];
          const activity = Array.isArray(task.properties.activity) ? task.properties.activity : [];
          const after: Entity = { ...task, status: "completed", updatedAt: now, properties: {
            ...task.properties, completedAt: task.properties.completedAt || now, actualMinutes,
            workSessionHistory: [...workHistory, { sessionId: row.id, startedAt: row.started_at, completedAt: now, actualMs: total, actualMinutes,
              ...(row.estimated_minutes ? { estimatedMinutes: Number(row.estimated_minutes) } : {}) }].slice(-30),
            activity: [...activity, { at: now, action: "completed-from-work-session", sessionId: row.id }].slice(-50),
          } };
          database.prepare("UPDATE entities SET payload=?,updated_at=? WHERE id=?").run(JSON.stringify(after), now, task.id);
          if (wasOpen) createRecurringOccurrence(task, now);
          taskCompleted = true;
        }
        database.prepare("UPDATE work_sessions SET state='completed',revision=revision+1,accumulated_ms=?,running_since=NULL,completed_at=?,updated_at=? WHERE id=?")
          .run(total, now, now, row.id);
        if (task) bumpStoreRevision(now);
      } else throw new WorkSessionError("Unknown work session action");
      row = database.prepare("SELECT * FROM work_sessions WHERE id=?").get(row.id) as SessionRow;
      recordEvent(row, input.action, from, now);
    }
    const result = { session: publicSession(row!, now), taskCompleted, undoAvailable: false as const };
    database.prepare("INSERT INTO work_session_commands (workspace_id,idempotency_key,request_hash,result_payload,created_at) VALUES (?,?,?,?,?)")
      .run(input.workspaceId, input.idempotencyKey, requestHash, JSON.stringify(result), now);
    database.prepare(`DELETE FROM work_session_commands WHERE workspace_id=? AND rowid NOT IN
      (SELECT rowid FROM work_session_commands WHERE workspace_id=? ORDER BY created_at DESC LIMIT 500)`).run(input.workspaceId, input.workspaceId);
    database.prepare(`DELETE FROM work_session_events WHERE workspace_id=? AND rowid NOT IN
      (SELECT rowid FROM work_session_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 500)`).run(input.workspaceId, input.workspaceId);
    const expired = database.prepare(`SELECT id FROM work_sessions WHERE workspace_id=? AND state='completed'
      ORDER BY completed_at DESC LIMIT -1 OFFSET 1000`).all(input.workspaceId) as unknown as Array<{ id: string }>;
    for (const item of expired) database.prepare("DELETE FROM work_session_intervals WHERE session_id=?").run(item.id);
    database.prepare(`DELETE FROM work_sessions WHERE workspace_id=? AND state='completed' AND id IN
      (SELECT id FROM work_sessions WHERE workspace_id=? AND state='completed' ORDER BY completed_at DESC LIMIT -1 OFFSET 1000)`)
      .run(input.workspaceId, input.workspaceId);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
