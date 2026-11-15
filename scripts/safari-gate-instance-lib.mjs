// Pure safety and environment contract for the local, synthetic Safari gate.
// No production env file is opened and no state is created by this module.
import { lstatSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { targetPersonalV1Env } from "../lib/target-personal-profile.ts";
import { isWithinPath } from "./r4-path-boundary.mjs";

export const SAFARI_GATE_OWNER = "e2e-owner";

// Canonicalize an absent path through its nearest existing ancestor. Refuse
// traversal and dangling symlinks rather than normalizing away an alias.
export function canonicalGatePath(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) ||
      path.normalize(candidate) !== candidate) {
    throw new Error("expected a normalized absolute path");
  }
  let ancestor = candidate;
  const remainder = [];
  while (true) {
    try {
      return path.join(realpathSync(ancestor), ...remainder);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          throw new Error("dangling symlink in protected path");
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("cannot resolve protected path");
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function protectedPaths(cwd, env) {
  const result = [path.join(cwd, ".data")];
  if (env.AI_EXECUTIVE_DATA_DIR) result.push(env.AI_EXECUTIVE_DATA_DIR);
  if (env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY) {
    result.push(env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY);
  }
  if (env.AI_EXECUTIVE_SECURITY_OUTBOX_DIR) {
    result.push(env.AI_EXECUTIVE_SECURITY_OUTBOX_DIR);
  }
  return result.map(canonicalGatePath);
}

export function assertSafeGateTmpRoot({ tmpRoot, cwd, env = {} }) {
  const temp = canonicalGatePath(tmpRoot);
  const stat = lstatSync(temp);
  if (!stat.isDirectory()) throw new Error("temporary root must be a directory");
  // World/group-writable temporary parents are safe only with a sticky bit.
  if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) {
    throw new Error("temporary root is writable without sticky-bit protection");
  }
  for (const protectedPath of protectedPaths(cwd, env)) {
    if (isWithinPath(temp, protectedPath)) {
      throw new Error("temporary root overlaps a live data directory");
    }
  }
  return temp;
}

export function assertIsolatedGateRunDirectory(runDir, { tmpRoot, cwd, env = {} }) {
  const stat = lstatSync(runDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o7777) !== 0o700 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("run directory must be a newly created, operator-owned 0700 directory");
  }
  const run = canonicalGatePath(runDir);
  const temp = assertSafeGateTmpRoot({ tmpRoot, cwd, env });
  if (!path.basename(run).startsWith("lumi-e2e-") ||
      run === temp || !isWithinPath(run, temp)) {
    throw new Error("run directory must be a lumi-e2e-* child of the temporary root");
  }
  for (const protectedPath of protectedPaths(cwd, env)) {
    if (isWithinPath(run, protectedPath) ||
        isWithinPath(protectedPath, run)) {
      throw new Error("run directory overlaps live data (either direction)");
    }
  }
  return run;
}

// next start loads .env.production/.env.local even with a sanitized child env.
// Reject such checkouts without opening them, instead of risking import of
// local credentials. .env.example is never a Next runtime environment file.
export function assertNoGateRuntimeEnvFiles(cwd) {
  const names = readdirSync(cwd).filter(name =>
    /^\.env(?:\..+)?$/.test(name) && name !== ".env.example");
  if (names.length) {
    throw new Error("runtime .env files are present; move them out of this checkout before build and launch");
  }
}

// A build writes to .next. Refuse a symlink (including to a live store)
// before pnpm can follow it; this does not delete existing build artifacts.
export function assertSafeGateBuildOutput(cwd) {
  try {
    const stat = lstatSync(path.join(cwd, ".next"));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("unsafe .next build output: expected a real directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function validateGatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer from 1024 through 65535");
  }
  return port;
}

// Only targetPersonalV1Env's exact flags plus the three identity-bound target
// settings; all non-target settings below are local auth/network safeguards.
export function buildSafariGateEnvironment({
  runDir, stage, passwordHash, sessionSecret, port,
}) {
  validateGatePort(port);
  const url = "https://127.0.0.1:" + port;
  if (!stage || stage.ownerUserId !== SAFARI_GATE_OWNER ||
      stage.directory !== path.join(runDir, "target-store") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stage.restoreGeneration)) {
    throw new Error("invalid synthetic target store identity");
  }
  if (!/^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(passwordHash) ||
      typeof sessionSecret !== "string" || sessionSecret.length < 32) {
    throw new Error("invalid temporary login credentials");
  }
  return {
    ...targetPersonalV1Env(),
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: stage.ownerUserId,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    AI_EXECUTIVE_AUTH_ENABLED: "true",
    AI_EXECUTIVE_PASSWORD_HASH: passwordHash,
    AI_EXECUTIVE_SESSION_SECRET: sessionSecret,
    AI_EXECUTIVE_DATA_DIR: path.join(runDir, "data"),
    AI_EXECUTIVE_SECURITY_OUTBOX_DIR: path.join(runDir, "security-outbox"),
    AI_EXECUTIVE_ALLOWED_ORIGINS: url,
    AI_EXECUTIVE_PASSKEY_ORIGINS: url,
    AI_EXECUTIVE_INTEGRATION_TOKEN: "",
    AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES: "",
    OPENAI_API_KEY: "",
    HERMES_AI_ENABLED: "false",
  };
}
