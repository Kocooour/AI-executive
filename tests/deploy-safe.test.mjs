import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { targetPersonalV1Env } from "../lib/target-personal-profile.ts";

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
  const targetDirectory = path.join(root, "var/lib/ai-executive-target/personal-v1");
  const targetGeneration = "2a10b529-66a4-4790-a600-a27f2d996a0f";
  const targetOwner = "owner-01";

  for (const p of [app, data, backups, path.dirname(envfile), state, bin,
    path.join(app, ".next/server"), path.join(app, "scripts"),
    path.join(app, "node_modules/next/dist/bin"), path.join(data, "notes")]) {
    mkdirSync(p, { recursive: true });
  }
  if (scenario.startsWith("target")) {
    mkdirSync(targetDirectory, { recursive: true });
    chmodSync(targetDirectory, 0o700);
    for (const name of ["lumi-target.sqlite", "lumi-target.journal", "lumi-target-witness.sqlite"])
      writeFileSync(path.join(targetDirectory, name),
        name === "lumi-target.sqlite" ? targetOwner + "\n" + targetGeneration : "synthetic " + name,
        { mode: 0o600 });
    const all = targetPersonalV1Env();
    if (scenario === "targetinvalid") {
      for (const name of Object.keys(all).slice(1)) delete all[name];
    }
    writeFileSync(envfile, [
      ...Object.entries(all).map(([key, value]) => key + "=" + value),
      "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=" + targetDirectory,
      "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=" + targetOwner,
      "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=" + targetGeneration,
      "",
    ].join("\n"), { mode: 0o600 });
  } else {
    writeFileSync(envfile, "synthetic-only=true\n", { mode: 0o600 });
  }
  // A systemd EnvironmentFile takes precedence over the four hardcoded
  // Environment= assignments. Never let those keys redirect the app from
  // the canonical data store or change its listener/runtime options.
  const overriddenKey = ({
    offenvdatadir: "AI_EXECUTIVE_DATA_DIR",
    targetenvdatadir: "AI_EXECUTIVE_DATA_DIR",
    offenvport: "PORT",
    offenvnode: "NODE_ENV",
    offenvtelemetry: "NEXT_TELEMETRY_DISABLED",
  })[scenario];
  if (overriddenKey) {
    const value = overriddenKey === "AI_EXECUTIVE_DATA_DIR"
      ? path.join(root, "var/lib/redirected-store") : "unexpected";
    writeFileSync(envfile, readFileSync(envfile, "utf8") +
      overriddenKey + "=" + value + "\n", { mode: 0o600 });
  }
  if (scenario === "offenvcomment") {
    writeFileSync(envfile, readFileSync(envfile, "utf8") +
      "# AI_EXECUTIVE_DATA_DIR=/var/lib/redirected-store\n", { mode: 0o600 });
  }
  if (["offextraenvfile", "targetextraenvfile", "targetsystemddriftbuild"].includes(scenario)) {
    // Exists only in the disposable sandbox, but is never read by the
    // reviewed deploy code: the *loaded systemd list* must reject it.
    writeFileSync(path.join(root, "etc/ai-executive/override.env"),
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true\n", { mode: 0o600 });
  }
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
    if (["sessionretention", "sessionloss", "intervalloss"].includes(scenario)) {
      // Same completed-session/interval retention that work-sessions.ts performs
      // after finishing the active session, in the same SQLite transaction.
      sqlite.exec(`CREATE TABLE work_sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        state TEXT NOT NULL, completed_at INTEGER
      );
      CREATE TABLE work_session_intervals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL
      );`);
      const addSession = sqlite.prepare(
        "INSERT INTO work_sessions(id,workspace_id,state,completed_at) VALUES (?,?,?,?)");
      const addInterval = sqlite.prepare(
        "INSERT INTO work_session_intervals(id,session_id) VALUES (?,?)");
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 1000; i++) {
          addSession.run(`session:completed:${i}`, "personal", "completed", 10000 + i);
          addInterval.run(`interval:${i}`, `session:completed:${i}`);
        }
        addSession.run("session:active", "personal", "running", null);
        addInterval.run("interval:active", "session:active");
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
    if (["mailretention", "mailloss", "maildisable", "mailprestartloss"].includes(scenario)) {
      sqlite.exec("CREATE TABLE mail_sync_accounts(account_id TEXT PRIMARY KEY, workspace_id TEXT, consent_id TEXT, retention_days INTEGER)");
      sqlite.exec("CREATE TABLE mail_sync_messages(account_id TEXT, workspace_id TEXT, message_id TEXT, received_at INTEGER)");
      sqlite.exec(`CREATE TRIGGER mail_sync_consent_removed AFTER DELETE ON mail_sync_accounts BEGIN
        DELETE FROM mail_sync_messages WHERE account_id = OLD.account_id; END;`);
      sqlite.prepare("INSERT INTO mail_sync_accounts VALUES('acct','personal','consent',7)").run();
      const add = sqlite.prepare("INSERT INTO mail_sync_messages VALUES('acct','personal',?,?)");
      add.run("expired", Date.now() - 8 * 86_400_000);
      add.run("current", Date.now() - 2 * 86_400_000);
    }
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
  if (scenario === "targetstatedir") {
    // Map only the absolute systemd StateDirectory root to the synthetic
    // private filesystem. The production code still validates /var/lib.
    const literal = "/var/lib/ai-executive-target/*/) return 0 ;;";
    assert.equal(script.split(literal).length, 2);
    script = script.replace(literal,
      path.join(root, "var/lib/ai-executive-target") + "/*/) return 0 ;;");
  }

  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    LUMI_TEST_ROOT: root,
    LUMI_TEST_SCENARIO: scenario,
    LUMI_TEST_LOCK_FILE: lockFile,
  };
  function execute({ recovery = false } = {}) {
    const result = spawnSync("bash", ["-c", script, "--", newSha, ...(recovery ? ["--recover-stopped"] : [])], {
      cwd: root, env: { ...env, LUMI_TEST_RECOVERY_MODE: recovery ? "true" : "false" },
      encoding: "utf8", timeout: 40000, maxBuffer: 3 * 1024 * 1024,
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
    root, app, data, backups, lockDir, lockFile, targetDirectory, execute,
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
scenarioCase("mailretention: expired Gmail metadata cleanup is accepted during startup", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.match(r.output, /Retence mail metadat overena: 1/);
  const db = new DatabaseSync(path.join(f.data, "store.sqlite"));
  try {
    assert.deepEqual(db.prepare("SELECT message_id FROM mail_sync_messages ORDER BY message_id").all().map(x => x.message_id), ["current"]);
  } finally { db.close(); }
});
scenarioCase("mailloss: active-service Gmail index deletions warn rather than rollback healthy code", (r) => {
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /UPOZORNENI: 1 mail_sync_messages ubylo po spusteni sluzby/);
  assert.match(r.output, /NASAZENI DOKONCENO/);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), false);
});
scenarioCase("maildisable: owner opt-out deletes consent and index after startup without false rollback", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), false);
  assert.match(r.output, /Gmail sync consent a metadata pred spustenim: bez zmen/);
  assert.match(r.output, /UPOZORNENI: 1 mail_sync_accounts se po spusteni sluzby zmenilo\/smazalo/);
  const db = new DatabaseSync(path.join(f.data, "store.sqlite"));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_accounts").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages").get().n, 0);
  } finally { db.close(); }
});
scenarioCase("mailprestartloss: unauthorized consent removal while stopped fails closed", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /KRITICKY UBYTEK\/ZMENA: mail_sync_accounts pri zastavene sluzbe/);
  assert.match(r.output, /KRITICKA CHYBA: Gmail souhlas nebo metadata se zmenily pri zastavene sluzbe/);
  assert.match(r.output, /zachovani Gmail souhlasu\/metadat NENI potvrzeno/);
  assert.doesNotMatch(r.output, /Rollback: puvodni verze dostupna a zaznamy zachovany/,
    "code-only rollback must never certify known lost Gmail consent or indexed messages");
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("start-b"), false, "new code must never serve after offline consent loss");
  assert.equal(r.backups.length, 1, "validated backup is preserved for owner recovery");
  const saved = JSON.parse(readFileSync(path.join(f.backups, r.backups[0], "before-mail.json"), "utf8"));
  assert.equal(saved.accounts.length, 1);
});
scenarioCase("mailsnapshoterror: unreadable prestart snapshot does not falsely report lost Gmail consent", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /simulated read-only Gmail snapshot error/);
  assert.match(r.output, /predstartovni Gmail snapshot neslo precist; nejde o potvrzenou ztratu dat/);
  assert.doesNotMatch(r.output, /Gmail souhlas nebo metadata se zmenily pri zastavene sluzbe/);
  assert.doesNotMatch(r.output, /zachovani Gmail souhlasu\/metadat NENI potvrzeno/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("start-b"), false);
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
    const marker = db.prepare("SELECT object_type, object_id, operation FROM semantic_index_outbox").get();
    assert.equal(marker.object_type, "rebuild");
    assert.equal(marker.object_id, "*");
    assert.equal(marker.operation, "queue_compacted");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 2,
      "canonical user rows stay unchanged");
  } finally { db.close(); }
  const before = JSON.parse(readFileSync(path.join(f.backups, r.backups[0], "before.json"), "utf8"));
  const after = JSON.parse(readFileSync(path.join(f.backups, r.backups[0], "after.json"), "utf8"));
  assert.equal(before.tables.semantic_index_outbox, 1000);
  assert.equal(after.tables.semantic_index_outbox, 1);
});

scenarioCase("sessionretention: finishing active work prunes oldest completed session without rollback", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), false, "verified retention should not roll back code");
  assert.match(r.output, /Retence pracovnich relaci overena: 1/);
  const db = new DatabaseSync(path.join(f.data, "store.sqlite"));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_sessions").get().n, 1000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_session_intervals").get().n, 1000);
    assert.equal(db.prepare("SELECT state FROM work_sessions WHERE id='session:active'").get().state, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_sessions WHERE id='session:completed:0'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 2);
  } finally { db.close(); }
  const backupDir = path.join(f.backups, r.backups[0]);
  const before = JSON.parse(readFileSync(path.join(backupDir, "before.json"), "utf8"));
  const after = JSON.parse(readFileSync(path.join(backupDir, "after.json"), "utf8"));
  assert.equal(before.tables.work_sessions, 1001);
  assert.equal(after.tables.work_sessions, 1000);
  assert.equal(before.tables.work_session_intervals, 1001);
  assert.equal(after.tables.work_session_intervals, 1000);
});
scenarioCase("sessionloss: deletion of a running session cannot masquerade as retention", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /KRITICKY UBYTEK zaznamu: work_sessions/);
  assert.match(r.output, /KRITICKA CHYBA: rollback neobnovil pocet zaznamu/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("reset"), true);
});
scenarioCase("intervalloss: missing interval of retained session is rejected", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /KRITICKY UBYTEK zaznamu: work_session_intervals/);
  assert.match(r.output, /KRITICKA CHYBA: rollback neobnovil pocet zaznamu/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
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
scenarioCase("firstrolloutunhealthy: failed new startup never re-enables pre-revocation owner cookies", (r, f) => {
  assert.notEqual(r.status, 0, "the synthetic first rollout must fail its readiness check");
  assert.match(r.output, /sluzba nebo lokalni\/HTTPS API nejsou dostupne/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: neuspesne nasazeni nebo obnova revokace relaci/);
  assert.equal(r.head, newSha, "must not reset to pre-feature auth code");
  assert.equal(r.service, "inactive", "failed first rollout leaves all owner API traffic stopped");
  assert.equal(r.events.includes("start-b"), true, "new service was tried after cutoff init");
  assert.equal(r.events.includes("start-a"), false, "pre-feature service is never restarted");
  assert.equal(r.events.includes("reset"), false, "old auth code must not be restored automatically");
  assert.equal(r.backups.length, 1, "verified data backup remains available for manual repair");
  const marker = path.join(f.data, "owner-session-valid-from.sqlite");
  assert.equal(existsSync(marker), true, "the real target CLI provisions the persistent cutoff");
  const db = new DatabaseSync(marker, { readOnly: true });
  try {
    const row = db.prepare("SELECT version, valid_from_ms FROM owner_session_cutoff WHERE id = 1").get();
    assert.equal(row.version, 1);
    assert.ok(Number.isSafeInteger(row.valid_from_ms) && row.valid_from_ms > 0);
  } finally { db.close(); }

  // This is a pre-feature owner token: signed with the same session secret,
  // unexpired, but missing issuedAt. The old auth code accepts this format
  // while the target auth rejects it. Never restart the old code after cutoff.
  const secret = "synthetic-first-rollout-session-secret-long-enough";
  const payload = Buffer.from(JSON.stringify({
    subject: "owner", expiresAt: Date.now() + 3600_000,
  })).toString("base64url");
  const oldCookie = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
  const [issuedPayload, issuedSignature] = oldCookie.split(".");
  const original = JSON.parse(Buffer.from(issuedPayload, "base64url").toString("utf8"));
  assert.equal(original.subject, "owner");
  assert.ok(original.expiresAt > Date.now());
  assert.equal(Object.hasOwn(original, "issuedAt"), false);
  assert.equal(issuedSignature, createHmac("sha256", secret).update(issuedPayload).digest("base64url"),
    "pre-feature owner validation would accept this still-signed cookie");
  assert.equal(r.events.includes("start-a"), false, "the vulnerable old authentication is never exposed");
});

test("first rollout: pre-fast-forward backup failure restores old service and allows a healthy retry", { timeout: 90000 }, () => {
  const f = sandbox("firstrolloutpartialcopy");
  try {
    const first = f.execute();
    assert.notEqual(first.status, 0);
    assert.match(first.output, /simulated ENOSPC/);
    assert.match(first.output, /selhal pred zmenou kodu a pred pokusem o inicializaci/);
    assert.equal(first.head, oldSha, "backup failed before fast-forward");
    assert.equal(first.service, "active", "pre-feature service is restored before any cutoff exists");
    assert.equal(first.events.includes("merge"), false);
    assert.equal(first.events.includes("start-a"), true);
    assert.equal(first.events.includes("start-b"), false);
    assert.deepEqual(first.backups, [], "unverified partial backup is deleted");
    const marker = path.join(f.data, "owner-session-valid-from.sqlite");
    assert.equal(existsSync(marker), false, "failed preflight never provisioned cutoff");

    // Fix the synthetic disk failure, then perform an ordinary first rollout.
    const second = f.execute();
    assert.equal(second.status, 0, second.output);
    assert.equal(second.head, newSha);
    assert.equal(second.service, "active");
    assert.equal(second.events.includes("start-b"), true);
    assert.equal(second.events.includes("reset"), false);
    assert.equal(second.backups.length, 1);
    assert.equal(existsSync(marker), true, "healthy retry provisions the real cutoff");
    const db = new DatabaseSync(marker, { readOnly: true });
    try {
      assert.ok(db.prepare("SELECT valid_from_ms FROM owner_session_cutoff WHERE id = 1").get().valid_from_ms > 0);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test("first rollout: old auth is not restarted if cutoff state already exists before backup failure", { timeout: 50000 }, () => {
  const f = sandbox("firstrolloutpartialcopy");
  try {
    const marker = path.join(f.data, "owner-session-valid-from.sqlite");
    writeFileSync(marker, "preexisting-cutoff-must-not-be-treated-as-absent", { mode: 0o600 });
    const result = f.execute();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /BEZPECNOSTNI BLOKACE/);
    assert.equal(result.head, oldSha);
    assert.equal(result.service, "inactive");
    assert.equal(result.events.includes("start-a"), false);
    assert.equal(result.events.includes("merge"), false);
    assert.equal(readFileSync(marker, "utf8"), "preexisting-cutoff-must-not-be-treated-as-absent");
  } finally { f.cleanup(); }
});

test("failed first rollout can recover from a stopped, cutoff-aware checkout without resetting revocation", { timeout: 125000 }, () => {
  const f = sandbox("firstrolloutunhealthy");
  try {
    const first = f.execute();
    assert.notEqual(first.status, 0);
    assert.equal(first.service, "inactive");
    assert.equal(first.head, newSha);
    assert.equal(first.events.includes("start-a"), false);
    const marker = path.join(f.data, "owner-session-valid-from.sqlite");
    assert.equal(existsSync(marker), true);
    const readCutoff = () => {
      const db = new DatabaseSync(marker, { readOnly: true });
      try { return db.prepare("SELECT valid_from_ms FROM owner_session_cutoff WHERE id = 1").get().valid_from_ms; }
      finally { db.close(); }
    };
    const cutoff = readCutoff();
    const normal = f.execute();
    assert.notEqual(normal.status, 0, "normal deployment cannot repair a stopped service");
    assert.match(normal.output, /sluzba nebezi/);
    assert.equal(normal.service, "inactive");
    const saved = marker + ".saved";
    // Recovery may neither create a missing cutoff nor start the service while it is missing.
    renameSync(marker, saved);
    try {
      const missing = f.execute({ recovery: true });
      assert.notEqual(missing.status, 0);
      assert.match(missing.output, /stav revokace relaci chybi nebo je neplatny/);
      assert.equal(missing.service, "inactive");
      assert.equal(missing.events.includes("start-a"), false);
    } finally {
      renameSync(saved, marker);
    }
    const recovered = f.execute({ recovery: true });
    assert.equal(recovered.status, 0, recovered.output);
    assert.equal(recovered.service, "active");
    assert.equal(recovered.head, newSha);
    assert.equal(recovered.events.includes("reset"), false);
    assert.equal(recovered.events.includes("start-a"), false);
    assert.equal(readCutoff(), cutoff, "recovery preserves the exact persisted cutoff");
    assert.ok(recovered.events.filter(x => x === "start-b").length >= 2,
      "only cutoff-aware new code was started");
    assert.equal(recovered.backups.length, 2, "both attempts preserve validated backups");
    const activeRecovery = f.execute({ recovery: true });
    assert.notEqual(activeRecovery.status, 0);
    assert.match(activeRecovery.output, /rezim obnovy vyzaduje zastavenou sluzbu/);
    assert.equal(activeRecovery.service, "active");
  } finally { f.cleanup(); }
});

test("stopped pre-feature code cannot opt into cutoff recovery", { timeout: 50000 }, () => {
  const f = sandbox("success");
  try {
    writeFileSync(path.join(f.root, "state/service"), "inactive");
    const result = f.execute({ recovery: true });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /obnova vyzaduje jiz nasazenou verzi s revokaci relaci/);
    assert.equal(result.service, "inactive");
    assert.equal(result.head, oldSha);
    assert.equal(result.events.includes("start-a"), false);
    assert.deepEqual(result.backups, []);
  } finally { f.cleanup(); }
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


scenarioCase("targetsuccess: quiesced target preflight, shared verified archive, post-start recheck", (r, f) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.backups.length, 1);
  assert.equal(r.events.filter(value => value === "stop").length, 2);
  assert.equal(r.events.filter(value => value === "start-b").length, 2);
  assert.deepEqual(r.events.filter(value => value.startsWith("start-with-target-flags:")),
    ["start-with-target-flags:31", "start-with-target-flags:31"],
    "the two post-deployment service launches both use the fully reviewed profile");
  assert.equal(r.events.filter(value => value === "target-check").length, 4,
    "initial, post-copy, immediately-before-start and post-start semantic checks");
  const firstStart = r.events.findIndex(value => value === "start-b");
  assert.ok(r.events.slice(0, firstStart).filter(e => e === "target-check").length >= 3,
    "all three pre-start checks must complete before target serves requests");
  const archive = path.join(f.backups, r.backups[0]);
  for (const name of ["lumi-target.sqlite", "lumi-target.journal", "lumi-target-witness.sqlite"])
    assert.equal(readFileSync(path.join(archive, "target", name), "utf8"),
      readFileSync(path.join(f.targetDirectory, name), "utf8"));
  const manifest = readFileSync(path.join(archive, "SHA256SUMS"), "utf8");
  assert.match(manifest, /target\/lumi-target.sqlite/);
  assert.match(manifest, /target\/lumi-target.journal/);
  assert.match(manifest, /target\/lumi-target-witness.sqlite/);
});
scenarioCase("targetstatedir: approved isolated StateDirectory permits target rollout", (r) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.filter(e => e === "target-check").length, 4);
});

scenarioCase("targetinvalid: reject partial activation without stopping service", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /neplatny nebo castecny profil/);
  assert.match(r.output, /check names:/);
  assert.equal(r.service, "active");
  assert.equal(r.head, oldSha);
  assert.equal(r.events.includes("stop"), false);
  assert.deepEqual(r.backups, []);
});
scenarioCase("targetunit: refuse writable-store activation without approved systemd sandbox", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /systemd sandbox nedovoluje zapis/);
  assert.equal(r.events.includes("stop"), false);
  assert.equal(r.service, "active");
  assert.deepEqual(r.backups, []);
});
// `EnvironmentFile=` overrides fixed `Environment=` settings. Each
// forbidden assignment must be rejected before stopping or backing up.
for (const scenario of [
  "offenvdatadir", "offenvport", "offenvnode", "offenvtelemetry",
  "targetenvdatadir",
]) {
  scenarioCase(scenario + ": refuse service-unit env override before downtime", (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /neoverene zdroje prostredi systemd/);
    assert.equal(r.service, "active");
    assert.equal(r.head, oldSha);
    assert.equal(r.events.includes("stop"), false,
      "do not back up one data store and restart the app on another");
    assert.deepEqual(r.backups, []);
  });
}

scenarioCase("offenvcomment: commented fixed-unit variable is not an override", (r) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
});

for (const scenario of [
  "targetrwbroad", "targetrwparent", "targetweakprotect",
  "targetstateextra", "targetmixedwrites", "offweakprotect",
]) {
  scenarioCase(scenario + ": refuse unapproved or weakened systemd sandbox", (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /systemd sandbox nedovoluje zapis/);
    assert.equal(r.service, "active");
    assert.equal(r.head, oldSha);
    assert.equal(r.events.includes("stop"), false);
    assert.deepEqual(r.backups, []);
  });
}

// The tracked unit's hardening values are a live contract, not just a
// checked-in file. Refuse unexpected users/groups, writable state modes,
// disabled process protections and new capabilities before any downtime.
for (const scenario of [
  "offuserroot", "targetuserroot", "offbadgroup", "offbadworkdir",
  "offstateworld", "targetstateworld", "targetnonewprivileges",
  "offprivatetmp", "offprotecthome", "offcapabilities",
]) {
  scenarioCase(scenario + ": reject weakened loaded unit security before stop", (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /neoverena identita nebo bezpecnostni profil systemd/);
    assert.equal(r.head, oldSha);
    assert.equal(r.service, "active");
    assert.equal(r.events.includes("stop"), false);
    assert.deepEqual(r.backups, []);
  });
}

scenarioCase("offuserdriftbuild: do not restart service as root after build", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /identita nebo ochrany systemd se pred startem zmenily/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: identita nebo ochrany systemd pri rollbacku/);
  assert.equal(r.events.includes("unit-identity-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("targetuserdriftbuild: do not launch target under changed service user", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /identita nebo ochrany systemd se pred startem zmenily/);
  assert.equal(r.events.includes("unit-identity-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("offhardeningdriftbuild: no off rollback under weakened StateDirectoryMode", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /identita nebo ochrany systemd se pred startem zmenily/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: identita nebo ochrany systemd pri rollbacku/);
  assert.equal(r.events.includes("unit-hardening-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("targethardeningdriftpoststart: refuse second launch after sandbox downgrade", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /identita nebo ochrany systemd se pred druhym startem zmenily/);
  assert.equal(r.events.includes("unit-hardening-changed-after-first-start"), true);
  assert.equal(r.events.filter(e => e === "start-b").length, 1,
    "first launch used hardened systemd; second launch must be blocked");
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.includes("start-a"), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

for (const scenario of ["offexechanged", "targetexechanged", "offextrahook"]) {
  scenarioCase(scenario + ": reject unreviewed loaded execution before downtime", (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /neoverene spousteci prikazy systemd/);
    assert.equal(r.head, oldSha);
    assert.equal(r.service, "active");
    assert.equal(r.events.includes("stop"), false);
    assert.deepEqual(r.backups, []);
  });
}

scenarioCase("offexecdriftbuild: never restart old code under changed loaded ExecStart", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /spousteci prikazy systemd se pred startem zmenily/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: spousteci prikazy systemd pri rollbacku/);
  assert.equal(r.events.includes("unit-exec-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("targetexecdriftbuild: never serve target under changed loaded ExecStart", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /spousteci prikazy systemd se pred startem zmenily/);
  assert.equal(r.events.includes("unit-exec-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("targetexecdriftpoststart: second start refuses changed ExecStart", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /spousteci prikazy systemd se pred druhym startem zmenily/);
  assert.equal(r.events.includes("unit-exec-changed-after-first-start"), true);
  assert.equal(r.events.filter(e => e === "start-b").length, 1,
    "the first start used reviewed command, but no second start may run unreviewed code");
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.includes("start-a"), false,
    "target-enabled failure must not restart old code");
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

// Fail even for a legacy-only env: later EnvironmentFile or manager injection
// can enable unreviewed target flags when the base file looks disabled.
for (const scenario of [
  "offextraenvfile", "targetextraenvfile", "targetenvassignment",
  "targetunsetenvironment", "targetpassenvironment", "targetmanagerenv", "targetpam",
]) {
  scenarioCase(scenario + ": reject unverified effective systemd env before stop", (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /neoverene zdroje prostredi systemd/);
    assert.equal(r.service, "active");
    assert.equal(r.head, oldSha);
    assert.equal(r.events.includes("stop"), false, "reject before any downtime");
    assert.equal(r.events.includes("merge"), false);
    assert.deepEqual(r.backups, []);
  });
}

scenarioCase("offmanagerenvlarge: early target flag in long manager env is rejected", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /neoverene zdroje prostredi systemd/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "active");
  assert.equal(r.events.includes("stop"), false, "an early forbidden flag must be caught under pipefail");
  assert.deepEqual(r.backups, []);
});

scenarioCase("offmanagerenvlargesafe: long manager env without target flags is accepted", (r) => {
  assert.equal(r.status, 0, r.output);
  assert.equal(r.head, newSha);
  assert.equal(r.service, "active");
});

scenarioCase("offsystemddriftbuild: rollback must not restart with a rejected loaded unit", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /zdroje prostredi systemd se pred startem zmenily/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: zdroje prostredi systemd pri rollbacku/);
  assert.equal(r.events.includes("unit-env-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true, "code-only rollback is allowed, not restart");
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "the original service must not reload an unreviewed EnvironmentFile");
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1, "verified backup remains for manual recovery");
});

scenarioCase("offweakprotectbuild: weakened sandbox during build blocks old-code restart", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /systemd sandbox se pred startem zmenil/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE/);
  assert.equal(r.events.includes("sandbox-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("offenvdriftbuild: rollback must not restart with changed root env", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /env se pred startem zmenilo/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: zmeneny obsah \.env pri rollbacku/);
  assert.equal(r.events.includes("env-changed-during-build"), true);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "off profile at initial preflight is insufficient after env mutation");
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1);
});

scenarioCase("targetgeneration: mismatched generation never restarts under rejected flags", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /cilovy preflight: neshoda/);
  assert.match(r.output, /Sluzba zustava zastavena/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.events.includes("stop"), true);
  assert.equal(r.events.includes("merge"), false);
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "no process may reload the unverified target EnvironmentFile");
  assert.deepEqual(r.backups, []);
});
scenarioCase("targetbackupcorrupt: purge partial archive and fail closed without a restart", (r) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /cilova zaloha obsahuje neodpovidajici/);
  assert.match(r.output, /Sluzba zustava zastavena/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.events.includes("merge"), false);
  assert.equal(r.events.some(e => e.startsWith("start-")), false);
  assert.deepEqual(r.backups, []);
});
scenarioCase("targetidentityswap: changed owner/generation after copy preflight blocks first start", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /cilovy preflight se po zaloze zmenil/);
  assert.match(r.output, /Sluzba zustava zastavena/);
  assert.equal(r.head, oldSha, "deployment never switches code when identity changes");
  assert.equal(r.service, "inactive", "rejected target cannot be served under old code");
  assert.equal(r.events.includes("target-identity-swapped"), true);
  assert.equal(r.events.filter(e => e === "target-check").length, 2,
    "initial check and post-copy env-bound semantic check must both run");
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "no target-enabled traffic is allowed before revalidating identity");
  assert.deepEqual(r.backups, [], "unverified backup is discarded without touching live target files");
  assert.match(readFileSync(path.join(f.targetDirectory, "lumi-target.sqlite"), "utf8"), /other-owner/,
    "operator must investigate the changed live store, never auto-restore data");
});
scenarioCase("targetsystemddriftbuild: new loaded EnvironmentFile during build blocks first start", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /zdroje prostredi systemd se pred startem zmenily/);
  assert.equal(r.events.includes("unit-env-changed-during-build"), true);
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "no new-code process may load an extra EnvironmentFile");
  assert.equal(r.service, "inactive");
  assert.equal(r.head, oldSha);
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.backups.length, 1, "verified offline archive is retained");
});

scenarioCase("targetbuildidentitydrift: store swap during build blocks first start", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /cilovy preflight tesne pred startem/);
  assert.match(r.output, /Sluzba zustava zastavena/);
  assert.equal(r.events.includes("target-build-identity-drift"), true);
  assert.equal(r.events.filter(e => e === "target-check").length, 3,
    "the third check must detect a store changed after the verified archive");
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "no request may be served from the new mismatched store");
  assert.equal(r.head, oldSha, "failed pre-start code rollout reverts code only");
  assert.equal(r.events.includes("reset"), true);
  assert.equal(r.service, "inactive");
  assert.equal(r.backups.length, 1, "verified original archive must be preserved");
  const archived = readFileSync(path.join(f.backups, r.backups[0], "target", "lumi-target.sqlite"), "utf8");
  assert.match(archived, /owner-01/, "archive still contains the previously verified owner");
  assert.match(readFileSync(path.join(f.targetDirectory, "lumi-target.sqlite"), "utf8"), /different-owner/,
    "live target never automatically restored or deleted");
});

scenarioCase("targetpostfail: code-only rollback stays stopped after new-code start failed", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /cilovy preflight po prvnim startu selhal/);
  assert.match(r.output, /Sluzba zustava zastavena/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive");
  assert.equal(r.events.includes("reset"), true);
  assert.deepEqual(r.events.filter(e => e.startsWith("start-with-target-flags:")),
    ["start-with-target-flags:31"],
    "only the initial new-code start may see enabled flags");
  assert.equal(r.events.includes("start-b"), true);
  assert.equal(r.events.includes("start-a"), false,
    "old code must never reload the rejected target profile");
  assert.equal(r.backups.length, 1);
  assert.equal(existsSync(path.join(f.backups, r.backups[0], "target", "lumi-target.sqlite")), true);
});


scenarioCase("targetbuildfail: code rollback does not reactivate rejected target profile", (r, f) => {
  assert.notEqual(r.status, 0);
  assert.match(r.output, /synthetic target-enabled build failure/);
  assert.match(r.output, /BEZPECNOSTNI BLOKACE: neuspesna aktivace personal-v1/);
  assert.equal(r.head, oldSha);
  assert.equal(r.service, "inactive", "old service must remain stopped until explicit off confirmation");
  assert.equal(r.events.includes("reset"), true, "code is rolled back without restoring data");
  assert.equal(r.events.some(e => e.startsWith("start-")), false,
    "service must not reload personal-v1 flags after target-enabled build failure");
  assert.equal(r.backups.length, 1);
  assert.equal(existsSync(path.join(f.backups, r.backups[0], "target", "lumi-target.sqlite")), true);
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
