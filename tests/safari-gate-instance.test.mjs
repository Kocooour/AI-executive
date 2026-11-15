import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync,
  writeFileSync, readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import {
  SAFARI_GATE_OWNER, assertSafeGateTmpRoot, assertIsolatedGateRunDirectory,
  assertNoGateRuntimeEnvFiles, assertSafeGateBuildOutput,
  buildSafariGateEnvironment, validateGatePort,
} from "../scripts/safari-gate-instance-lib.mjs";
import {
  SAFARI_GATE_PREFLIGHT_PATH, safariGatePreflightHtml,
  safariGateBrowserCookieName, gateOwnerCookieFromBrowserHeader,
  gateSetCookiesForBrowser,
} from "../scripts/safari-gate-https.mjs";
import {
  TARGET_PERSONAL_V1_PROFILE, TARGET_PERSONAL_V1_EXCLUDED,
  TARGET_PERSONAL_V1_REQUIRED_SETTINGS, targetPersonalV1Env,
} from "../lib/target-personal-profile.ts";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-safari-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tmpRoot = path.join(root, "tmp");
  mkdirSync(tmpRoot, { mode: 0o700 });
  const cwd = path.join(root, "checkout");
  mkdirSync(cwd, { mode: 0o700 });
  const live = path.join(root, "live");
  mkdirSync(live, { mode: 0o700 });
  return { root, tmpRoot, cwd, live };
}

function runDir(base, name) {
  const dir = path.join(base, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

test("new 0700 temporary run directory must be disjoint from ALL known live paths", t => {
  const { root, tmpRoot, cwd, live } = fixture(t);
  const good = runDir(tmpRoot, "lumi-e2e-safe");
  const env = {
    AI_EXECUTIVE_DATA_DIR: live,
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: path.join(root, "stage"),
    AI_EXECUTIVE_SECURITY_OUTBOX_DIR: path.join(root, "outbox"),
  };
  assert.equal(assertIsolatedGateRunDirectory(good, { tmpRoot, cwd, env }), good);

  const liveInTmp = runDir(tmpRoot, "live");
  const nested = runDir(liveInTmp, "lumi-e2e-nested");
  assert.throws(() => assertIsolatedGateRunDirectory(nested, {
    tmpRoot, cwd, env: { AI_EXECUTIVE_DATA_DIR: liveInTmp },
  }), /overlaps live data/);

  const ancestor = runDir(tmpRoot, "lumi-e2e-ancestor");
  assert.throws(() => assertIsolatedGateRunDirectory(ancestor, {
    tmpRoot, cwd,
    env: { AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: path.join(ancestor, "future-store") },
  }), /overlaps live data/);

  assert.throws(() => assertIsolatedGateRunDirectory(good, {
    tmpRoot, cwd, env: { AI_EXECUTIVE_SECURITY_OUTBOX_DIR: good },
  }), /overlaps live data/);
  const alias = path.join(tmpRoot, "lumi-e2e-alias");
  symlinkSync(good, alias);
  assert.throws(() => assertIsolatedGateRunDirectory(alias, { tmpRoot, cwd, env }), /0700/);

  chmodSync(good, 0o755);
  assert.throws(() => assertIsolatedGateRunDirectory(good, { tmpRoot, cwd, env }), /0700/);
});

test("implicit checkout .data and unsafe temporary roots are also refused", t => {
  const { root, tmpRoot, cwd, live } = fixture(t);
  const configuredTmp = path.join(live, "temp");
  mkdirSync(configuredTmp, { mode: 0o700 });
  assert.throws(() => assertSafeGateTmpRoot({
    tmpRoot: configuredTmp, cwd, env: { AI_EXECUTIVE_DATA_DIR: live },
  }), /overlaps a live data/);

  const bad = runDir(tmpRoot, "lumi-e2e-alias-cwd");
  assert.throws(() => assertIsolatedGateRunDirectory(bad, {
    tmpRoot, cwd, env: { AI_EXECUTIVE_DATA_DIR: "../relative" },
  }), /normalized absolute/);
  assert.throws(() => assertIsolatedGateRunDirectory(bad, {
    tmpRoot, cwd, env: { AI_EXECUTIVE_DATA_DIR: path.join(root, "missing") + "/../live" },
  }), /normalized absolute/);

  const unsafe = path.join(root, "unsafe-tmp");
  mkdirSync(unsafe);
  chmodSync(unsafe, 0o777);
  assert.throws(() => assertSafeGateTmpRoot({ tmpRoot: unsafe, cwd }),
    /without sticky-bit/);

  const insideImplicit = path.join(cwd, ".data");
  mkdirSync(insideImplicit);
  const run = runDir(insideImplicit, "lumi-e2e-misplaced");
  assert.throws(() => assertIsolatedGateRunDirectory(run, {
    tmpRoot: cwd, cwd,
  }), /overlaps/);
});

test("never read checkout runtime dotenv files", t => {
  const { cwd } = fixture(t);
  writeFileSync(path.join(cwd, ".env.example"), "NOT_A_RUNTIME_FILE=1\n");
  assert.doesNotThrow(() => assertNoGateRuntimeEnvFiles(cwd));
  writeFileSync(path.join(cwd, ".env.production.local"), "SECRET=do-not-read\n");
  assert.throws(() => assertNoGateRuntimeEnvFiles(cwd), /runtime .env files/);
});

test("local server has only the exact personal-v1 flags and three target settings", t => {
  const { tmpRoot } = fixture(t);
  const runDir = runDirForProfile(tmpRoot);
  const stage = {
    directory: path.join(runDir, "target-store"),
    ownerUserId: SAFARI_GATE_OWNER,
    restoreGeneration: "12345678-1234-4123-8123-123456789abc",
  };
  const env = buildSafariGateEnvironment({
    runDir, stage, passwordHash: "scrypt:salt:hash",
    sessionSecret: "synthetic-session-secret-at-least-32-characters",
    port: 3210,
  });
  const targetNames = Object.keys(env).filter(name => name.startsWith("AI_EXECUTIVE_TARGET_"));
  assert.deepEqual(new Set(targetNames), new Set([
    ...TARGET_PERSONAL_V1_PROFILE,
    ...TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(item => item.name),
  ]));
  assert.deepEqual(Object.fromEntries(TARGET_PERSONAL_V1_PROFILE.map(key => [key, env[key]])),
    targetPersonalV1Env());
  for (const excluded of TARGET_PERSONAL_V1_EXCLUDED) {
    assert.equal(env[excluded.flag], undefined, excluded.flag);
  }
  assert.equal(env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID, SAFARI_GATE_OWNER);
  assert.equal(env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY, stage.directory);
  assert.equal(env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION, stage.restoreGeneration);
  assert.equal(env.AI_EXECUTIVE_AUTH_ENABLED, "true");
  assert.equal(env.AI_EXECUTIVE_ALLOWED_ORIGINS, "https://127.0.0.1:3210");
  assert.equal(env.AI_EXECUTIVE_DATA_DIR, path.join(runDir, "data"));
  assert.equal(env.HERMES_AI_ENABLED, "false");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.throws(() => buildSafariGateEnvironment({
    runDir, stage: { ...stage, ownerUserId: "real-user" },
    passwordHash: "scrypt:salt:hash", sessionSecret: "a".repeat(48), port: 3210,
  }), /invalid synthetic/);
  assert.throws(() => buildSafariGateEnvironment({
    runDir, stage: { ...stage, directory: "/some/real/path" },
    passwordHash: "scrypt:salt:hash", sessionSecret: "a".repeat(48), port: 3210,
  }), /invalid synthetic/);
});

function runDirForProfile(tmpRoot) {
  return path.join(tmpRoot, "lumi-e2e-synthetic");
}

test("port validation fails closed", () => {
  for (const port of [0, 80, 65536, NaN, Infinity, 3210.5, "3210"]) {
    assert.throws(() => validateGatePort(port), /--port/);
  }
  assert.equal(validateGatePort(3210), 3210);
});

test("unsafe build output cannot redirect the sandboxed pnpm build", t => {
  const { root, cwd } = fixture(t);
  assert.doesNotThrow(() => assertSafeGateBuildOutput(cwd));
  const alias = path.join(cwd, ".next");
  symlinkSync(root, alias);
  assert.throws(() => assertSafeGateBuildOutput(cwd), /unsafe .next/);
  rmSync(alias);
  mkdirSync(alias);
  assert.doesNotThrow(() => assertSafeGateBuildOutput(cwd));
});

test("browser preflight refuses any persistent website state before opening Lumi", () => {
  const html = safariGatePreflightHtml();
  assert.equal(SAFARI_GATE_PREFLIGHT_PATH,
    "/__lumi_safari_gate__/fresh-origin");
  for (const required of [
    "indexedDB.databases()", "caches.keys()",
    "navigator.serviceWorker.getRegistrations()",
    "navigator.serviceWorker.controller",
    "localStorage.length", "sessionStorage.length",
    "LUMI_SAFARI_GATE_ORIGIN_REUSED",
    "LUMI_SAFARI_GATE_ORIGIN_INCONCLUSIVE",
    "LUMI_SAFARI_GATE_ORIGIN_CLEAN",
    "button.disabled = false",
  ]) assert.ok(html.includes(required), required);
  assert.match(html, /<button[^>]* disabled>/);
  assert.doesNotMatch(html, /localStorage\.clear\(|indexedDB\.deleteDatabase\(|caches\.delete\(/);
});

test("launcher rebuilds from clean SHA and HTTPS probe never disables trust", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const launcher = readFileSync(path.join(root, "scripts/safari-gate-instance.mjs"), "utf8");
  const proxy = readFileSync(path.join(root, "scripts/safari-gate-https.mjs"), "utf8");
  assert.ok(launcher.includes('spawnSync(process.execPath, [nextCli, "build"]'));
  assert.ok(launcher.includes('buildScript !== "next build"'));
  assert.ok(launcher.includes('COREPACK_ENABLE_NETWORK: "0"'));
  assert.ok(launcher.includes('npm_config_offline: "true"'));
  assert.doesNotMatch(launcher, /spawnSync\("pnpm"/);
  assert.ok(launcher.includes('if (builtSha !== sha || postBuildDirty ||'));
  assert.ok(launcher.includes("verifySafariGateHttps({"));
  assert.ok(launcher.includes("SAFARI_GATE_PREFLIGHT_PATH"));
  assert.ok(launcher.includes("requestedPort ?? await availableLoopbackPort()"));
  assert.ok(launcher.includes("safariGateBrowserCookieName("));
  assert.ok(launcher.includes("password, browserCookieName,"));
  assert.ok(proxy.includes("private Quick Capture Areas endpoint failed over HTTPS"));
  assert.doesNotMatch(proxy, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/);
});

async function exercisePreflight({ databases = [], cacheKeys = [], registrations = [],
  localCount = 0, sessionCount = 0, supported = true } = {}) {
  const fields = {
    status: { textContent: "" },
    detail: { textContent: "" },
    continue: {
      disabled: true,
      addEventListener(type, callback) { if (type === "click") this.click = callback; },
    },
  };
  const events = [];
  const script = safariGatePreflightHtml().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "preflight script must be present");
  const idb = { databases: supported ? async () => databases : undefined };
  const cacheStorage = { keys: async () => cacheKeys };
  const sw = { getRegistrations: async () => registrations, controller: null };
  const navigation = [];
  await runInNewContext(script, {
    window: { indexedDB: idb, caches: cacheStorage },
    indexedDB: idb, caches: cacheStorage, navigator: { serviceWorker: sw },
    localStorage: { length: localCount }, sessionStorage: { length: sessionCount },
    document: { getElementById(id) { return fields[id]; } },
    location: { replace(value) { navigation.push(value); } },
    console: {
      info(...args) { events.push(["info", ...args]); },
      error(...args) { events.push(["error", ...args]); },
    },
  });
  return { fields, events, navigation };
}

test("actual browser bootstrap only enables Continue for a clean origin", async () => {
  const fresh = await exercisePreflight();
  assert.equal(fresh.fields.continue.disabled, false);
  assert.ok(fresh.events.some(item => item[1] === "LUMI_SAFARI_GATE_ORIGIN_CLEAN"));
  fresh.fields.continue.click();
  assert.deepEqual(fresh.navigation, ["/?view=Calendar&scope=personal"]);

  for (const seeded of [
    { databases: [{ name: "ai-executive" }] },
    { cacheKeys: ["ai-executive-shell-v11"] },
    { registrations: [{}] },
    { localCount: 1 },
    { sessionCount: 1 },
  ]) {
    const stale = await exercisePreflight(seeded);
    assert.equal(stale.fields.continue.disabled, true);
    assert.ok(stale.events.some(item => item[1] === "LUMI_SAFARI_GATE_ORIGIN_REUSED"));
    assert.deepEqual(stale.navigation, []);
  }

  const unsupported = await exercisePreflight({ supported: false });
  assert.equal(unsupported.fields.continue.disabled, true);
  assert.ok(unsupported.events.some(item => item[1] === "LUMI_SAFARI_GATE_ORIGIN_INCONCLUSIVE"));
});


test("gate cookie names isolate every run even though Safari sends host cookies across ports", () => {
  const first = safariGateBrowserCookieName("a".repeat(32));
  const second = safariGateBrowserCookieName("b".repeat(32));
  assert.notEqual(first, second);
  assert.ok(first.startsWith("__Host-"));
  const oldHostCookies = [
    first + "=old.token",
    "ai_executive_session=old.production",
    "third_party_cookie=unrelated"
  ].join("; ");
  assert.equal(gateOwnerCookieFromBrowserHeader(oldHostCookies, second), undefined);
  assert.equal(gateOwnerCookieFromBrowserHeader(oldHostCookies, first),
    "ai_executive_session=old.token");
  assert.equal(gateOwnerCookieFromBrowserHeader(
    oldHostCookies + "; " + second + "=new.token", second),
    "ai_executive_session=new.token");
  assert.equal(gateOwnerCookieFromBrowserHeader(
    second + "=a.b; " + second + "=c.d", second), undefined,
    "duplicate current-run cookies must not be accepted");
  assert.equal(gateOwnerCookieFromBrowserHeader(
    "ai_executive_session=old.production", second), undefined,
    "legacy owner cookies must never be accepted directly");
  assert.throws(() => safariGateBrowserCookieName("invalid"), /invalid/);
});

test("cookie rewrite retains Secure/HttpOnly/SameSite/Path and never emits production name", () => {
  const browser = safariGateBrowserCookieName("c".repeat(32));
  const original = "ai_executive_session=owner.token; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800";
  const rewritten = gateSetCookiesForBrowser([original], browser);
  assert.deepEqual(rewritten, [
    browser + "=owner.token; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800",
  ]);
  assert.equal(gateSetCookiesForBrowser(undefined, browser), undefined);
  assert.deepEqual(gateSetCookiesForBrowser([
    "ai_executive_session=; Path=/; Max-Age=0; Secure; HttpOnly"
  ], browser), [
    browser + "=; Path=/; Max-Age=0; Secure; HttpOnly"
  ]);
  assert.throws(() => gateSetCookiesForBrowser([
    "some_unexpected_cookie=sensitive; Path=/"
  ], browser), /unexpected cookie/);
  assert.throws(() => gateSetCookiesForBrowser([original], "unsafe"), /invalid/);
});

test("Safari preflight intentionally ignores unrelated host cookies after proxy isolation", async () => {
  const checked = await exercisePreflight();
  assert.equal(checked.fields.continue.disabled, false);
  const html = safariGatePreflightHtml();
  assert.doesNotMatch(html, /document\.cookie|staleCookie|cookieDetected/);
  const proxy = readFileSync(
    path.resolve(import.meta.dirname, "../scripts/safari-gate-https.mjs"), "utf8");
  assert.ok(proxy.includes("delete headers.cookie"));
  assert.ok(proxy.includes("gateOwnerCookieFromBrowserHeader("));
  assert.ok(proxy.includes("gateSetCookiesForBrowser("));
  assert.ok(proxy.includes("HTTPS proxy accepted an unrelated owner cookie"));
  assert.ok(proxy.includes("proxy leaked host-wide owner cookie scope"));
});
