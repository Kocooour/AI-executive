import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const repo = process.cwd();
const source = readFileSync(path.join(repo, "deployment/deploy-safe.sh"), "utf8");
const mockCommands = path.join(repo, "tests/fixtures/deploy-mock.mjs");
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);

// The production script never accepts test-only overrides. This test executes a
// strictly rewritten, disposable copy and shims all external side-effect commands.
function sandbox(scenario) {
  const root = mkdtempSync(path.join(tmpdir(), "lumi-deploy-test-"));
  const app = path.join(root, "opt/ai-executive");
  const data = path.join(root, "var/lib/ai-executive");
  const backups = path.join(root, "var/backups/ai-executive");
  const envfile = path.join(root, "etc/ai-executive/ai-executive.env");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const lockDir = path.join(root, "run/lock/ai-executive");
  const lockFile = path.join(lockDir, "deploy.lock");

  for (const p of [app, data, backups, path.dirname(envfile), state, bin,
    path.join(app, ".next/server"), path.join(app, "scripts"),
    path.join(app, "node_modules/next/dist/bin"), path.join(data, "notes")]) {
    mkdirSync(p, { recursive: true });
  }
  writeFileSync(envfile, "synthetic-only=true\n", { mode: 0o600 });
  writeFileSync(path.join(data, "notes/safe.txt"), "synthetic note\n");
  writeFileSync(path.join(app, ".next/BUILD_ID"), "old build", { mode: 0o644 });
  writeFileSync(path.join(app, "node_modules/next/dist/bin/next"), "fake\n");
  copyFileSync(path.join(repo, "scripts/check-data.mjs"), path.join(app, "scripts/check-data.mjs"));

  const sqlite = new DatabaseSync(path.join(data, "store.sqlite"));
  try {
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("CREATE TABLE entities(id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    sqlite.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)").run("task:keep", "{}", 1);
    sqlite.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)").run("task:other", "{}", 2);
    if (scenario === "outboxcompact") {
      // Match the bounded queue trigger shipped in PR #79. The queue is
      // deliberately transient: compaction is not a loss of canonical data.
      sqlite.exec(`CREATE TABLE semantic_index_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL, object_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TRIGGER semantic_outbox_bound_queue AFTER INSERT ON semantic_index_outbox
        WHEN (SELECT COUNT(*) FROM semantic_index_outbox) > 1000
        BEGIN
          DELETE FROM semantic_index_outbox;
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'queue_compacted');
        END;`);
      const insert = sqlite.prepare(`INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
        VALUES ('claim', ?, 'personal', 'update')`);
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 1000; i++) insert.run(`claim-${i}`);
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  } finally { sqlite.close(); }

  writeFileSync(path.join(state, "service"), "active");
  writeFileSync(path.join(state, "head"), oldSha);
  writeFileSync(path.join(state, "events"), "");
  for (const command of ["id", "stat", "du", "df", "getent", "chgrp", "sleep",
    "systemctl", "git", "pnpm", "runuser", "cp", "curl"]) {
    // GitHub contents files are mode 0644, so use an executable disposable shim.
    writeFileSync(path.join(bin, command),
      '#!/bin/sh\nLUMI_TEST_COMMAND=' + command + ' exec ' +
      JSON.stringify(process.execPath) + ' ' + JSON.stringify(mockCommands) + ' "$@"\n',
      { mode: 0o755 });
  }

  let script = source;
  for (const [key, original, rewritten] of [
    ["APP", "/opt/ai-executive", app],
    ["DATA", "/var/lib/ai-executive", data],
    ["ENVFILE", "/etc/ai-executive/ai-executive.env", envfile],
    ["BACKUP_DIR", "/var/backups/ai-executive", backups],
    ["LOCK_DIR", "/run/lock/ai-executive", lockDir],
  ]) {
    const declaration = key + "=" + original;
    assert.equal(script.split(declaration).length, 2, "missing/ambiguous substitution: " + key);
    script = script.replace(declaration, key + "=" + JSON.stringify(rewritten));
  }
  assert.ok(script.includes("/usr/bin/node"), "check data script still uses Node");
  script = script.replaceAll("/usr/bin/node", process.execPath);

  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    LUMI_TEST_ROOT: root,
    LUMI_TEST_SCENARIO: scenario,
    LUMI_TEST_LOCK_FILE: lockFile,
  };
  function execute() {
    const result = spawnSync("bash", ["-c", script, "--", newSha], {
      cwd: root, env, encoding: "utf8", timeout: 40000, maxBuffer: 3 * 1024 * 1024,
    });
    assert.ifError(result.error);
    return {
      ...result,
      output: (result.stdout || "") + "\n" + (result.stderr || ""),
      events: readFileSync(path.join(state, "events"), "utf8").trim().split("\n"),
      head: readFileSync(path.join(state, "head"), "utf8").trim(),
      service: readFileSync(path.join(state, "service"), "utf8").trim(),
      backups: readdirSync(backups),
    };
  }
  return {
    root, app, data, backups, lockDir, lockFile, execute,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function scenarioCase(name, verify) {
  test(name, { timeout: 50000 }, () => {
    const fixture = sandbox(name.split(":")[0]);
    try { verify(fixture.execute(), fixture); }
    finally { fixture.cleanup(); }
  });
}
scenarioCase("lowspace: reject before stop and do not touch data", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /malo mista/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("stop"), false);
  assert.deepEqual(r.backups, []);
});
scenarioCase("partialcopy: ENOSPC during backup removes only partial copy and restarts old service", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /simulated ENOSPC/);
  assert.match(r.output, /Puvodni sluzba obnovena/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.deepEqual(r.backups, [], "partial backup must release occupied disk");
  assert.equal(r.events.includes("stop"), true);
});
scenarioCase("buildfail: rollback rebuilds original code and keeps verified backup", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /simulated build failure/);
  assert.match(r.output, /Rollback: puvodni verze dostupna a zaznamy zachovany/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.includes("rollback-lock-held"), true,
    "exclusive lock must still be active inside the EXIT trap's rollback build");
  assert.equal(spawnSync("flock", ["-n", f.lockFile, "true"]).status, 0,
    "lock is released after rollback completes");
  assert.equal(r.backups.length, 1);
  assert.equal(existsSync(path.join(f.backups, r.backups[0], "SHA256SUMS")), true);
  assert.ok(statSync(path.join(f.app, ".next/BUILD_ID")).mode & 0o040,
    "rollback must restore group-readable BUILD_ID");
});
scenarioCase("outboxcompact: legitimate semantic invalidation compaction does not trigger rollback", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /NASAZENI DOKONCENO/);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), false, "compacting a derived queue must never roll back code");
  assert.equal(r.backups.length, 1);
  const db = new DatabaseSync(path.join(f.data, "store.sqlite"));
  try {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM semantic_index_outbox").get().n;
    assert.equal(rows, 1, "trigger compacts 1001 invalidations to one rebuild marker");
    assert.deepEqual(db.prepare("SELECT object_type, object_id, operation FROM semantic_index_outbox").get(),
      { object_type: "rebuild", object_id: "*", operation: "queue_compacted" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 2,
      "canonical user rows stay unchanged");
  } finally { db.close(); }
  const before = JSON.parse(readFileSync(path.join(f.backups, r.backups[0], "before.json"), "utf8"));
  const after = JSON.parse(readFileSync(path.join(f.backups, r.backups[0], "after.json"), "utf8"));
  assert.equal(before.tables.semantic_index_outbox, 1000);
  assert.equal(after.tables.semantic_index_outbox, 1);
});

scenarioCase("rowloss: rollback refuses to certify lost canonical rows", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /KRITICKY UBYTEK zaznamu: entities/);
  assert.match(r.output, /KRITICKA CHYBA: rollback neobnovil pocet zaznamu/);
  assert.doesNotMatch(r.output, /Rollback: puvodni verze dostupna a zaznamy zachovany/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.backups.length, 1, "verified backup must be preserved for owner decision");
  assert.ok(existsSync(path.join(f.backups, r.backups[0], "rollback.json")));
});
scenarioCase("unhealthy: failed HTTP readiness triggers verified code rollback", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /sluzba nebo lokalni\/HTTPS API nejsou dostupne/);
  assert.match(r.output, /Rollback: puvodni verze dostupna a zaznamy zachovany/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.backups.length, 1);
});
scenarioCase("httpsfail: blocked Tailscale HTTPS triggers code rollback", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /sluzba nebo lokalni\/HTTPS API nejsou dostupne/);
  assert.match(r.output, /Rollback: puvodni verze dostupna a zaznamy zachovany/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.backups.length, 1);
});
scenarioCase("corruptcopy: reject mismatched env, remove incomplete backup, restart original", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /zaloha env neodpovida originalu/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.deepEqual(r.backups, []);
});
scenarioCase("success: complete synthetic deploy validates build permissions and preserves data", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /NASAZENI DOKONCENO/);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.backups.length, 1);
  assert.ok(statSync(path.join(f.app, ".next/BUILD_ID")).mode & 0o040);
  assert.ok(existsSync(path.join(f.backups, r.backups[0], "env")));
  assert.equal(statSync(f.lockFile).mode & 0o777, 0o600, "lock file is root-readable only");
  assert.equal(statSync(f.lockDir).mode & 0o777, 0o700, "lock directory is private");
  assert.equal(spawnSync("flock", ["-n", f.lockFile, "true"]).status, 0,
    "successful deploy releases lock without unlinking its inode");
});

test("exclusive deployment lock rejects a second process before any service or repository change", { timeout: 15000 }, async () => {
  const fixture = sandbox("concurrent");
  const { lockDir, lockFile } = fixture;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const owner = spawn("flock", ["-n", "-F", lockFile, process.execPath, "-e",
    "process.stdout.write('LOCKED\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("lock owner did not acquire lock")), 4000);
      owner.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
      owner.once("error", (error) => { clearTimeout(timeout); reject(error); });
      owner.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`lock owner exited early: ${code}`)); });
    });
    const result = fixture.execute();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /jine nasazeni uz probiha/);
    assert.equal(result.service, "active");
    assert.equal(result.head, oldSha);
    assert.deepEqual(result.backups, []);
    assert.equal(result.events.includes("stop"), false);
    assert.equal(result.events.includes("merge"), false);
    assert.equal(result.events.includes("reset"), false);
  } finally {
    owner.kill("SIGTERM");
    fixture.cleanup();
  }
});
