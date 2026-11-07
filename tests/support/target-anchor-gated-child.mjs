// R2c.4a test child: issues one durable session through the real pinned writer, but
// pauses or dies at a chosen point of the two-phase journal write. Synthetic stores only.
//   pause                 - after the intent is fsynced, signal `ready`, wait for `go`, then finish
//   crash-before-commit   - SIGKILL right after the intent is fsynced (hot SQLite journal remains)
//   crash-before-confirm  - SIGKILL after COMMIT, just before the confirm line is written
//   raw                   - one pinned write with the DEFAULT 200 ms busy timeout (no hook); prints ok|denied|failed
//   raw-cold-gated        - one equally cold 200ms write after an external start barrier
//   raw-cold-gated-fail-before-ready - synthetic startup failure to test parent cleanup
//   plain                 - no hook; `rounds` (argv[5]) sessions are issued back to back
import fs, { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [directory, generation, mode, gate, rounds = "1"] = process.argv.slice(2);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const realWrite = fs.writeSync;
const realFsync = fs.fsyncSync;
let intentWritten = false;
fs.writeSync = (fd, data, ...rest) => {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if ((mode === "crash-before-confirm" || mode === "crash-before-confirm-revoke") && text.includes('"t":"confirm"')) process.kill(process.pid, "SIGKILL");
  const result = realWrite(fd, data, ...rest);
  if (text.includes('"t":"intent"')) intentWritten = true;
  return result;
};
fs.fsyncSync = fd => {
  realFsync(fd);
  if (!intentWritten) return;
  intentWritten = false;
  if (mode === "crash-before-commit") process.kill(process.pid, "SIGKILL");
  if (mode === "pause") {
    writeFileSync(gate + "/ready", "");
    while (!existsSync(gate + "/go")) wait(20);
  }
};
syncBuiltinESMExports();

if (mode === "exclusive-lock") {
  // Synthetic competing connection holds an EXCLUSIVE SQLite lock long enough
  // to exercise the early first-SELECT busy timeout of a pinned writer.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(directory + "/lumi-target.sqlite");
  try {
    db.exec("BEGIN EXCLUSIVE");
    writeFileSync(gate + "/ready", "");
    wait(110);
    db.exec("ROLLBACK");
  } finally { db.close(); }
  process.stdout.write("released");
  process.exit(0);
}
if (mode === "hold-sidecar" || mode === "hold-sidecar-long") {
  // Hold a real rollback journal open while the parent starts a second pinned
  // writer. Roll back so the shared synthetic fixture stays consistent.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(directory + "/lumi-target.sqlite");
  try {
    db.exec("BEGIN IMMEDIATE; UPDATE tasks SET title=title || ' (uncommitted)' WHERE id='t1'");
    if (!existsSync(directory + "/lumi-target.sqlite-journal")) throw new Error("No rollback journal");
    writeFileSync(gate + "/ready", "");
    wait(mode === "hold-sidecar-long" ? 750 : 120);
    db.exec("ROLLBACK");
  } finally { db.close(); }
  process.stdout.write("released");
  process.exit(0);
}
if (mode === "raw" || mode === "raw-many" || mode === "raw-cold-gated" ||
    mode === "raw-cold-gated-fail-before-ready") {
  const { withPinnedTargetStagingWrite } = await import("../../lib/target-staging-pinned-write.ts");
  if (mode === "raw-cold-gated" || mode === "raw-cold-gated-fail-before-ready") {
    // Wait only after loading the real writer and its dependencies. Both cold
    // journal verifications start when the same private gate is released.
    // Do not prewarm the journal or alter the real SQLite 200ms busy_timeout.
    if (!gate) throw new Error("raw-cold-gated requires an isolated gate");
    if (mode === "raw-cold-gated-fail-before-ready") {
      // Test-only fault injection: verifies parent joins the other child before
      // unwinding fixture cleanup, without changing the real writer behavior.
      process.stderr.write("synthetic pre-ready child failure");
      process.exit(42);
    }
    writeFileSync(gate + "/ready-" + process.pid, "");
    while (!existsSync(gate + "/go")) wait(5);
  }
  const counts = { ok: 0, failed: 0, denied: 0 };
  const attempts = mode === "raw-many" ? Number(rounds) : 1;
  for (let i = 0; i < attempts; i++) {
    const outcome = withPinnedTargetStagingWrite(
      { stagingDirectory: directory, expectedRestoreGeneration: generation },
      context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
      () => "denied", () => "failed");
    counts[outcome]++;
  }
  process.stdout.write(JSON.stringify(mode === "raw-many" ?
    counts : { outcome: Object.keys(counts).find(key => counts[key]) }));
  process.exit(0);
}
const durable = await import("../../lib/target-staging-durable-session.ts");
if (mode === "crash-before-confirm-revoke") {
  // gate carries the already-issued durable session ID. Its revocation COMMIT
  // must survive restoration of only the main database, even without JSONL confirm.
  durable.revokeDurableTargetStagingSession(
    { stagingDirectory: directory, expectedRestoreGeneration: generation }, gate);
  throw new Error("Expected SIGKILL during the post-COMMIT confirm");
}
let result = { ok: true };
let done = 0;
for (let i = 0; i < Number(rounds) && result.ok; i++, done++) {
  // "unavailable" is a pre-commit refusal (e.g. another writer's SQLite journal exists right now):
  // retry like an operator would. Any other failure ends the run and is reported.
  for (let attempt = 0; attempt < 200; attempt++) {
    result = durable.issueDurableTargetStagingSession(
      { stagingDirectory: directory, expectedRestoreGeneration: generation }, "alice", 60);
    if (result.ok || result.reason !== "unavailable") break;
    wait(5);
  }
}
process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.ok ? null : result.reason, done }));
