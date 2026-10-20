#!/usr/bin/env node
// Test-only command shims. NEVER installed on a production server.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = process.env.LUMI_TEST_ROOT;
if (!root || !root.includes("lumi-deploy-test-")) process.exit(92);
const name = process.env.LUMI_TEST_COMMAND || path.basename(process.argv[1]);
const args = process.argv.slice(2);
const app = path.join(root, "opt/ai-executive");
const dbFile = path.join(root, "var/lib/ai-executive/store.sqlite");
const state = path.join(root, "state");
const scenario = process.env.LUMI_TEST_SCENARIO;
const before = "a".repeat(40);
const target = "b".repeat(40);
const stateFile = (f) => path.join(state, f);
const get = (f) => fs.readFileSync(stateFile(f), "utf8").trim();
const set = (f,v) => fs.writeFileSync(stateFile(f), String(v));
const log = (value) => fs.appendFileSync(stateFile("events"), value + "\n");
function run(real, actualArgs) {
  const child = spawnSync(real, actualArgs, { stdio: "inherit", env: process.env });
  process.exit(child.status ?? 98);
}
switch (name) {
  case "id":
    if (args[0] === "-u") { console.log("0"); break; }
    process.exit(8);
  case "stat":
    if (args[0] === "-c" && args[1] === "%u") { console.log("0"); break; }
    process.exit(8);
  case "du":
    console.log("5120\t" + args[args.length - 1]); break;
  case "df":
    console.log("Filesystem 1024-blocks Used Available Capacity Mounted on");
    console.log("synthetic 20000000 1000 " + (scenario === "lowspace" ? "1024" : "12000000") + " 1% /");
    break;
  case "getent":
    if (args[0] === "group" && args[1] === "ai-executive") { console.log("ai-executive:x:999:"); break; }
    process.exit(8);
  case "chgrp":
    // No root privileges in CI. runuser's permission test inspects the actual group mode bits.
    break;
  case "sleep":
    // Avoid the 60-second readiness timeout in fault-injection tests.
    break;
  case "systemctl": {
    const verb = args[0];
    if (verb === "is-active") {
      const active = get("service") === "active";
      if (!args.includes("--quiet")) console.log(active ? "active" : "inactive");
      process.exit(active ? 0 : 3);
    }
    if (verb === "show") {
      const prop = args[args.indexOf("-p") + 1];
      console.log(prop === "User" ? "ai-executive" : prop === "WorkingDirectory" ? app : "");
      break;
    }
    if (verb === "stop") { set("service", "inactive"); log("stop"); break; }
    if (verb === "start") {
      if (scenario === "rowloss" && get("head") === target && !fs.existsSync(stateFile("deleted"))) {
        const db = new DatabaseSync(dbFile);
        try { db.prepare("DELETE FROM entities WHERE id = 'task:keep'").run(); }
        finally { db.close(); }
        set("deleted", "1");
      }
      if (["sessionretention", "sessionloss", "intervalloss"].includes(scenario) &&
          get("head") === target && !fs.existsSync(stateFile("retention-run"))) {
        const db = new DatabaseSync(dbFile);
        try {
          db.exec("BEGIN IMMEDIATE");
          try {
            if (scenario === "sessionretention") {
              // Follow the same finish/retention rules as lib/work-sessions.ts:
              // complete the active session, delete intervals of expired completed
              // sessions, then retain the 1000 most recent completed sessions.
              db.prepare("UPDATE work_sessions SET state='completed',completed_at=? WHERE id=?")
                .run(20000, "session:active");
              const expired = db.prepare(`SELECT id FROM work_sessions WHERE workspace_id=? AND state='completed'
                ORDER BY completed_at DESC LIMIT -1 OFFSET 1000`).all("personal");
              for (const item of expired)
                db.prepare("DELETE FROM work_session_intervals WHERE session_id=?").run(item.id);
              db.prepare(`DELETE FROM work_sessions WHERE workspace_id=? AND state='completed' AND id IN
                (SELECT id FROM work_sessions WHERE workspace_id=? AND state='completed'
                ORDER BY completed_at DESC LIMIT -1 OFFSET 1000)`).run("personal", "personal");
            } else if (scenario === "sessionloss") {
              db.prepare("DELETE FROM work_session_intervals WHERE session_id=?").run("session:active");
              db.prepare("DELETE FROM work_sessions WHERE id=?").run("session:active");
            } else {
              db.prepare("DELETE FROM work_session_intervals WHERE id=?").run("interval:1");
            }
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        } finally { db.close(); }
        set("retention-run", "1");
        log("session-retention-" + scenario);
      }
      if (scenario === "outboxcompact" && get("head") === target && !fs.existsSync(stateFile("compacted"))) {
        // Trigger a real SQLite compaction on first start of the new version.
        const db = new DatabaseSync(dbFile);
        try {
          db.prepare(`INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
            VALUES ('claim', 'claim-overflow', 'personal', 'update')`).run();
          const row = db.prepare("SELECT COUNT(*) AS n FROM semantic_index_outbox").get();
          if (row.n !== 1) throw new Error("expected production-style queue compaction");
        } finally { db.close(); }
        set("compacted", "1");
        log("outbox-compacted");
      }
      set("service", "active"); log("start-" + get("head").slice(0,1)); break;
    }
    process.exit(8);
  }
  case "git": {
    const verb = args[0];
    if (verb === "branch" && args[1] === "--show-current") console.log("main");
    else if (verb === "status" && args[1] === "--porcelain") {}
    else if (verb === "rev-parse") console.log(args[1] === "FETCH_HEAD" ? target : get("head"));
    else if (verb === "fetch" || verb === "merge-base" || verb === "diff") {}
    else if (verb === "merge" && args[1] === "--ff-only") {
      set("head", target); log("merge");
    } else if (verb === "reset" && args[1] === "--hard") {
      set("head", before); log("reset");
    } else process.exit(8);
    break;
  }
  case "pnpm":
    if (args[0] === "install") { log("install"); break; }
    if (args[0] === "build") {
      log("build-" + get("head").slice(0, 1));
      if (scenario === "buildfail" && get("head") === before) {
        // The old-version rebuild runs from the EXIT trap, not from the mainline.
        // Probe with an independent flock FD; it MUST NOT be able to acquire it.
        const probe = spawnSync("flock", ["-n", process.env.LUMI_TEST_LOCK_FILE, "true"]);
        if (probe.status === 0) {
          console.error("rollback lock unexpectedly released before build");
          process.exit(91);
        }
        log("rollback-lock-held");
      }
      if (scenario === "buildfail" && get("head") === target &&
          !fs.existsSync(stateFile("buildfailed"))) {
        set("buildfailed", "1");
        console.error("simulated build failure");
        process.exit(17);
      }
      const next = path.join(app, ".next");
      fs.mkdirSync(path.join(next, "server"), { recursive: true });
      fs.writeFileSync(path.join(next, "BUILD_ID"), get("head"));
      fs.chmodSync(path.join(next, "BUILD_ID"), 0o600);
      break;
    }
    process.exit(8);
  case "runuser": {
    if (args[0] !== "-u" || args[1] !== "ai-executive" || args[2] !== "--") process.exit(8);
    const exec = args[3], rest = args.slice(4);
    if (exec === "test") {
      const file = rest[1], mode = rest[0];
      const perm = fs.statSync(file).mode & 0o777;
      process.exit(mode === "-r" ? ((perm & 0o040) ? 0 : 1) :
                   mode === "-x" ? ((perm & 0o010) ? 0 : 1) : 8);
    }
    run(exec, rest);
    break;
  }
  case "cp": {
    if (scenario === "partialcopy" && args[args.length - 2] === path.join(root, "var/lib/ai-executive")) {
      const destination = args[args.length - 1];
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "incomplete"), Buffer.alloc(512 * 1024));
      console.error("simulated ENOSPC while copying");
      process.exit(28);
    }
    if (scenario === "corruptcopy" && args[args.length - 2] === path.join(root, "etc/ai-executive/ai-executive.env")) {
      const saved = spawnSync("/bin/cp", args, { stdio: "inherit" });
      if (saved.status !== 0) process.exit(saved.status || 1);
      fs.appendFileSync(args[args.length - 1], "tampered\n");
      break;
    }
    run("/bin/cp", args);
    break;
  }
  case "curl": {
    if (get("service") !== "active") process.exit(7);
    const url = args[args.length - 1];
    if (scenario === "httpsfail" && get("head") === target &&
        url.startsWith("https://")) process.exit(22);
    if (scenario === "unhealthy" && get("head") === target &&
        url.includes("/manifest.webmanifest")) process.exit(22);
    const code = url.includes("/api/store") ? 401 : 200;
    if (args.includes("-w")) process.stdout.write(String(code));
    break;
  }
  default:
    console.error("unexpected test shim: " + name);
    process.exit(8);
}
