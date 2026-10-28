/**
 * A short-lived subprocess keeps the synchronous SQLite snapshot/preflight
 * work off the Next.js event loop. No service-wide staging authority, token,
 * or database handle is cached in the HTTP process.
 *
 * The child runs with a restricted environment and only returns an authorized
 * personal page. A killed child has a distinct PID, so the next canonical
 * snapshot cleanup can reclaim any orphaned private tmpfs directory.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { TargetStagingPersonalOffsetPage } from "./target-staging-session-authority";

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REVISION = /^[a-f0-9]{64}$/;
let active = 0;

export interface StagingPersonalReadConfig {
  stagingDirectory: string;
  expectedRestoreGeneration: string;
  ownerUserId: string;
}

function validPage(value: unknown): value is TargetStagingPersonalOffsetPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as Partial<TargetStagingPersonalOffsetPage>;
  return Array.isArray(page.tasks) && page.tasks.length <= 100 &&
    typeof page.hasMore === "boolean" &&
    typeof page.revision === "string" && REVISION.test(page.revision) &&
    page.tasks.every(task => task && typeof task.id === "string" &&
      typeof task.title === "string" &&
      (task.projectId === null || typeof task.projectId === "string") &&
      typeof task.effectiveAreaId === "string" &&
      task.areaKind === "private" &&
      task.assigneeUserId === null);
}

export async function readStagingPersonalPageInChild(
  config: StagingPersonalReadConfig, limit: number, offset: number,
): Promise<TargetStagingPersonalOffsetPage | null> {
  if (active >= MAX_CONCURRENT) return null;
  active++;
  try {
    const cwd = process.cwd();
    const loader = path.join(cwd, "scripts/target-staging-ts-loader.mjs");
    const script = path.join(cwd, "scripts/target-staging-read-child.mjs");
    const environment = {
      AI_EXECUTIVE_DATA_DIR: process.env.AI_EXECUTIVE_DATA_DIR || "",
      AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: config.stagingDirectory,
      AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: config.expectedRestoreGeneration,
      AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: config.ownerUserId,
    };
    return await new Promise<TargetStagingPersonalOffsetPage | null>(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath,
          ["--experimental-loader", loader, script, String(limit), String(offset)],
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
      }, TIMEOUT_MS);
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
          if (!payload || typeof payload !== "object" ||
              (payload as { ok?: unknown }).ok !== true) return resolve(null);
          resolve(validPage(payload) ? payload : null);
        } catch {
          resolve(null);
        }
      });
    });
  } finally {
    active--;
  }
}
