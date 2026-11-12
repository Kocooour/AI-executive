import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const envKeys = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-owner-revoke-"));
const dataDirectory = path.join(root, "data");
mkdirSync(dataDirectory, { mode: 0o700 });
const secret = "synthetic-owner-revocation-test-secret-123456";
const password = "testing-only-owner-password";
const salt = Buffer.alloc(16, 17);
const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
Object.assign(process.env, {
  NODE_ENV: "production", AI_EXECUTIVE_DATA_DIR: dataDirectory,
  AI_EXECUTIVE_AUTH_ENABLED: "true",
  AI_EXECUTIVE_PASSWORD_HASH: `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`,
  AI_EXECUTIVE_SESSION_SECRET: secret,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
});
const auth = await import("../lib/auth.ts");
const cutoff = await import("../lib/owner-session-revocation.ts");
const { POST: logout } = await import("../app/api/auth/logout/route.ts");
const { POST: passwordLogin } = await import("../app/api/auth/login/route.ts");
const { GET: legacyRead } = await import("../app/api/store/route.ts");
const { GET: targetRead } = await import("../app/api/target-staging/tasks/route.ts");
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "target"), ownerUserId: "alice",
});
Object.assign(process.env, {
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
  AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
  AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
});
const marker = path.join(dataDirectory, "owner-session-valid-from.json");
const url = "http://localhost:3001";
const cookie = token => `${auth.sessionCookieName}=${token}`;
const request = (endpoint, token, init = {}) => new Request(url + endpoint, {
  ...init,
  headers: { ...(token ? { cookie: cookie(token) } : {}), ...(init.headers || {}) },
});
const tokenFromLogin = async () => {
  const response = await passwordLogin(request("/api/auth/login", null, {
    method: "POST", headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  }));
  assert.equal(response.status, 200, await response.text());
  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/ai_executive_session=([^;]+)/);
  assert.ok(match, "login issues an owner cookie");
  return match[1];
};
const logoutToken = token => logout(request("/api/auth/logout", token, {
  method: "POST", headers: { origin: url },
}));
const authRequest = token => request("/api/auth/status", token);

after(() => {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("first successful login bootstraps; pre-migration token without issuedAt is rejected", async () => {
  assert.equal(existsSync(marker), false);
  assert.equal(auth.isAuthenticated(authRequest("stolen.old")), false);
  const token = await tokenFromLogin();
  assert.equal(existsSync(marker), true);
  assert.equal(auth.isAuthenticated(authRequest(token)), true);
  const data = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(data.subject, "owner");
  assert.ok(Number.isSafeInteger(data.issuedAt));
  const legacyPayload = Buffer.from(JSON.stringify({
    subject: "owner", expiresAt: Date.now() + 3600_000,
  })).toString("base64url");
  const legacyToken = legacyPayload + "." + createHmac("sha256", secret)
    .update(legacyPayload).digest("base64url");
  assert.equal(auth.isAuthenticated(authRequest(legacyToken)), false);
  assert.equal((await legacyRead(request("/api/store", legacyToken))).status, 401);
  assert.equal((await targetRead(request("/api/target-staging/tasks", legacyToken))).status, 401);
});

test("logout invalidates copied cookie on legacy and target reads; a new login works", async () => {
  const issued = await tokenFromLogin();
  assert.equal((await legacyRead(request("/api/store", issued))).status, 200);
  assert.equal((await targetRead(request("/api/target-staging/tasks", issued))).status, 200);
  // Anonymous logout cannot revoke anyone else's live owner cookie.
  assert.equal((await logoutToken(null)).status, 200);
  assert.equal(auth.isAuthenticated(authRequest(issued)), true);
  const crossOrigin = await logout(request("/api/auth/logout", issued, {
    method: "POST", headers: { origin: "https://evil.example" },
  }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(auth.isAuthenticated(authRequest(issued)), true);
  const signedOut = await logoutToken(issued);
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.headers.get("set-cookie") || "", /Max-Age=0/i);
  assert.equal(auth.isAuthenticated(authRequest(issued)), false);
  assert.equal((await legacyRead(request("/api/store", issued))).status, 401);
  assert.equal((await targetRead(request("/api/target-staging/tasks", issued))).status, 401);
  const next = await tokenFromLogin();
  assert.equal((await legacyRead(request("/api/store", next))).status, 200);
  assert.equal((await targetRead(request("/api/target-staging/tasks", next))).status, 200);
});

test("cutoff survives a fresh process and concurrent logout writes never decrease it", async () => {
  const first = await tokenFromLogin();
  const before = JSON.parse(readFileSync(marker, "utf8")).validFromMs;
  const worker = 'import { revokeAllOwnerSessions } from "./lib/owner-session-revocation.ts"; revokeAllOwnerSessions();';
  const args = ["--experimental-loader", "./tests/ts-loader.mjs", "--input-type=module", "-e", worker];
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stderr }));
    child.on("error", error => resolve({ code: -1, stderr: String(error) }));
  })));
  assert.deepEqual(outcomes.map(outcome => outcome.code), [0, 0, 0, 0], JSON.stringify(outcomes));
  const afterWrites = JSON.parse(readFileSync(marker, "utf8")).validFromMs;
  assert.ok(afterWrites >= before + 4, "each committed concurrent logout advances the cutoff");
  assert.equal(auth.isAuthenticated(authRequest(first)), false);
  const reissued = await tokenFromLogin();
  const probe = 'import { isAuthenticated, sessionCookieName } from "./lib/auth.ts"; ' +
    'const req = new Request("http://localhost/api/store",{headers:{cookie:sessionCookieName+"="+process.env.TEST_OWNER_COOKIE}}); ' +
    'if (!isAuthenticated(req)) process.exit(9);';
  const resumed = spawnSync(process.execPath, [
    "--experimental-loader", "./tests/ts-loader.mjs", "--input-type=module", "-e", probe,
  ], { cwd: process.cwd(), env: { ...process.env, TEST_OWNER_COOKIE: reissued },
    encoding: "utf8" });
  assert.equal(resumed.status, 0, resumed.stderr);
});

test("missing, malformed and symlinked cutoff fail closed; login never repairs corruption", async () => {
  const token = await tokenFromLogin();
  const backup = marker + ".backup";
  renameSync(marker, backup);
  try {
    assert.equal(auth.isAuthenticated(authRequest(token)), false, "missing marker refuses auth");
    writeFileSync(marker, "{broken", { mode: 0o600 });
    assert.equal(auth.isAuthenticated(authRequest(token)), false, "corrupt marker refuses auth");
    const unavailableLogin = await passwordLogin(request("/api/auth/login", null, {
      method: "POST", headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }));
    assert.equal(unavailableLogin.status, 500, "corrupt marker must not produce a new token");
    assert.equal(unavailableLogin.headers.get("set-cookie"), null);
    unlinkSync(marker);
    // A credential-authenticated new login may bootstrap after file loss.
    // The old signed cookie must remain dead after the reinitialization.
    const replacement = await tokenFromLogin();
    assert.equal(auth.isAuthenticated(authRequest(replacement)), true);
    assert.equal(auth.isAuthenticated(authRequest(token)), false);
    unlinkSync(marker);
    const symlink = path.join(root, "untrusted");
    writeFileSync(symlink, JSON.stringify({ version: 1, validFromMs: 0 }));
    const { symlinkSync } = await import("node:fs");
    symlinkSync(symlink, marker);
    assert.equal(auth.isAuthenticated(authRequest(replacement)), false);
    unlinkSync(marker);
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
    unlinkSync(backup);
  }
});
