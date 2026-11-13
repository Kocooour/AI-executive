// C11 deterministic pinned-title contention witness (synthetic SQLite only).
// The leader pauses after fsync of its journal intent, inside BEGIN IMMEDIATE.
// The follower signals ONLY after observing that real SQLite rollback sidecar.
// Releasing the leader from the same process avoids scheduler-dependent parent
// timers; the follower gets exactly one attempt with the production 200ms budget.
import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [mode, inputFile, gate] = process.argv.slice(2);
if (!["leader", "follower"].includes(mode)) throw Error("unknown witness mode");
const { store, command } = JSON.parse(readFileSync(inputFile, "utf8"));
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const realWrite = fs.writeSync;
const realFsync = fs.fsyncSync;
const realLstat = fs.lstatSync;
let intent = false;
if (mode === "leader") {
  fs.writeSync = (fd, data, ...rest) => {
    const value = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const result = realWrite(fd, data, ...rest);
    if (value.includes('"t":"intent"')) intent = true;
    return result;
  };
  fs.fsyncSync = fd => {
    const result = realFsync(fd);
    if (intent) {
      intent = false;
      writeFileSync(path.join(gate, "leader-ready"), "holding pinned title write");
      // The follower itself releases this gate when it has really seen the
      // current SQLite rollback sidecar, not after a guessed sleep interval.
      const until = Date.now() + 10000;
      while (!existsSync(path.join(gate, "follower-contended"))) {
        if (Date.now() > until) throw Error("follower never entered sidecar check");
        wait(2);
      }
    }
    return result;
  };
} else {
  fs.lstatSync = (name, ...rest) => {
    const result = realLstat(name, ...rest);
    if (String(name).endsWith("lumi-target.sqlite-journal") &&
        !existsSync(path.join(gate, "follower-contended")))
      writeFileSync(path.join(gate, "follower-contended"), "observed real pinned write");
    return result;
  };
}
syncBuiltinESMExports();

const { TargetStagingSessionAuthority } =
  await import("../../lib/target-staging-session-authority.ts");
const authority = new TargetStagingSessionAuthority(store);
try {
  const issued = authority.issueWritable("alice");
  if (!issued) throw Error("cannot issue synthetic credential");
  // Issue the follower's REAL authority session before the leader acquires
  // BEGIN IMMEDIATE. Otherwise session issuance's canonical read preflight
  // would itself race the SQLite journal and obscure the 200ms write probe.
  if (mode === "follower") {
    writeFileSync(path.join(gate, "follower-ready"), "preflight finished");
    const until = Date.now() + 10000;
    while (!existsSync(path.join(gate, "leader-ready"))) {
      if (Date.now() > until) throw Error("leader never reached the pinned write gate");
      wait(2);
    }
  }
  const result = mode === "leader"
    ? authority.updateProjectTitle(issued.sessionToken, command, "alice")
    : authority.cancelProjectTitle(issued.sessionToken, {
      projectId: command.projectId, commandId: command.commandId,
      restoreGeneration: command.restoreGeneration,
      principalBinding: command.principalBinding,
    }, "alice");
  writeFileSync(path.join(gate, mode + "-result"), JSON.stringify(result));
} finally {
  authority.close();
}
