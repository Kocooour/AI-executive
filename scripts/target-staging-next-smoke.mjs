/** Focused post-build Next router smoke; no browser and no production data. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-next-staging-smoke-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "synthetic legacy only");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

let db;
let server;

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  listener.close();
  await once(listener, "close");
  return port;
}

async function ready(url, serverProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`next start exited: ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${url}/api/target-staging/tasks`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 401) return;
    } catch { /* server has not bound its port yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("next start did not become ready in 30 seconds");
}

try {
  const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
  const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
  });
  db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob private','private','bob-personal','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','editor')").run();
  const insert = db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,NULL)");
  const ids = ["alice/slash", "alice space", "alice:punct@-._"];
  for (const id of ids) insert.run(id, stage.unassignedAreaId, `Visible ${id}`);
  insert.run("bob-secret", "bob-private", "Bob secret");
  insert.run("shared-secret", "family-area", "Family secret");
  const insertProject = db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  insertProject.run("alice/project", stage.unassignedAreaId, "Alice project");
  insertProject.run("alice second", stage.unassignedAreaId, "Alice second");
  insertProject.run("bob-project", "bob-private", "Bob project secret");
  insertProject.run("shared-project", "family-area", "Shared project secret");

  const secret = randomBytes(32).toString("base64url");
  const hash = `scrypt:${Buffer.alloc(16, 1).toString("base64url")}:${Buffer.alloc(64, 2).toString("base64url")}`;
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH = hash;
  process.env.AI_EXECUTIVE_SESSION_SECRET = secret;
  const cookie = `${sessionCookieName}=${createSessionToken()}`;
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH || "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      AI_EXECUTIVE_DATA_DIR: legacy,
      AI_EXECUTIVE_AUTH_ENABLED: "true", AI_EXECUTIVE_PASSWORD_HASH: hash,
      AI_EXECUTIVE_SESSION_SECRET: secret,
      AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
      AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
      AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
    } });
  // Consume pipes so a verbose server cannot block on a full stdout buffer.
  let output = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  });
  try {
    await ready(origin, server);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  }

  for (const id of ids) {
    const response = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(id)}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Next router failed encoded ID ${id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.task.id, id);
    assert.equal(body.task.title, `Visible ${id}`);
  }
  for (const id of ["missing", "bob-secret", "shared-secret"]) {
    const response = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(id)}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 404, id);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  const unauthenticated = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(ids[0])}`);
  assert.equal(unauthenticated.status, 401);
  const projectFirst = await fetch(`${origin}/api/target-staging/projects?limit=1`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(projectFirst.status, 200);
  assert.equal(projectFirst.headers.get("cache-control"), "no-store");
  const projectPage = await projectFirst.json();
  assert.deepEqual(projectPage.projects, [{
    id: "alice second", title: "Alice second",
    areaId: stage.unassignedAreaId, areaKind: "private",
  }]);
  assert.equal(projectPage.hasMore, true);
  const projectSecond = await fetch(
    `${origin}/api/target-staging/projects?limit=1&cursor=${encodeURIComponent(projectPage.nextCursor)}`,
    { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(projectSecond.status, 200);
  assert.deepEqual((await projectSecond.json()).projects.map(project => project.id), ["alice/project"]);
  assert.equal((await fetch(`${origin}/api/target-staging/projects`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/projects?scope=shared`,
    { headers: { cookie } })).status, 400);
  for (const [id, title] of [["alice/project", "Alice project"], ["alice second", "Alice second"]]) {
    const response = await fetch(
      `${origin}/api/target-staging/projects/${encodeURIComponent(id)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 200, `Next project detail routing failed for ${id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      project: { id, title, areaId: stage.unassignedAreaId, areaKind: "private" },
    });
  }
  for (const id of ["missing-project", "bob-project", "shared-project"]) {
    const response = await fetch(
      `${origin}/api/target-staging/projects/${encodeURIComponent(id)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 404, id);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.equal((await fetch(`${origin}/api/target-staging/projects/alice%2Fproject`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/projects/alice%2Fproject?scope=shared`,
    { headers: { cookie } })).status, 400);
  console.log("Next router staging task and project list/detail smoke passed");
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3_000))]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
