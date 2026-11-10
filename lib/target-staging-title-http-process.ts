/** Bounded, short-lived staging title workers. No title or credentials enter argv. */
import { spawn } from "node:child_process";
import path from "node:path";
import type { StagingPersonalReadConfig } from "./target-staging-read-process";
import type { TargetStagingTaskTitleWriteRequest } from "./target-task-staging-writer";
import type { TargetStagingTaskDeleteRequest } from "./target-task-delete-writer";

const REVISION = /^[a-f0-9]{64}$/;
const MAX_OUTPUT = 1024;
const TIMEOUT_MS = 20_000;
let active = 0;

type Preview = { ok: true; snapshotRevision: string } |
  { ok: false; reason: "unavailable" | "stale_revision" };
type Write = { ok: true; replayed?: true } |
  { ok: false; reason: "unavailable" | "stale_revision" |
    "idempotency_conflict" | "unchanged" | "write_failed" | "session_revoked" |
    "resync_required" | "write_area_mismatch" };
type DeleteWrite = { ok: true; replayed?: true } |
  { ok: false; reason: "unavailable" | "stale_revision" |
    "idempotency_conflict" | "write_failed" | "session_revoked" |
    "resync_required" | "write_area_mismatch" };
type Status = { ok: true; status: "committed" | "not_recorded" } |
  { ok: false; reason: "unavailable" | "idempotency_conflict" |
    "resync_required" | "write_area_mismatch" };

function parsePreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys === "ok,snapshotRevision" && v.ok === true &&
      typeof v.snapshotRevision === "string" && REVISION.test(v.snapshotRevision)) {
    return { ok: true, snapshotRevision: v.snapshotRevision };
  }
  if (keys === "ok,reason" && v.ok === false &&
      (v.reason === "unavailable" || v.reason === "stale_revision")) {
    return { ok: false, reason: v.reason };
  }
  return null;
}

function parseWrite(value: unknown): Write | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.ok === true && keys === "ok") return { ok: true };
  if (v.ok === true && keys === "ok,replayed" && v.replayed === true) {
    return { ok: true, replayed: true };
  }
  if (v.ok === false && keys === "ok,reason" &&
      (v.reason === "unavailable" || v.reason === "stale_revision" ||
       v.reason === "idempotency_conflict" || v.reason === "unchanged" ||
       v.reason === "write_failed" || v.reason === "session_revoked" ||
       v.reason === "resync_required" || v.reason === "write_area_mismatch")) return { ok: false, reason: v.reason };
  return null;
}

function parseDeleteWrite(value: unknown): DeleteWrite | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.ok === true && keys === "ok") return { ok: true };
  if (v.ok === true && keys === "ok,replayed" && v.replayed === true) {
    return { ok: true, replayed: true };
  }
  if (v.ok === false && keys === "ok,reason" &&
      (v.reason === "unavailable" || v.reason === "stale_revision" ||
       v.reason === "idempotency_conflict" || v.reason === "write_failed" ||
       v.reason === "session_revoked" || v.reason === "resync_required" ||
       v.reason === "write_area_mismatch")) {
    return { ok: false, reason: v.reason };
  }
  return null;
}

function parseStatus(value: unknown): Status | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.ok === true && keys === "ok,status" &&
      (v.status === "committed" || v.status === "not_recorded")) {
    return { ok: true, status: v.status };
  }
  if (v.ok === false && keys === "ok,reason" &&
      (v.reason === "unavailable" || v.reason === "idempotency_conflict" ||
       v.reason === "resync_required" || v.reason === "write_area_mismatch")) {
    return { ok: false, reason: v.reason };
  }
  return null;
}

async function run(config: StagingPersonalReadConfig, scriptName: string,
  input: string, maxOutput = MAX_OUTPUT): Promise<unknown | null> {
  if (active >= 2 || Buffer.byteLength(input) > 192 * 1024) return null;
  active++;
  try {
    return await new Promise<unknown | null>(resolve => {
      const cwd = process.cwd();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, [
          "--experimental-loader", path.join(cwd, "scripts/target-staging-ts-loader.mjs"),
          path.join(cwd, "scripts", scriptName),
        ], {
          cwd, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
          env: {
            NODE_ENV: process.env.NODE_ENV || "production",
            AI_EXECUTIVE_DATA_DIR: process.env.AI_EXECUTIVE_DATA_DIR || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED || "",
            AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: config.stagingDirectory,
            AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: config.expectedRestoreGeneration,
            AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: config.ownerUserId,
            AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH: config.sessionTokenHash || "",
          },
        });
      } catch { resolve(null); return; }
      let done = false;
      let failed = false;
      const finish = (result: unknown | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput) { failed = true; child.kill("SIGKILL"); }
        else chunks.push(chunk);
      });
      child.on("error", () => { failed = true; finish(null); });
      child.on("close", code => {
        if (failed || code !== 0 || size > maxOutput) return finish(null);
        try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(null); }
      });
      child.stdin.on("error", () => { failed = true; child.kill("SIGKILL"); });
      child.stdin.end(input);
    });
  } finally { active--; }
}

/** Shared bounded-child runner for sibling staging write commands (membership). */
export const runStagingWriteChild = run;

export async function previewPrivateTaskTitleInChild(
  config: StagingPersonalReadConfig, taskId: string, expectedRevision?: string,
): Promise<Preview | null> {
  const value = await run(config, "target-staging-title-preview-child.mjs",
    JSON.stringify({ taskId, ...(expectedRevision === undefined ? {} : { expectedRevision }) }));
  return parsePreview(value);
}

export async function writePrivateTaskTitleInChild(
  config: StagingPersonalReadConfig, request: TargetStagingTaskTitleWriteRequest,
): Promise<Write | null> {
  const value = await run(config, "target-staging-title-write-child.mjs", JSON.stringify(request));
  return parseWrite(value);
}

export async function readPrivateTaskTitleCommandStatusInChild(
  config: StagingPersonalReadConfig, request: TargetStagingTaskTitleWriteRequest,
): Promise<Status | null> {
  const value = await run(config, "target-staging-title-status-child.mjs", JSON.stringify(request));
  return parseStatus(value);
}


/** R2c.1 task delete command (private owner or shared editor/admin; ACL re-checked in the write TX). */
export async function deleteTaskInChild(
  config: StagingPersonalReadConfig, request: TargetStagingTaskDeleteRequest,
): Promise<DeleteWrite | null> {
  const value = await run(config, "target-staging-delete-write-child.mjs", JSON.stringify(request));
  return parseDeleteWrite(value);
}

export async function readTaskDeleteCommandStatusInChild(
  config: StagingPersonalReadConfig, request: TargetStagingTaskDeleteRequest,
): Promise<Status | null> {
  const value = await run(config, "target-staging-delete-status-child.mjs", JSON.stringify(request));
  return parseStatus(value);
}

/** A read-only note status child returns no note content and no receipt key. */
export async function readStagingNoteEditCommandStatusInChild(
  config: StagingPersonalReadConfig,
  request: import("./target-note-staging-writer").TargetStagingNoteEditRequest,
): Promise<Status | null> {
  const value = await run(config, "target-staging-note-status-child.mjs", JSON.stringify(request));
  return parseStatus(value);
}

/** R2d.2c.2d: bounded staging-only note edit child. All content travels through stdin. */
export async function writeStagingNoteInChild(
  config: StagingPersonalReadConfig,
  request: import("./target-note-staging-writer").TargetStagingNoteEditRequest,
): Promise<Write | null> {
  const value = await run(config, "target-staging-note-write-child.mjs", JSON.stringify(request));
  return parseWrite(value);
}


/** R2d.2c.2f.4: bounded, read-only note delete command-status worker. */
export async function readStagingNoteDeleteCommandStatusInChild(
  config: StagingPersonalReadConfig,
  request: import("./target-note-delete-writer").TargetStagingNoteDeleteRequest,
): Promise<Status | null> {
  const value = await run(config, "target-staging-note-delete-status-child.mjs", JSON.stringify(request));
  return parseStatus(value);
}

/** R2d.2c.2f.3: bounded HTTP note deletion worker, no note contents in output. */
export async function deleteStagingNoteInChild(
  config: StagingPersonalReadConfig,
  request: import("./target-note-delete-writer").TargetStagingNoteDeleteRequest,
): Promise<DeleteWrite | null> {
  const value = await run(config, "target-staging-note-delete-child.mjs", JSON.stringify(request));
  return parseDeleteWrite(value);
}

/** Bounded project rename worker; request content is passed only via stdin. */
export async function writeProjectTitleInChild(
  config: StagingPersonalReadConfig, request: import("./target-project-title-writer").ProjectTitleCommand,
): Promise<Write | null> {
  return parseWrite(await run(config, "target-staging-project-title-write-child.mjs", JSON.stringify(request)));
}
