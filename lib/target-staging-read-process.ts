/** Short-lived, bounded subprocesses keep synchronous staging reads off the HTTP event loop. */
import { spawn } from "node:child_process";
import path from "node:path";
import type { TargetStagingPersonalOffsetPage } from "./target-staging-session-authority";
import type { TargetReadableTask } from "./target-task-read-model";
import type { TargetPrivateProjectPage, TargetReadableProject } from "./target-project-read-model";
import { isReadableStagingProjectId } from "./target-project-id";

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REVISION = /^[a-f0-9]{64}$/;

export interface StagingPersonalReadConfig {
  stagingDirectory: string;
  expectedRestoreGeneration: string;
  ownerUserId: string;
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

