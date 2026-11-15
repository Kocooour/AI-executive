#!/usr/bin/env node
// R4 C27 — local-only Safari manual release gate. Run AFTER a clean exact-SHA
// checkout has been built. No production env is inherited or sourced.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFARI_GATE_OWNER, assertSafeGateTmpRoot, assertIsolatedGateRunDirectory,
  assertNoGateRuntimeEnvFiles, buildSafariGateEnvironment, validateGatePort,
} from "./safari-gate-instance-lib.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let port = 3210;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--port" ||
      !/^[0-9]+$/.test(args[1])) {
    throw new Error("usage: node scripts/safari-gate-instance.mjs [--port 3210]");
  }
  port = Number(args[1]);
}
validateGatePort(port);

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

function createTlsProxy(cert, key, externalPort, internalPort) {
  return https.createServer({
    cert: readFileSync(cert), key: readFileSync(key),
  }, (request, response) => {
    // Do not act as a general-purpose reverse proxy for arbitrary hosts.
    if (request.headers.host !== "127.0.0.1:" + externalPort) {
      response.writeHead(421);
      response.end();
      return;
    }
    const headers = {
      ...request.headers,
      host: "127.0.0.1:" + internalPort,
      "x-forwarded-host": "127.0.0.1:" + externalPort,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
    };
    const upstream = http.request({
      hostname: "127.0.0.1", port: internalPort,
      path: request.url, method: request.method, headers,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
}

async function main() {
  let runDir;
  let next;
  let proxy;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (proxy?.listening) {
      proxy.close();
      proxy.closeAllConnections?.();
    }
    if (next && next.exitCode === null) {
      next.kill("SIGTERM");
      setTimeout(() => {
        if (next.exitCode === null) next.kill("SIGKILL");
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
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid checkout SHA");
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo, env: processEnv, encoding: "utf8",
    }).trim();
    if (dirty) throw new Error("checkout is not clean; exact-SHA gate refused");
    if (!existsSync(path.join(repo, ".next", "BUILD_ID")) ||
        !existsSync(path.join(repo, "node_modules", "next", "dist", "bin", "next"))) {
      throw new Error("run pnpm install --frozen-lockfile && pnpm build first");
    }
    try {
      execFileSync("mkcert", ["-version"], {
        env: processEnv, stdio: "ignore",
      });
    } catch {
      throw new Error("mkcert missing: install and trust it locally (brew install mkcert; mkcert -install)");
    }

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
    await waitForNext(next, internalPort, () => stopping);
    if (stopping) throw new Error("interrupted");

    proxy = createTlsProxy(cert, key, port, internalPort);
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", resolve);
    });
    process.stdout.write(
      "\nSafari gate URL: https://127.0.0.1:" + port + "/\n" +
      "Test password: " + password + "\n" +
      "Checkout SHA: " + sha + "\n" +
      "Synthetic owner: " + SAFARI_GATE_OWNER + "\n" +
      "Run directory: " + runDir + "\n" +
      "Ctrl+C stops the instance (run directory is preserved).\n\n"
    );
    await new Promise(resolve => next.once("exit", resolve));
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
