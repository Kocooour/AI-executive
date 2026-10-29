/** Short-lived, bounded subprocesses keep synchronous staging reads off the HTTP event loop. */
import { spawn } from "node:child_process";
import path from "node:path";
import type { TargetStagingPersonalOffsetPage } from "./target-staging-session-authority";
import type {
  TargetReadableTask, TargetReadLinearization, TargetScopedReadableTask,
} from "./target-task-read-model";
import type { TargetPrivateProjectPage, TargetReadableProject } from "./target-project-read-model";
import { isReadableStagingProjectId } from "./target-project-id";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";

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
}

/** Only the production-owned instance is used by HTTP handlers. Injection is for lifecycle tests. */
export function createStagingReadRunner(
  startChild: typeof spawn = spawn,
  timeoutMs = TIMEOUT_MS,
): (config: StagingPersonalReadConfig, scriptName: string, args: string[]) => Promise<unknown | null> {
  let active = 0;
  return async (config, scriptName, args) => {
    if (active >= MAX_CONCURRENT) return null;
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
      };
      return await new Promise<unknown | null>(resolve => {
        let child: ReturnType<typeof spawn>;
        try {
          child = startChild(process.execPath,
            ["--experimental-loader", loader, script, ...args],
            { cwd, env: environment, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        } catch {
          resolve(null);
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        let exceeded = false;
        const timer = setTimeout(() => {
          exceeded = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            exceeded = true;
            child.kill("SIGKILL");
          } else {
            chunks.push(chunk);
          }
        });
        child.on("error", () => { exceeded = true; });
        child.on("close", code => {
          clearTimeout(timer);
          if (exceeded || code !== 0) return resolve(null);
          try {
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!payload || typeof payload !== "object") return resolve(null);
            resolve(payload);
          } catch {
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
  return parseStagingPersonalPage(payload);
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

function parseLinearization(
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
  | { ok: true; scope: "shared"; task: TargetScopedReadableTask; linearization: TargetReadLinearization };

/**
 * Detail child boundary. A private task keeps the exact legacy shape (with its
 * title CAS revision); a shared-Area task has none (writes are R2-ID.3).
 */
export function parseStagingTaskDetail(value: unknown, taskId: string): StagingTaskDetailResult | null {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).scope === "shared") {
    const result = value as Record<string, unknown>;
    if (Object.keys(result).sort().join(",") !== "linearization,ok,scope,task" || result.ok !== true) return null;
    const task = parseScopedTask(result.task, "shared");
    if (!task || task.id !== taskId) return null;
    const linearization = parseLinearization(result.linearization, new Map([[task.areaId, task.areaKind] as const]));
    return linearization ? { ok: true, scope: "shared", task, linearization } : null;
  }
  return parseStagingPersonalDetail(value, taskId);
}

export async function readStagingTaskDetailInChild(
  config: StagingPersonalReadConfig, taskId: string,
): Promise<StagingTaskDetailResult | null> {
  const payload = await runChild(config, "target-staging-detail-child.mjs", [taskId]);
  return parseStagingTaskDetail(payload, taskId);
}
