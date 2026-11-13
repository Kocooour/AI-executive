/**
 * C11: route inventory is taken from the filesystem, not a hand-maintained
 * list. Tests call the real Next handlers against an isolated R4 target store.
 * This is deliberately a first-release profile test: a 404 only passes for a
 * handler which is explicitly excluded, never for an enabled route.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { targetPersonalV1Env, TARGET_PERSONAL_V1_EXCLUDED } from "../lib/target-personal-profile.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-c11-target-boundary-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "unchanged");
const envKeys = new Set([
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  ...Object.keys(process.env).filter(key => key.startsWith("AI_EXECUTIVE_TARGET_")),
  ...Object.keys(targetPersonalV1Env()),
  ...TARGET_PERSONAL_V1_EXCLUDED.map(item => item.flag),
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
]);
const old = Object.fromEntries([...envKeys].map(key => [key, process.env[key]]));
for (const flag of Object.keys(targetPersonalV1Env())) delete process.env[flag];
for (const { flag } of TARGET_PERSONAL_V1_EXCLUDED) delete process.env[flag];
Object.assign(process.env, {
  NODE_ENV: "production",
  AI_EXECUTIVE_DATA_DIR: legacy,
  AI_EXECUTIVE_AUTH_ENABLED: "true",
  AI_EXECUTIVE_PASSWORD_HASH: "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
    ":" + Buffer.alloc(64, 2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET: "synthetic-c11-first-release-session-secret-over-32",
  ...targetPersonalV1Env(),
});
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { issueDurableTargetStagingSession, TARGET_STAGING_SESSION_COOKIE } =
  await import("../lib/target-staging-durable-session.ts");
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
Object.assign(process.env, {
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
  AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
  AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
});
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON");
db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('alice-task',?,'Private task')").run(stage.unassignedAreaId);
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('alice-project',?,'Private project')").run(stage.unassignedAreaId);
db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('alice-note',?,'Private note','Secret')").run(stage.unassignedAreaId);
const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
const bob = issueDurableTargetStagingSession(store, "bob", 900);
assert.equal(bob.ok, true);
const bobCookie = TARGET_STAGING_SESSION_COOKIE + "=" + bob.sessionToken;

after(() => {
  db.close();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "unchanged");
  rmSync(root, { recursive: true, force: true });
});

const directory = path.resolve(import.meta.dirname, "../app/api/target-staging");
function routes(dir = directory) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) return routes(filename);
    return entry.isFile() && entry.name === "route.ts" ? [filename] : [];
  }).sort();
}
// Explicit per-route/method exclusions: the HTTP family flags in the release
// profile are independent. In particular /projects GET is ON but POST is OFF.
// Unknown/new routes default to ON and MUST prove 401, never silently pass 404.
// Closed inventory of excluded METHOD + route pairs. Do not use family-prefix
// expressions: a newly discovered handler must prove 401 until its precise
// release gate has been reviewed and explicitly classified.
const disabledRoutes = new Map([
  ["GET attention", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED"],
  ["GET attention/command", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED"],
  ["PATCH attention/command", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED"],
  ["POST attention/command/receipt", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED"],
  ["GET global-index", "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED"],
  ["GET home/my-plan", "AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED"],
  ["GET home/summary", "AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED"],
  ["GET note-sync", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED"],
  ["GET note-sync-session", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED"],
  ["GET notifications/settings", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED"],
  ["PATCH notifications/settings", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED"],
  ["POST notifications/targets", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED"],
  ["POST project-tasks", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED"],
  ["POST project-tasks/create-recovery", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED"],
  ["POST project-tasks/create-status", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED"],
  ["POST projects", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED"],
  ["POST projects/create-recovery", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED"],
  ["POST projects/create-status", "AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED"],
  ["GET projects/[projectId]/relations", "AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED"],
  ["GET relations/backlinks", "AI_EXECUTIVE_TARGET_STAGING_HTTP_RELATIONS_ENABLED"],
  ["GET task-index/global", "AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED"],
  ["GET task-temporal/due-on", "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED"],
  ["PATCH task-temporal/due-on", "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED"],
  ["POST task-temporal/due-on/receipt", "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED"],
  ["GET task-temporal/due-window", "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED"],
]);
function excludedFlag(route, method) {
  return disabledRoutes.get(method + " " + route) ?? null;
}
const params = {
  areaId: () => stage.unassignedAreaId,
  projectId: () => "alice-project",
  taskId: () => "alice-task",
  noteId: () => "alice-note",
};
let ip = 0;
const host = "http://localhost:3001";
const headers = (cookie, origin) => ({
  ...(cookie ? { cookie } : {}),
  ...(origin === undefined ? {} : { origin }),
  "x-forwarded-for": "10.117." + ((++ip >> 8) & 255) + "." + (ip & 255),
  "content-type": "application/json",
  "x-lumi-target-protocol": "1",
});
function request(method, url, cookie, origin) {
  return new Request(url, {
    method, headers: headers(cookie, origin),
    ...(method === "GET" || method === "HEAD" ? {} : {
      body: JSON.stringify({ commandId: randomUUID(), restoreGeneration: stage.restoreGeneration }),
    }),
  });
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .map(row => row.name).sort();
const countState = () => ({
  tables: Object.fromEntries(tables.map(name => [
    name, Number(db.prepare('SELECT COUNT(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n),
  ])),
  anchor: db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get()?.value,
  journal: readFileSync(path.join(stage.directory, "lumi-target.journal"), "utf8"),
});
const failures = [];
const fail = (method, route, phase, expected, received) =>
  failures.push(method + " /api/target-staging/" + route + " [" + phase + "] → " +
    received + " (expected " + expected + ")");
async function runHandler(handler, context, method, route, phase, cookie, origin, expectedStatus, checkMutation, missingTarget = false) {
  const value = name => missingTarget ? "missing-c11-" + name : (params[name]?.() ?? "synthetic-id");
  const relative = route.replace(/\[(\w+)\]/g, (_m, name) => value(name));
  const resolvedContext = missingTarget ? { params: Promise.resolve(Object.fromEntries(
    [...route.matchAll(/\[(\w+)\]/g)].map(([, name]) => [name, value(name)]),
  )) } : context;
  const url = host + "/api/target-staging/" + relative;
  const before = checkMutation ? countState() : null;
  try {
    const response = await handler(request(method, url, cookie, origin), resolvedContext);
    if (response.status !== expectedStatus) fail(method, route, phase, expectedStatus, response.status);
    const text = await response.text();
    if (expectedStatus === 401 || expectedStatus === 404) {
      let body;
      try { body = JSON.parse(text); } catch { /* invalid JSON is reported below */ }
      const genericError = expectedStatus === 401 ? "Authentication required" : "Not found";
      if (!body || body.error !== genericError || Object.hasOwn(body, "id") ||
          Object.hasOwn(body, "title") ||
          /alice-(?:task|project|note)|Private (?:task|project|note)|Secret/.test(text))
        fail(method, route, phase + ":body", "generic " + genericError, text.slice(0, 100));
    }
    if (before) assert.deepEqual(countState(), before, method + " " + route + " " + phase + " mutated staging");
  } catch (error) {
    fail(method, route, phase, expectedStatus, error?.message ?? String(error));
  }
}

test("every discovered target-staging handler respects the exact first-release session/origin boundary", async () => {
  const entries = routes();
  assert.ok(entries.length >= 45, "recursive route discovery must cover the complete target API");
  let enabled = 0, excluded = 0, writes = 0;
  const discovered = new Set();
  for (const file of entries) {
    const relative = path.relative(directory, path.dirname(file)).split(path.sep).join("/");
    const mod = await import(pathToFileURL(file).href);
    const methods = Object.keys(mod).filter(method => /^(GET|POST|PATCH|PUT|DELETE)$/.test(method)).sort();
    assert.ok(methods.length > 0, file + " exports no HTTP handler");
    for (const method of methods) {
      discovered.add(method + " " + relative);
      const flag = excludedFlag(relative, method);
      const on = flag === null || process.env[flag] === "true";
      assert.ok(flag === null || TARGET_PERSONAL_V1_EXCLUDED.some(x => x.flag === flag),
        relative + " unexpected flag classification " + flag);
      const context = { params: Promise.resolve(Object.fromEntries(
        [...relative.matchAll(/\[(\w+)\]/g)].map(([, name]) => [name, params[name]?.() ?? "synthetic-id"]),
      )) };
      const phase = on ? "no-session" : "profile-disabled:" + flag;
      await runHandler(mod[method], context, method, relative, phase, null,
        host, on ? 401 : 404, true);
      if (relative.includes("[")) {
        // An absent but well-formed ID cannot bypass session or feature
        // admission; it must produce exactly the same generic refusal.
        await runHandler(mod[method], context, method, relative,
          phase + ":absent-id", null, host, on ? 401 : 404, true, true);
      }
      if (!on) { excluded++; continue; }
      enabled++;
      // Bob has a valid live session, but no access to Alice's private object.
      if (method === "GET" && /\[(?:areaId|taskId|noteId|projectId)\]/.test(relative))
        await runHandler(mod[method], context, method, relative, "foreign-owner",
          bobCookie, host, 404, true);
      if (method !== "GET") {
        writes++;
        await runHandler(mod[method], context, method, relative, "foreign-origin",
          bobCookie, "https://evil.example", 403, true);
        await runHandler(mod[method], context, method, relative, "missing-origin",
          bobCookie, undefined, 403, true);
      }
    }
  }
  assert.deepEqual([...disabledRoutes.keys()].filter(key => !discovered.has(key)), [],
    "stale explicit disabled-route entries");
  assert.ok(enabled > 20 && excluded > 10 && writes > 10,
    JSON.stringify({ enabled, excluded, writes }));
  assert.deepEqual(failures, [], failures.join("\n"));
});
