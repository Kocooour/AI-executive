#!/usr/bin/env node
// R4 C27 — local-only Safari manual release gate. Run AFTER a clean exact-SHA
// checkout has been built. No production env is inherited or sourced.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFARI_GATE_OWNER, assertSafeGateTmpRoot, assertIsolatedGateRunDirectory,
  assertNoGateRuntimeEnvFiles, assertSafeGateBuildOutput, buildSafariGateEnvironment, validateGatePort,
} from "./safari-gate-instance-lib.mjs";
import {
  SAFARI_GATE_PREFLIGHT_PATH, createSafariGateTlsProxy, verifySafariGateHttps,
} from "./safari-gate-https.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let requestedPort = null;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--port" ||
      !/^[0-9]+$/.test(args[1])) {
    throw new Error("usage: node scripts/safari-gate-instance.mjs [--port 3210]");
  }
  requestedPort = validateGatePort(Number(args[1]));
}

const pathEnv = process.env.PATH || "/usr/bin:/bin";
const processEnv = { PATH: pathEnv, HOME: process.env.HOME || os.homedir() };
const loader = path.join(repo, "scripts", "target-staging-ts-loader.mjs");
const runCli = (script, argumentsList, environment) =>
  execFileSync(process.execPath, [
    "--experimental-loader", loader, path.join(repo, script), ...argumentsList,
  ], {
    cwd: repo, env: environment, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function availableLoopbackPort(except) {
  for (;;) {
    const server = net.createServer();
    const candidate = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    await new Promise(resolve => server.close(resolve));
    if (candidate !== except) return candidate;
  }
}

async function waitForNext(child, port, isStopping) {
  for (let attempts = 0; attempts < 150; attempts++) {
    if (isStopping()) throw new Error("interrupted");
    if (child.exitCode !== null) throw new Error("next start exited before readiness");
    try {
      const ready = await new Promise((resolve, reject) => {
        const request = http.get({
          hostname: "127.0.0.1", port, path: "/api/auth/status", timeout: 900,
        }, response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk.slice(0, 1024); });
          response.on("end", () => {
            try {
              const status = JSON.parse(body);
              resolve(response.statusCode === 200 &&
                status.enabled === true && status.configured === true);
            } catch { resolve(false); }
          });
        });
        request.on("timeout", () => request.destroy(new Error("timeout")));
        request.on("error", reject);
      });
      if (ready) return;
    } catch {
      // The loopback listener may not yet have started.
    }
    await sleep(200);
  }
  throw new Error("next start did not become ready within 30 seconds");
}

async function main() {
  let runDir;
  let next;
  let proxy;
  let stopping = false;
  let childSpawnError = null;
  const stop = () => {
    stopping = true;
    if (proxy?.listening) {
      proxy.close();
      proxy.closeAllConnections?.();
    }
    if (next && next.exitCode === null && next.signalCode === null && next.pid) {
      next.kill("SIGTERM");
      setTimeout(() => {
        if (next.exitCode === null && next.signalCode === null) next.kill("SIGKILL");
      }, 3000).unref();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Check before creating anything below TMPDIR, including that no runtime
    // .env will be autoloaded by Next despite the sanitized process env.
    const tmpRoot = assertSafeGateTmpRoot({
      tmpRoot: os.tmpdir(), cwd: repo, env: process.env,
    });
    assertNoGateRuntimeEnvFiles(repo);
    assertSafeGateBuildOutput(repo);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid checkout SHA");
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    if (dirty) throw new Error("checkout is not clean; exact-SHA gate refused");
    if (!existsSync(path.join(repo, "node_modules", "next", "dist", "bin", "next"))) {
      throw new Error("run pnpm install --frozen-lockfile first");
    }
    try {
      execFileSync("mkcert", ["-version"], {
        env: processEnv, stdio: "ignore",
      });
    } catch {
      throw new Error("mkcert missing: install and trust it locally (brew install mkcert; mkcert -install)");
    }

    // An OS-selected port creates a fresh browser origin by default. With
    // --port, the mandatory in-browser preflight will refuse stale site data.
    const port = requestedPort ?? await availableLoopbackPort();
    runDir = mkdtempSync(path.join(tmpRoot, "lumi-e2e-"));
    chmodSync(runDir, 0o700);
    assertIsolatedGateRunDirectory(runDir, {
      tmpRoot, cwd: repo, env: process.env,
    });
    mkdirSync(path.join(runDir, "data"), { mode: 0o700 });
    mkdirSync(path.join(runDir, "security-outbox"), { mode: 0o700 });

    // No inherited app credentials, integration settings or production data
    // locations reach either provisioning subprocess.
    const isolatedEnv = {
      PATH: pathEnv, HOME: runDir,
      NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    };
    const raw = runCli("e2e/target-personal-store-setup.mjs",
      [runDir, SAFARI_GATE_OWNER, "1"], isolatedEnv);
    const stage = JSON.parse(raw.trim().split("\n").at(-1));
    runCli("scripts/owner-session-revocation-init.mjs",
      ["--init"], {
        ...isolatedEnv, AI_EXECUTIVE_DATA_DIR: path.join(runDir, "data"),
      });

    const password = randomBytes(24).toString("base64url");
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    const passwordHash = "scrypt:" + salt.toString("base64url") +
      ":" + hash.toString("base64url");
    const sessionSecret = randomBytes(48).toString("base64url");
    const env = buildSafariGateEnvironment({
      runDir, stage, passwordHash, sessionSecret, port,
    });
    // Never serve an ignored/stale .next from another checkout: produce the
    // build NOW from the verified clean source using only synthetic settings.
    // This also prevents a production env from affecting the build.
    const built = spawnSync("pnpm", ["build"], {
      cwd: repo, env: { ...env, PATH: pathEnv, HOME: runDir },
      stdio: "inherit", timeout: 900_000,
    });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error("isolated exact-SHA pnpm build failed");
    const builtSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    const postBuildDirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    if (builtSha !== sha || postBuildDirty ||
        !existsSync(path.join(repo, ".next", "BUILD_ID"))) {
      throw new Error("build checkout SHA changed, is dirty or has no BUILD_ID");
    }
    const cert = path.join(runDir, "safari-local.crt");
    const key = path.join(runDir, "safari-local.key");
    // mkcert uses only the operator's local CA; the script never installs a
    // global CA, alters the production auth route or exposes a LAN listener.
    execFileSync("mkcert", [
      "-cert-file", cert, "-key-file", key, "127.0.0.1", "localhost",
    ], { cwd: runDir, env: processEnv, stdio: "ignore" });
    chmodSync(key, 0o600);

    const internalPort = await availableLoopbackPort(port);
    next = spawn(process.execPath, [
      path.join(repo, "node_modules", "next", "dist", "bin", "next"),
      "start", "--hostname", "127.0.0.1", "--port", String(internalPort),
    ], {
      cwd: repo,
      env: { ...env, PATH: pathEnv, HOME: runDir },
      stdio: "inherit",
    });
    next.on("error", error => { childSpawnError = error; });
    await waitForNext(next, internalPort, () => stopping || childSpawnError !== null);
    if (stopping) throw new Error("interrupted");

    proxy = createSafariGateTlsProxy(cert, key, port, internalPort);
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", resolve);
    });
    // Fail closed before handing a URL to Safari: verify CA-authenticated TLS,
    // the unchanged Secure owner cookie and the private Tvoření Area endpoint.
    const caRoot = execFileSync("mkcert", ["-CAROOT"], {
      cwd: runDir, env: processEnv, encoding: "utf8",
    }).trim();
    await verifySafariGateHttps({
      port, ca: readFileSync(path.join(caRoot, "rootCA.pem")), password,
    });
    if (stopping) throw new Error("interrupted");
    process.stdout.write(
      "\nHTTPS owner login + private Area smoke: PASS\n" +
      "Safari gate URL: https://127.0.0.1:" + port + SAFARI_GATE_PREFLIGHT_PATH + "\n" +
      "Test password: " + password + "\n" +
      "Checkout SHA: " + sha + "\n" +
      "Synthetic owner: " + SAFARI_GATE_OWNER + "\n" +
      "Run directory: " + runDir + "\n" +
      "Safari must report LUMI_SAFARI_GATE_ORIGIN_CLEAN before continuing.\n" +
      "Ctrl+C stops the instance (run directory is preserved).\n\n"
    );
    await new Promise(resolve => {
      if (next.exitCode !== null || next.signalCode !== null) resolve();
      else next.once("exit", resolve);
    });
    if (!stopping) throw new Error("next start terminated unexpectedly");
  } finally {
    stop();
    if (runDir) {
      process.stdout.write("Run directory retained for explicit deletion: " +
        runDir + "\n");
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch(error => {
  if (error?.message !== "interrupted") {
    process.stderr.write("Safari gate: " + (error?.message || "failed") + "\n");
    process.exitCode = 1;
  }
});
