/** Short-lived, bounded subprocesses keep synchronous staging reads off the HTTP event loop. */
import { spawn } from "node:child_process";
import path from "node:path";
import { logStagingFailure } from "./target-staging-failure-log";
import type { TargetStagingPersonalOffsetPage } from "./target-staging-session-authority";
import type {
  TargetReadableTask, TargetReadLinearization, TargetScopedReadableTask,
} from "./target-task-read-model";
import type { TargetPrivateProjectPage, TargetReadableProject } from "./target-project-read-model";
import type { TargetAuthorizedProjectTasksPage } from "./target-project-task-read-model";
import type { TargetAuthorizedProjectIndexPage, TargetProjectIndexScope } from "./target-authorized-project-index";
import { isReadableStagingProjectId } from "./target-project-id";
import type { TargetReadableNote } from "./target-note-access";
import type { TargetNoteReadLiveGuard } from "./target-staging-durable-session";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import { FEED_PAGE_LIMIT } from "./target-change-feed-read-model";
import { NOTE_SYNC_CURSOR_LENGTH } from "./target-note-sync-cursor";
import type { TargetNoteSyncPage } from "./target-note-sync-read-model";
import type { FeedItem, TargetChangeFeedPage } from "./target-change-feed-read-model";
import { validFeedClaims, validFeedPosition } from "./target-staging-feed-cursor";
import type { FeedClaims, FeedPosition } from "./target-staging-feed-cursor";

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REVISION = /^[a-f0-9]{64}$/;

export interface StagingPersonalReadConfig {
  stagingDirectory: string;
  expectedRestoreGeneration: string;
  ownerUserId: string;
  /**
   * SHA-256 hash of a durable staging session token (R2-ID.1). When present the
   * child resolves the actor from the LIVE session store instead of using
   * ownerUserId. The raw token never reaches a child process.
   */
  sessionTokenHash?: string;
  noteSyncSecret?: string;
}

/** Only the production-owned instance is used by HTTP handlers. Injection is for lifecycle tests. */
export function createStagingReadRunner(
  startChild: typeof spawn = spawn,
  timeoutMs = TIMEOUT_MS,
): (config: StagingPersonalReadConfig, scriptName: string, args: string[]) => Promise<unknown | null> {
  let active = 0;
  return async (config, scriptName, args) => {
    if (active >= MAX_CONCURRENT) {
      logStagingFailure("read_child", "concurrency_limit");
      return null;
    }
    active++;
    try {
      const cwd = process.cwd();
      const loader = path.join(cwd, "scripts/target-staging-ts-loader.mjs");
      const script = path.join(cwd, "scripts", scriptName);
      const environment = {
        NODE_ENV: process.env.NODE_ENV || "production",
        AI_EXECUTIVE_DATA_DIR: process.env.AI_EXECUTIVE_DATA_DIR || "",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: config.stagingDirectory,
        AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: config.expectedRestoreGeneration,
        AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: config.ownerUserId,
        AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH: config.sessionTokenHash || "",
        ...(config.noteSyncSecret ?
          { AI_EXECUTIVE_TARGET_STAGING_NOTE_SYNC_SECRET: config.noteSyncSecret } : {}),
      };
      return await new Promise<unknown | null>(resolve => {
        let child: ReturnType<typeof spawn>;
        try {
          child = startChild(process.execPath,
            ["--experimental-loader", loader, script, ...args],
            { cwd, env: environment, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        } catch (error) {
          logStagingFailure("read_child", "spawn_exception", error);
          resolve(null);
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        let failureReason: "timeout" | "output_limit" | "child_error" | null = null;
        const timer = setTimeout(() => {
          failureReason ??= "timeout";
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            failureReason ??= "output_limit";
            child.kill("SIGKILL");
          } else {
            chunks.push(chunk);
          }
        });
        child.on("error", () => { failureReason ??= "child_error"; });
        child.on("close", code => {
          clearTimeout(timer);
          if (failureReason !== null || code !== 0) {
            logStagingFailure("read_child", failureReason ?? "nonzero_exit");
            return resolve(null);
          }
          try {
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!payload || typeof payload !== "object") {
              logStagingFailure("read_child", "non_object_json");
              return resolve(null);
            }
            resolve(payload);
          } catch (error) {
            logStagingFailure("read_child", bytes === 0 ? "empty_stdout" : "invalid_json", error);
            resolve(null);
          }
        });
      });
    } finally {
      active--;
    }
  };
}

const runChild = createStagingReadRunner();

export type StagingNoteSyncResult =
  | { ok: true; page: TargetNoteSyncPage; epoch: number;
      stamp: { areaId: string; contentRevision: number; head: number } }
  | { ok: false; reason: "inaccessible" | "resync_required" | "unavailable" };
const noteSyncId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && value.isWellFormed() &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const noteSyncInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exact = (value: Record<string, unknown>, keys: string): boolean =>
  Object.keys(value).sort().join(",") === keys;

export function parseStagingNoteSyncResult(value: unknown, areaId: string, limit: number): StagingNoteSyncResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.ok === false) return exact(data, "ok,reason") &&
    (data.reason === "inaccessible" || data.reason === "resync_required" || data.reason === "unavailable")
    ? { ok: false, reason: data.reason } : null;
  if (data.ok !== true || !exact(data, "epoch,ok,page,stamp") || !noteSyncInt(data.epoch) ||
      !data.stamp || typeof data.stamp !== "object" || Array.isArray(data.stamp) ||
      !data.page || typeof data.page !== "object" || Array.isArray(data.page)) return null;
  const stamp = data.stamp as Record<string, unknown>;
  const page = data.page as Record<string, unknown>;
  if (!exact(stamp, "areaId,contentRevision,head") || stamp.areaId !== areaId ||
      !noteSyncInt(stamp.contentRevision) || !noteSyncInt(stamp.head) || stamp.head > stamp.contentRevision ||
      !exact(page, "changes,cursor,entries,linearization,more,phase") ||
      (page.phase !== "bootstrap" && page.phase !== "changes") ||
      !Array.isArray(page.entries) || !Array.isArray(page.changes) ||
      page.entries.length > limit || page.changes.length > limit ||
      (page.phase === "bootstrap" ? page.changes.length !== 0 : page.entries.length !== 0) ||
      typeof page.more !== "boolean" || typeof page.cursor !== "string" ||
      page.cursor.length !== NOTE_SYNC_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(page.cursor)) return null;
  const entries: TargetNoteSyncPage["entries"] = [];
  for (const input of page.entries) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const row = input as Record<string, unknown>;
    if (!exact(row, "id,parentRevision,projectId,revision") || !noteSyncId(row.id) ||
        !noteSyncInt(row.revision) || (row.projectId !== null && !noteSyncId(row.projectId)) ||
        (row.projectId === null ? row.parentRevision !== null : !noteSyncInt(row.parentRevision))) return null;
    entries.push({ id: row.id, revision: row.revision,
      projectId: row.projectId as string | null, parentRevision: row.parentRevision as number | null });
  }
  if (entries.some((entry, i) => i > 0 &&
      Buffer.compare(Buffer.from(entries[i - 1].id), Buffer.from(entry.id)) >= 0)) return null;
  const changes: TargetNoteSyncPage["changes"] = [];
  for (const input of page.changes) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const row = input as Record<string, unknown>;
    if (!exact(row, "kind,noteId,projectId,revision,seq") ||
        (row.kind !== "edit" && row.kind !== "delete") || !noteSyncId(row.noteId) ||
        (row.projectId !== null && !noteSyncId(row.projectId)) ||
        !noteSyncInt(row.revision) || row.revision < 1 ||
        !noteSyncInt(row.seq) || row.seq < 1 || row.seq > stamp.head ||
        (changes.length > 0 && row.seq !== changes[changes.length - 1].seq + 1)) return null;
    changes.push({ seq: row.seq, kind: row.kind, noteId: row.noteId,
      projectId: row.projectId as string | null, revision: row.revision });
  }
  if (page.more && (page.phase === "bootstrap" ? entries.length : changes.length) !== limit)
    return null;
  const linearization = parseLinearization(page.linearization, new Map());
  if (!linearization || linearization.areas.length !== 1 || linearization.areas[0]?.areaId !== areaId ||
      (linearization.areas[0]?.areaKind !== "private" && linearization.areas[0]?.areaKind !== "shared")) return null;
  return { ok: true, epoch: data.epoch, stamp: { areaId,
    contentRevision: stamp.contentRevision, head: stamp.head },
    page: { phase: page.phase, entries, changes, more: page.more,
      cursor: page.cursor, linearization } };
}

export async function readStagingNoteSyncInChild(config: StagingPersonalReadConfig,
  areaId: string, limit: number, cursor?: string): Promise<StagingNoteSyncResult | null> {
  const payload = await runChild(config, "target-staging-note-sync-child.mjs",
    [areaId, String(limit), cursor ?? "-"]);
  const result = parseStagingNoteSyncResult(payload, areaId, limit);
  if (payload !== null && !result) logStagingFailure("note_sync", "invalid_child_dto");
  return result;
}

/** The child is trusted code, but its serialized output is still an HTTP data boundary. */
export function parseStagingPersonalPage(value: unknown): TargetStagingPersonalOffsetPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (Object.keys(page).sort().join(",") !== "hasMore,ok,revision,tasks" ||
      page.ok !== true || !Array.isArray(page.tasks) || page.tasks.length > 100 ||
      typeof page.hasMore !== "boolean" ||
      typeof page.revision !== "string" || !REVISION.test(page.revision)) return null;
  const tasks: unknown[] = page.tasks;
  const validTask = (value: unknown): value is TargetReadableTask => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const task = value as Record<string, unknown>;
    return Object.keys(task).sort().join(",") ===
      "areaKind,assigneeUserId,effectiveAreaId,id,projectId,title" &&
      typeof task.id === "string" && typeof task.title === "string" &&
      (task.projectId === null || typeof task.projectId === "string") &&
      typeof task.effectiveAreaId === "string" && task.areaKind === "private" &&
      task.assigneeUserId === null;
  };
  if (!tasks.every(validTask)) return null;
  // Construct a fresh DTO so later internal fields cannot reach the HTTP boundary.
  return {
    hasMore: page.hasMore, revision: page.revision,
    tasks: tasks.map(task => ({
      id: task.id, title: task.title, projectId: task.projectId,
      effectiveAreaId: task.effectiveAreaId, areaKind: "private", assigneeUserId: null,
    })),
  };
}

export async function readStagingPersonalPageInChild(
  config: StagingPersonalReadConfig, limit: number, offset: number,
): Promise<TargetStagingPersonalOffsetPage | null> {
  const payload = await runChild(config, "target-staging-read-child.mjs", [String(limit), String(offset)]);
  const parsed = parseStagingPersonalPage(payload);
  if (payload !== null && !parsed) logStagingFailure("read_child", "invalid_personal_page_dto");
  return parsed;
}

export type StagingPersonalDetailResult =
  | { ok: true; task: TargetReadableTask; snapshotRevision: string }
  | { ok: false; reason: "unavailable" };

/** Strict child-to-HTTP DTO boundary, bound to the requested task ID. */
export function parseStagingPersonalDetail(
  value: unknown, taskId: string,
): StagingPersonalDetailResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.ok === false && result.reason === "unavailable" &&
      Object.keys(result).sort().join(",") === "ok,reason") return { ok: false, reason: "unavailable" };
  if (result.ok !== true || Object.keys(result).sort().join(",") !== "ok,snapshotRevision,task" ||
      typeof result.snapshotRevision !== "string" || !REVISION.test(result.snapshotRevision) ||
      !result.task || typeof result.task !== "object" || Array.isArray(result.task)) return null;
  const task = result.task as Record<string, unknown>;
  if (Object.keys(task).sort().join(",") !==
      "areaKind,assigneeUserId,effectiveAreaId,id,projectId,title" ||
      typeof task.id !== "string" || typeof task.title !== "string" ||
      typeof task.effectiveAreaId !== "string" || task.areaKind !== "private" ||
      task.assigneeUserId !== null || task.id !== taskId) return null;
  let projectId: string | null;
  if (task.projectId === null) projectId = null;
  else if (typeof task.projectId === "string") projectId = task.projectId;
  else return null;
  return { ok: true, snapshotRevision: result.snapshotRevision as string, task: {
    id: task.id, title: task.title, projectId,
    effectiveAreaId: task.effectiveAreaId, areaKind: "private", assigneeUserId: null,
  } };
}

export async function readStagingPersonalDetailInChild(
  config: StagingPersonalReadConfig, taskId: string,
): Promise<StagingPersonalDetailResult | null> {
  const payload = await runChild(config, "target-staging-detail-child.mjs", [taskId]);
  return parseStagingPersonalDetail(payload, taskId);
}

/** Strict content-free HTTP audit boundary. Never forward raw SQL rows,
 * task identifiers, titles, actor IDs, receipt keys or aggregate counts. */
export type StagingPrivateTaskAuditResult =
  | { ok: true; events: Array<{
    revisionBefore: number; revisionAfter: number; committedAtMs: number;
  }> }
  | { ok: false; reason: "unavailable" };

export function parseStagingPrivateTaskAudit(value: unknown): StagingPrivateTaskAuditResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.ok === false && result.reason === "unavailable" &&
      Object.keys(result).sort().join(",") === "ok,reason") {
    return { ok: false, reason: "unavailable" };
  }
  if (result.ok !== true || Object.keys(result).sort().join(",") !== "events,ok" ||
      !Array.isArray(result.events) || result.events.length > 50) return null;
  const events: Array<{ revisionBefore: number; revisionAfter: number; committedAtMs: number }> = [];
  for (const entry of result.events) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).sort().join(",") !== "committedAtMs,revisionAfter,revisionBefore" ||
        typeof e.revisionBefore !== "number" || !Number.isSafeInteger(e.revisionBefore) ||
        e.revisionBefore < 0 || typeof e.revisionAfter !== "number" ||
        !Number.isSafeInteger(e.revisionAfter) || e.revisionAfter !== e.revisionBefore + 1 ||
        typeof e.committedAtMs !== "number" ||
        !Number.isSafeInteger(e.committedAtMs) || e.committedAtMs <= 0) return null;
    events.push({
      revisionBefore: e.revisionBefore, revisionAfter: e.revisionAfter,
      committedAtMs: e.committedAtMs,
    });
  }
  return { ok: true, events };
}

export async function readStagingPrivateTaskAuditInChild(
  config: StagingPersonalReadConfig, taskId: string,
): Promise<StagingPrivateTaskAuditResult | null> {
  const value = await runChild(config, "target-staging-audit-child.mjs", [taskId]);
  return parseStagingPrivateTaskAudit(value);
}

/** Strict project DTO allowlist at the child-to-HTTP boundary. */
export function parseStagingPrivateProjectPage(value: unknown): TargetPrivateProjectPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (Object.keys(page).sort().join(",") !== "hasMore,ok,projects,revision" ||
      page.ok !== true || !Array.isArray(page.projects) || page.projects.length > 100 ||
      typeof page.hasMore !== "boolean" || typeof page.revision !== "string" ||
      !REVISION.test(page.revision)) return null;
  const validProject = (value: unknown): value is TargetReadableProject => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const project = value as Record<string, unknown>;
    return Object.keys(project).sort().join(",") === "areaId,areaKind,id,title" &&
      isReadableStagingProjectId(project.id) && typeof project.title === "string" &&
      typeof project.areaId === "string" && project.areaKind === "private";
  };
  if (!page.projects.every(validProject)) return null;
  return {
    hasMore: page.hasMore, revision: page.revision,
    projects: page.projects.map((project: TargetReadableProject) => ({
      id: project.id, title: project.title, areaId: project.areaId, areaKind: "private",
    })),
  };
}

export async function readStagingPrivateProjectPageInChild(
  config: StagingPersonalReadConfig, limit: number, offset: number,
): Promise<TargetPrivateProjectPage | null> {
  const payload = await runChild(config, "target-staging-projects-child.mjs", [String(limit), String(offset)]);
  return parseStagingPrivateProjectPage(payload);
}

export type StagingPrivateProjectDetailResult =
  | { ok: true; project: TargetReadableProject }
  | { ok: false; reason: "unavailable" };

/** Strict child DTO and request-ID binding at the HTTP boundary. */
export function parseStagingPrivateProjectDetail(
  value: unknown, projectId: string,
): StagingPrivateProjectDetailResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.ok === false && result.reason === "unavailable" &&
      Object.keys(result).sort().join(",") === "ok,reason") {
    return { ok: false, reason: "unavailable" };
  }
  if (result.ok !== true ||
      Object.keys(result).sort().join(",") !== "ok,project" ||
      !result.project || typeof result.project !== "object" ||
      Array.isArray(result.project)) return null;
  const project = result.project as Record<string, unknown>;
  if (Object.keys(project).sort().join(",") !== "areaId,areaKind,id,title" ||
      !isReadableStagingProjectId(project.id) || project.id !== projectId ||
      typeof project.title !== "string" ||
      typeof project.areaId !== "string" || project.areaKind !== "private") return null;
  return { ok: true, project: {
    id: project.id, title: project.title, areaId: project.areaId, areaKind: "private",
  } };
}

export async function readStagingPrivateProjectDetailInChild(
  config: StagingPersonalReadConfig, projectId: string,
): Promise<StagingPrivateProjectDetailResult | null> {
  const payload = await runChild(config, "target-staging-project-detail-child.mjs", [projectId]);
  return parseStagingPrivateProjectDetail(payload, projectId);
}


// ---------------------------------------------------------------------------
// R2-ID.2b shared / my-plan scopes. The child output is an HTTP data boundary:
// strict allowlists, no other user's ID, and the linearization record must
// describe exactly the Areas of the returned rows.
// ---------------------------------------------------------------------------

export type StagingScopedReadScope = "shared" | "my-plan";
const ACTOR_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const ACCESS = new Set(["private-owner", "viewer", "editor", "admin"]);

export interface StagingScopedPage {
  readonly tasks: TargetScopedReadableTask[];
  readonly hasMore: boolean;
  readonly revision: string;
  readonly linearization: TargetReadLinearization;
}

/** Hard staging limit: contributing Areas per scoped read (see docs/ARCHITECTURE.md, R2-ID.2b). */
export { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";

export function parseLinearization(
  value: unknown, rowAreas: Map<string, "private" | "shared">,
): TargetReadLinearization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "actorUserId,areas" ||
      typeof record.actorUserId !== "string" || !ACTOR_ID.test(record.actorUserId) ||
      !Array.isArray(record.areas) || record.areas.length > MAX_SCOPED_READ_AREAS) return null;
  const areas: TargetReadLinearization["areas"] = [];
  const seen = new Set<string>();
  for (const entry of record.areas) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const area = entry as Record<string, unknown>;
    if (Object.keys(area).sort().join(",") !== "access,areaId,areaKind,policyRevision" ||
        typeof area.areaId !== "string" || area.areaId.length === 0 || seen.has(area.areaId) ||
        typeof area.policyRevision !== "number" || !Number.isSafeInteger(area.policyRevision) ||
        area.policyRevision < 0 || typeof area.access !== "string" || !ACCESS.has(area.access) ||
        (area.areaKind !== "private" && area.areaKind !== "shared") ||
        // private-owner only with private Areas; viewer/editor/admin only with shared Areas.
        (area.areaKind === "private") !== (area.access === "private-owner") ||
        // A row's Area must be recorded with the very same kind.
        (rowAreas.has(area.areaId) && rowAreas.get(area.areaId) !== area.areaKind)) return null;
    seen.add(area.areaId);
    areas.push({
      areaId: area.areaId, areaKind: area.areaKind, policyRevision: area.policyRevision,
      access: area.access as TargetReadLinearization["areas"][number]["access"],
    });
  }
  // The record holds ALL Areas of the scope (look-ahead and revision Areas too); it must at
  // least contain every Area a released row comes from.
  if (![...rowAreas.keys()].every(id => seen.has(id))) return null;
  return { actorUserId: record.actorUserId, areas };
}

/** Allowlisted row DTO: shared rows carry assignedToMe, private rows never do. */
function parseScopedTask(value: unknown, scope: StagingScopedReadScope): TargetScopedReadableTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const shared = task.areaKind === "shared";
  const keys = "areaId,areaKind,effectiveAreaId,id,projectId,title" + (shared ? ",assignedToMe" : "");
  if (Object.keys(task).sort().join(",") !== keys.split(",").sort().join(",") ||
      typeof task.id !== "string" || typeof task.title !== "string" ||
      (task.projectId !== null && typeof task.projectId !== "string") ||
      typeof task.areaId !== "string" || task.effectiveAreaId !== task.areaId ||
      (task.areaKind !== "private" && task.areaKind !== "shared")) return null;
  if (shared && typeof task.assignedToMe !== "boolean") return null;
  if (scope === "shared" && !shared) return null;
  // my-plan carries shared tasks only when they are assigned to the actor.
  if (scope === "my-plan" && shared && task.assignedToMe !== true) return null;
  return {
    id: task.id, title: task.title, projectId: task.projectId as string | null,
    effectiveAreaId: task.areaId, areaId: task.areaId, areaKind: task.areaKind,
    ...(shared ? { assignedToMe: task.assignedToMe as boolean } : {}),
  };
}

export function parseStagingScopedPage(value: unknown, scope: StagingScopedReadScope): StagingScopedPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (Object.keys(page).sort().join(",") !== "hasMore,linearization,ok,revision,tasks" ||
      page.ok !== true || !Array.isArray(page.tasks) || page.tasks.length > 100 ||
      typeof page.hasMore !== "boolean" ||
      typeof page.revision !== "string" || !REVISION.test(page.revision)) return null;
  const tasks: TargetScopedReadableTask[] = [];
  for (const entry of page.tasks) {
    const task = parseScopedTask(entry, scope);
    if (!task) return null;
    tasks.push(task);
  }
  const linearization = parseLinearization(page.linearization, new Map(tasks.map(task => [task.areaId, task.areaKind] as const)));
  if (!linearization) return null;
  return { tasks, hasMore: page.hasMore, revision: page.revision, linearization };
}

export async function readStagingScopedPageInChild(
  config: StagingPersonalReadConfig, scope: StagingScopedReadScope, limit: number, offset: number,
): Promise<StagingScopedPage | null> {
  const payload = await runChild(config, "target-staging-scoped-read-child.mjs",
    [scope, String(limit), String(offset)]);
  return parseStagingScopedPage(payload, scope);
}

export type StagingTaskDetailResult =
  | StagingPersonalDetailResult
  | { ok: true; scope: "shared"; task: TargetScopedReadableTask; linearization: TargetReadLinearization;
      /** Present only for a current shared editor/admin (R2-ID.3). */
      snapshotRevision?: string };

/**
 * Detail child boundary. A private task keeps the exact legacy shape (with its
 * title CAS revision); a shared-Area task has one only for a current editor/admin (R2-ID.3).
 */
export function parseStagingTaskDetail(value: unknown, taskId: string): StagingTaskDetailResult | null {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).scope === "shared") {
    const result = value as Record<string, unknown>;
    const keys = Object.keys(result).sort().join(",");
    const withRevision = keys === "linearization,ok,scope,snapshotRevision,task";
    if ((keys !== "linearization,ok,scope,task" && !withRevision) || result.ok !== true) return null;
    const task = parseScopedTask(result.task, "shared");
    if (!task || task.id !== taskId) return null;
    const linearization = parseLinearization(result.linearization, new Map([[task.areaId, task.areaKind] as const]));
    if (!linearization) return null;
    if (!withRevision) return { ok: true, scope: "shared", task, linearization };
    // The CAS token is only ever issued to a current editor/admin of the Area.
    const access = linearization.areas[0]?.access;
    if (typeof result.snapshotRevision !== "string" || !REVISION.test(result.snapshotRevision) ||
        linearization.areas.length !== 1 || (access !== "editor" && access !== "admin")) return null;
    return { ok: true, scope: "shared", task, linearization, snapshotRevision: result.snapshotRevision };
  }
  return parseStagingPersonalDetail(value, taskId);
}

export async function readStagingTaskDetailInChild(
  config: StagingPersonalReadConfig, taskId: string,
): Promise<StagingTaskDetailResult | null> {
  const payload = await runChild(config, "target-staging-detail-child.mjs", [taskId]);
  return parseStagingTaskDetail(payload, taskId);
}


// ---------------------------------------------------------------------------
// R2c.2a bootstrap / Area bootstrap / change feed. Strict allowlists per item
// type at the child-to-HTTP boundary; the linearization record must contain
// every Area of a released upsert, with the very same kind.
// ---------------------------------------------------------------------------

export type StagingFeedResult =
  | TargetChangeFeedPage
  | { ok: false; reason: "cursor_invalid" | "resync_required" | "unavailable" };

const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const rev = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ROLE = (value: unknown): value is string =>
  value === "viewer" || value === "editor" || value === "admin";
const KIND = (value: unknown): value is "task" | "project" => value === "task" || value === "project";
const AREA_KIND = (value: unknown): value is "private" | "shared" => value === "private" || value === "shared";
const keysOf = (value: object): string => Object.keys(value).sort().join(",");

function parseFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = keysOf(item);
  switch (item.type) {
    case "upsert":
      if (item.kind === "task" && str(item.id) && rev(item.revision) && str(item.areaId) &&
          AREA_KIND(item.areaKind) && typeof item.title === "string" &&
          (item.projectId === null || str(item.projectId)) && item.effectiveAreaId === item.areaId) {
        const shared = item.areaKind === "shared";
        if (keys !== (shared ? "areaId,areaKind,assignedToMe,effectiveAreaId,id,kind,projectId,revision,title,type"
              : "areaId,areaKind,effectiveAreaId,id,kind,projectId,revision,title,type") ||
            (shared && typeof item.assignedToMe !== "boolean")) return null;
        return {
          type: "upsert", kind: "task", id: item.id, revision: item.revision, areaId: item.areaId,
          areaKind: item.areaKind, title: item.title, projectId: item.projectId as string | null,
          effectiveAreaId: item.areaId, ...(shared ? { assignedToMe: item.assignedToMe as boolean } : {}),
        };
      }
      if (item.kind === "project" && keys === "areaId,areaKind,id,kind,revision,title,type" &&
          str(item.id) && rev(item.revision) && str(item.areaId) && AREA_KIND(item.areaKind) &&
          typeof item.title === "string") {
        return { type: "upsert", kind: "project", id: item.id, revision: item.revision,
          areaId: item.areaId, areaKind: item.areaKind, title: item.title };
      }
      return null;
    case "left_scope":
      return keys === "areaId,id,kind,type" && KIND(item.kind) && str(item.id) && str(item.areaId)
        ? { type: "left_scope", kind: item.kind, id: item.id, areaId: item.areaId } : null;
    case "tombstone":
      return keys === "areaId,id,kind,revision,type" && KIND(item.kind) && str(item.id) &&
        str(item.areaId) && rev(item.revision)
        ? { type: "tombstone", kind: item.kind, id: item.id, areaId: item.areaId, revision: item.revision } : null;
    case "access_granted":
      return keys === "areaId,grantSeq,role,type" && str(item.areaId) && ROLE(item.role) &&
        typeof item.grantSeq === "number" && Number.isSafeInteger(item.grantSeq) && item.grantSeq > 0
        ? { type: "access_granted", areaId: item.areaId, role: item.role, grantSeq: item.grantSeq } : null;
    case "role_changed":
      return keys === "areaId,role,type" && str(item.areaId) && ROLE(item.role)
        ? { type: "role_changed", areaId: item.areaId, role: item.role } : null;
    case "access_lost":
      return keys === "areaId,type" && str(item.areaId) ? { type: "access_lost", areaId: item.areaId } : null;
    default:
      return null;
  }
}

export function parseStagingFeedResult(value: unknown): StagingFeedResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const page = value as Record<string, unknown>;
  if (page.ok === false) {
    return keysOf(page) === "ok,reason" &&
      (page.reason === "cursor_invalid" || page.reason === "resync_required" || page.reason === "unavailable")
      ? { ok: false, reason: page.reason } : null;
  }
  if (keysOf(page) !== "actorUserId,done,epoch,items,linearization,more,next,ok,phase" ||
      page.ok !== true || !ACTOR_ID.test(String(page.actorUserId)) || !rev(page.epoch) ||
      (page.phase !== "bootstrap" && page.phase !== "feed" && page.phase !== "area_bootstrap") ||
      typeof page.more !== "boolean" || typeof page.done !== "boolean" ||
      !Array.isArray(page.items) || page.items.length > FEED_PAGE_LIMIT ||
      (page.next !== null && !validFeedPosition(page.next)) ||
      // The next position must match the phase it continues from.
      (page.next === null) !== (page.phase === "area_bootstrap" && page.done === true)) return null;
  const items: FeedItem[] = [];
  const rowAreas = new Map<string, "private" | "shared">();
  for (const raw of page.items) {
    const item = parseFeedItem(raw);
    if (!item) return null;
    if (item.type === "upsert") {
      const seen = rowAreas.get(item.areaId);
      if (seen !== undefined && seen !== item.areaKind) return null;
      rowAreas.set(item.areaId, item.areaKind);
    }
    items.push(item);
  }
  // Per-phase allowlists: item types and the position the next cursor may continue from.
  const nextPh = page.next === null ? null : (page.next as FeedPosition).ph;
  const allowed = page.phase === "bootstrap" ? ["upsert", "access_lost"]
    : page.phase === "feed" ? null : ["upsert"];
  if (allowed && !items.every(item => allowed.includes(item.type))) return null;
  if (page.phase === "bootstrap" && nextPh !== "b" && nextPh !== "f") return null;
  if (page.phase === "feed" && nextPh !== "f") return null;
  if (page.phase === "area_bootstrap" && nextPh !== "a" && nextPh !== null) return null;
  const linearization = parseLinearization(page.linearization, rowAreas);
  if (!linearization || linearization.actorUserId !== page.actorUserId) return null;
  return {
    ok: true, phase: page.phase, items, more: page.more, done: page.done,
    next: page.next as TargetChangeFeedPage["next"], actorUserId: page.actorUserId as string,
    epoch: page.epoch, linearization,
  };
}

export async function readStagingFeedPageInChild(
  config: StagingPersonalReadConfig, claims: FeedClaims | null,
): Promise<StagingFeedResult | null> {
  if (claims !== null && !validFeedClaims(claims)) return null;
  const encoded = claims === null ? "-" : Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const payload = await runChild(config, "target-staging-feed-child.mjs", [encoded]);
  return parseStagingFeedResult(payload);
}


/** R2d.1a strict project+children subprocess boundary; all data is allowlisted. */
export type StagingProjectTasksResult =
  | { ok: true; page: TargetAuthorizedProjectTasksPage }
  | { ok: false; reason: "unavailable" };

export function parseStagingProjectTasks(
  value: unknown, projectId: string,
): StagingProjectTasksResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.ok === false && data.reason === "unavailable" &&
      Object.keys(data).sort().join(",") === "ok,reason") return { ok: false, reason: "unavailable" };
  if (data.ok !== true ||
      Object.keys(data).sort().join(",") !== "hasMore,linearization,ok,project,revision,tasks" ||
      !data.project || typeof data.project !== "object" || Array.isArray(data.project) ||
      !Array.isArray(data.tasks) || data.tasks.length > 100 ||
      typeof data.hasMore !== "boolean" || typeof data.revision !== "string" ||
      !REVISION.test(data.revision)) return null;
  const project = data.project as Record<string, unknown>;
  if (Object.keys(project).sort().join(",") !== "areaId,areaKind,id,title" ||
      !isReadableStagingProjectId(project.id) || project.id !== projectId ||
      typeof project.title !== "string" || typeof project.areaId !== "string" ||
      !project.areaId ||
      (project.areaKind !== "private" && project.areaKind !== "shared")) return null;
  const tasks: TargetScopedReadableTask[] = [];
  for (const item of data.tasks) {
    const task = parseScopedTask(item, project.areaKind === "shared" ? "shared" : "my-plan");
    if (!task || task.projectId !== projectId || task.areaId !== project.areaId ||
        task.areaKind !== project.areaKind) return null;
    tasks.push(task);
  }
  const linearization = parseLinearization(data.linearization,
    new Map([[project.areaId as string, project.areaKind]]));
  if (!linearization || linearization.areas.length !== 1 ||
      linearization.areas[0].areaId !== project.areaId) return null;
  return { ok: true, page: {
    project: { id: project.id, title: project.title, areaId: project.areaId,
      areaKind: project.areaKind },
    tasks, hasMore: data.hasMore, revision: data.revision, linearization,
  } };
}

export async function readStagingAuthorizedProjectTasksInChild(
  config: StagingPersonalReadConfig, projectId: string, limit: number, offset: number,
): Promise<StagingProjectTasksResult | null> {
  const payload = await runChild(config, "target-staging-project-tasks-child.mjs",
    [projectId, String(limit), String(offset)]);
  const result = parseStagingProjectTasks(payload, projectId);
  if (payload !== null && !result) logStagingFailure("project_tasks", "invalid_child_dto");
  return result;
}

/** R2d.1b strict child-to-HTTP boundary: no membership or account IDs in DTO. */
export function parseStagingAuthorizedProjectIndex(
  value: unknown, scope: TargetProjectIndexScope,
): TargetAuthorizedProjectIndexPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (scope !== "personal" && scope !== "shared")) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !==
        "guardProjects,hasMore,linearization,ok,projects,revision" ||
      data.ok !== true || !Array.isArray(data.projects) || data.projects.length > 100 ||
      !Array.isArray(data.guardProjects) || data.guardProjects.length > 101 ||
      data.guardProjects.length !== data.projects.length + (data.hasMore === true ? 1 : 0) ||
      typeof data.hasMore !== "boolean" || typeof data.revision !== "string" ||
      !REVISION.test(data.revision)) return null;
  const kind = scope === "personal" ? "private" : "shared";
  const projects: TargetAuthorizedProjectIndexPage["projects"] = [];
  const seen = new Set<string>();
  for (const input of data.projects) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const row = input as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "areaId,areaKind,id,title" ||
        !isReadableStagingProjectId(row.id) || seen.has(row.id) ||
        typeof row.title !== "string" || typeof row.areaId !== "string" ||
        !row.areaId || row.areaKind !== kind) return null;
    seen.add(row.id);
    projects.push({ id: row.id, title: row.title, areaId: row.areaId, areaKind: kind });
  }
  const guards: TargetAuthorizedProjectIndexPage["guardProjects"] = [];
  for (const input of data.guardProjects) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const row = input as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "areaId,id" ||
        !isReadableStagingProjectId(row.id) || typeof row.areaId !== "string" ||
        !row.areaId || guards.some(g => g.id === row.id)) return null;
    guards.push({ id: row.id, areaId: row.areaId });
  }
  if (projects.some((p, i) => p.id !== guards[i]?.id || p.areaId !== guards[i]?.areaId)) return null;
  const linearization = parseLinearization(data.linearization,
    new Map(guards.map(g => [g.areaId, kind] as const)));
  if (!linearization || linearization.areas.some(a => a.areaKind !== kind)) return null;
  return { projects, hasMore: data.hasMore, revision: data.revision,
    linearization, guardProjects: guards };
}

export async function readStagingAuthorizedProjectIndexInChild(
  config: StagingPersonalReadConfig, scope: TargetProjectIndexScope,
  limit: number, offset: number,
): Promise<TargetAuthorizedProjectIndexPage | null> {
  const payload = await runChild(config, "target-staging-project-index-child.mjs",
    [scope, String(limit), String(offset)]);
  const result = parseStagingAuthorizedProjectIndex(payload, scope);
  if (payload !== null && !result) logStagingFailure("project_index", "invalid_child_dto");
  return result;
}

/** R2d.2c.2c: strict note child-to-HTTP boundary. Internal guards never go to clients. */
export type StagingNoteDetailResult =
  | { ok: true; note: TargetReadableNote; linearization: TargetReadLinearization;
      guard: TargetNoteReadLiveGuard }
  | { ok: false; reason: "unavailable" };

const validNoteHttpId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." &&
  Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const validNoteRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseStagingNoteDetail(
  value: unknown, noteId: string,
): StagingNoteDetailResult | null {
  if (!validNoteHttpId(noteId) || !value || typeof value !== "object" || Array.isArray(value))
    return null;
  const data = value as Record<string, unknown>;
  if (data.ok === false && data.reason === "unavailable" &&
      Object.keys(data).sort().join(",") === "ok,reason") return { ok: false, reason: "unavailable" };
  if (data.ok !== true || Object.keys(data).sort().join(",") !== "guard,linearization,note,ok" ||
      !data.note || typeof data.note !== "object" || Array.isArray(data.note) ||
      !data.guard || typeof data.guard !== "object" || Array.isArray(data.guard)) return null;
  const n = data.note as Record<string, unknown>;
  const g = data.guard as Record<string, unknown>;
  if (Object.keys(n).sort().join(",") !== "areaId,areaKind,body,id,projectId,revision,title" ||
      Object.keys(g).sort().join(",") !==
        "areaId,noteId,noteRevision,parentRevision,projectId" ||
      n.id !== noteId || !validNoteHttpId(n.id) ||
      !validNoteHttpId(n.areaId) ||
      (n.areaKind !== "private" && n.areaKind !== "shared") ||
      (n.projectId !== null && !validNoteHttpId(n.projectId)) ||
      typeof n.title !== "string" || n.title.trim().length === 0 ||
      Buffer.byteLength(n.title, "utf8") > 4096 ||
      typeof n.body !== "string" || Buffer.byteLength(n.body, "utf8") > 131072 ||
      n.title.includes("\0") || n.body.includes("\0") ||
      !validNoteRevision(n.revision) ||
      g.noteId !== n.id || g.projectId !== n.projectId ||
      g.areaId !== n.areaId || g.noteRevision !== n.revision ||
      (n.projectId === null ? g.parentRevision !== null :
        !validNoteRevision(g.parentRevision))) return null;
  const linearization = parseLinearization(
    data.linearization, new Map([[n.areaId as string, n.areaKind]]),
  );
  if (!linearization || linearization.areas.length !== 1 ||
      linearization.areas[0]?.areaId !== n.areaId ||
      linearization.areas[0]?.areaKind !== n.areaKind) return null;
  return {
    ok: true,
    note: {
      id: n.id as string, title: n.title, body: n.body,
      projectId: n.projectId as string | null, areaId: n.areaId as string,
      areaKind: n.areaKind, revision: n.revision,
    },
    linearization,
    guard: {
      noteId: g.noteId as string, projectId: g.projectId as string | null,
      areaId: g.areaId as string, noteRevision: g.noteRevision as number,
      parentRevision: g.parentRevision as number | null,
    },
  };
}

export async function readStagingAuthorizedNoteInChild(
  config: StagingPersonalReadConfig, noteId: string,
): Promise<StagingNoteDetailResult | null> {
  const payload = await runChild(config, "target-staging-note-child.mjs", [noteId]);
  const parsed = parseStagingNoteDetail(payload, noteId);
  if (payload !== null && !parsed) logStagingFailure("note_detail", "invalid_child_dto");
  return parsed;
}
