import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-fence-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const fence = await import("../lib/restore-fence.ts");
const claimsRoute = await import("../app/api/context/claims/route.ts");
const workRoute = await import("../app/api/work-sessions/route.ts");

test("the fence lets everything through until the first restore, then only the current generation", () => {
  for (const header of [null, "", "0", "7", "abc"]) assert.equal(fence.restoreGenerationMismatch(header, 0), false, String(header));
  assert.equal(fence.restoreGenerationMismatch(null, 1), true, "missing");
  assert.equal(fence.restoreGenerationMismatch("0", 1), true, "old");
  assert.equal(fence.restoreGenerationMismatch("2", 1), true, "newer than the server");
  assert.equal(fence.restoreGenerationMismatch("abc", 1), true, "not a number");
  assert.equal(fence.restoreGenerationMismatch("1", 1), false, "current");
  assert.equal(fence.restoreGenerationMismatch(" 3 ", 3), false, "current, padded");
});

const request = (url, body, headers = {}) => new Request(`http://localhost:3000${url}`, {
  method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const claimBody = () => ({ action: "create", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: crypto.randomUUID(), expectedRevision: 0,
  subject: { entityId: "workspace:personal" }, predicate: "preference", literal: { type: "string", value: "Fenced" }, freshness: "current", sensitivity: "normal" });
const count = (table) => Number(store.getDatabase().prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value);

test("after a restore a Context command and a work-session transition from a client that has not learned of it write nothing", async () => {
  // Before any restore: no header needed.
  const before = await claimsRoute.POST(request("/api/context/claims", claimBody()));
  assert.ok([200, 201].includes(before.status), `status ${before.status}`);
  const backup = store.createBackup("manual");
  store.restoreBackup(backup.name);
  const generation = store.readSnapshot().restoreGeneration;
  assert.equal(generation, 1);

  const claims = count("context_claims"), events = count("context_change_events"), sessions = count("work_sessions");
  for (const headers of [{}, { "x-lumi-restore-generation": "0" }, { "x-lumi-restore-generation": "5" }]) {
    const refused = await claimsRoute.POST(request("/api/context/claims", claimBody(), headers));
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.code, "restored");
    assert.equal(body.restoreGeneration, generation);
    const work = await workRoute.POST(request("/api/work-sessions", { action: "start", workspaceId: "personal", idempotencyKey: crypto.randomUUID(), taskId: "x", expectedTaskUpdatedAt: 1, expectedRevision: 0, expectedState: "idle" }, headers));
    assert.equal(work.status, 409);
    assert.equal((await work.json()).code, "restored");
  }
  assert.equal(count("context_claims"), claims);
  assert.equal(count("context_change_events"), events);
  assert.equal(count("work_sessions"), sessions);

  // A client that holds the current generation is let through (and judged by the route as before).
  const current = { "x-lumi-restore-generation": String(generation) };
  const accepted = await claimsRoute.POST(request("/api/context/claims", claimBody(), current));
  assert.ok([200, 201].includes(accepted.status), `status ${accepted.status}`);
  assert.equal(count("context_claims"), claims + 1);
  const invalid = await workRoute.POST(request("/api/work-sessions", { action: "nonsense" }, current));
  assert.notEqual(invalid.status, 409);
  // A request from another origin is refused by the route's own check, not by the fence.
  const foreign = await claimsRoute.POST(request("/api/context/claims", claimBody(), { origin: "https://evil.example" }));
  assert.equal(foreign.status, 403);
});

// Every mutating owner route that writes a table of the backup scope calls the fence; the rest are listed with the reason.
const exempt = {
  "POST /api/ai": "creates proposals only (ai_proposals, emptied on restore); nothing of an included table is written",
  "POST /api/day-plan": "proposes blocks (ai_proposals); the accepted action goes through POST /api/ai/actions",
  "POST /api/task-suggestions": "reads and suggests; writes nothing",
  "POST /api/notifications": "push subscriptions and preferences (excluded tables)",
  "PUT /api/store": "carries the generation in its body and is checked in replaceSnapshot",
  "POST /api/backups": "creates, restores and lists backups itself",
  "POST /api/backups/import": "is the import itself",
  "POST /api/client-errors": "a browser's error report; no owner data",
  "POST /api/auth/login": "authentication", "POST /api/auth/logout": "authentication",
  "POST /api/auth/passkeys/login/options": "authentication", "POST /api/auth/passkeys/login/verify": "authentication",
  "POST /api/auth/passkeys/register/options": "authentication (passkeys are excluded from backups)",
  "POST /api/auth/passkeys/register/verify": "authentication (passkeys are excluded from backups)",
  "DELETE /api/auth/passkeys": "authentication (passkeys are excluded from backups)",
  "POST /api/integrations/aifred": "integration API token, no client copy",
  "POST /api/integrations/aifred/tools": "integration API token, no client copy",
  "POST /api/mail/gmail/callback": "OAuth completion page has no client generation; one-use state is tied to restore generation and checked before and after Google exchange",
  "POST /api/mail/gmail/messages": "read-only same-origin search with no persisted mutation; POST avoids search strings in URL logs",
  "PATCH /api/target-staging/tasks/[taskId]/title": "writes only the separate isolated staging SQLite outside the legacy backup scope; the worker checks the staging restore generation and live ACL/revision atomically",
  "POST /api/target-staging/areas/[areaId]/members": "writes only the separate isolated staging SQLite outside the legacy backup scope; the worker checks the staging restore generation, live session, admin ACL and policy revision atomically",
  "POST /api/target-staging/tasks/[taskId]/delete": "writes only the separate isolated staging SQLite outside the legacy backup scope; the worker checks the staging restore generation, live session, ACL and revision atomically",
  "POST /api/target-staging/tasks/[taskId]/delete/status": "read-only receipt reconciliation in separate isolated staging SQLite; no persisted mutation",
  "POST /api/target-staging/tasks/[taskId]/title/status": "read-only receipt reconciliation in separate isolated staging SQLite; no persisted mutation",
  "PATCH /api/target-staging/notes/[noteId]/edit": "writes only isolated staging SQLite outside the legacy backup scope; staging anchor validates the server restore generation and the transactional note writer rechecks client generation, durable session, ACL, parent and note revisions before atomic commit",

};

function routeFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? routeFiles(file) : name === "route.ts" ? [file] : [];
  });
}

test("every mutating owner route that writes covered data calls the restore fence, and every exemption is listed with its reason", () => {
  const root = path.resolve("app/api");
  const seen = new Set();
  const missing = [];
  for (const file of routeFiles(root)) {
    const url = "/api/" + path.relative(root, path.dirname(file)).split(path.sep).join("/");
    // Comments are removed so that a call mentioned in a comment does not count.
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // A handler written in a form this scan does not split on would escape it entirely.
    assert.doesNotMatch(source, /export\s+(?:const|let|var|function)\s+(?:POST|PUT|PATCH|DELETE)\b/, `${url}: export mutating handlers as \`export async function\``);
    const parts = source.split(/(?=export\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE)\b)/);
    for (const part of parts) {
      const method = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/.exec(part)?.[1];
      if (!method || method === "GET") continue;
      const key = `${method} ${url}`;
      seen.add(key);
      const calls = part.split("fenceRestoredClient(").length - 1;
      if (key in exempt) {
        if (calls > 0) missing.push(`${key} is exempt but calls the fence`);
        continue;
      }
      // Fenced routes check twice and return the refusal each time: early (fast refusal, before the body is read) and again
      // after the last body read with no await in between, so nothing can resume after a restore and write stale intent.
      const early = /const fenced = fenceRestoredClient\(request\);\s*if \(fenced\) return fenced;/.exec(part);
      const reads = [...part.matchAll(/await readJsonBody\b/g)];
      const lastRead = reads.length ? reads[reads.length - 1].index : -1;
      const late = /const fencedAgain = fenceRestoredClient\(request\);\s*if \(fencedAgain\) return fencedAgain;/.exec(part);
      if (!early || lastRead < 0 || early.index > lastRead) missing.push(`${key} (no returned fence check before the body is read)`);
      else if (!late || late.index < lastRead) missing.push(`${key} (no returned fence check after the body is read)`);
      else if (/\bawait\b/.test(part.slice(part.indexOf(";", lastRead) + 1, late.index))) missing.push(`${key} (an await between the body read and the second fence check)`);
    }
  }
  assert.deepEqual(missing, [], "a mutating route neither calls fenceRestoredClient nor is exempt with a reason");
  assert.deepEqual(Object.keys(exempt).filter((key) => !seen.has(key)), [], "an exemption names a route that does not exist");
  for (const [key, reason] of Object.entries(exempt)) assert.ok(reason.length > 10, key);
});

test("a restore that completes while the request body is being read is caught by the second check: nothing is written", async () => {
  const backup = store.createBackup("manual");
  const generation = store.readSnapshot().restoreGeneration;
  const claims = count("context_claims"), events = count("context_change_events");
  let restoreRan = false;
  // The request passes the early check with the current generation; its body then takes long enough for a restore to land.
  const lateBody = JSON.stringify(claimBody());
  const stream = new ReadableStream({
    pull(controller) {
      if (!restoreRan) { restoreRan = true; store.restoreBackup(backup.name); }
      controller.enqueue(new TextEncoder().encode(lateBody));
      controller.close();
    },
  });
  const late = new Request("http://localhost:3000/api/context/claims", { method: "POST", duplex: "half", body: stream,
    headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-lumi-restore-generation": String(generation) } });
  const refused = await claimsRoute.POST(late);
  assert.equal(restoreRan, true, "the restore ran between the two checks");
  assert.equal(store.readSnapshot().restoreGeneration, generation + 1);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "restored");
  assert.equal(count("context_claims"), claims, "the restored data is untouched by the late request");
  assert.equal(count("context_change_events"), events);
});
