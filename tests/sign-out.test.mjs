import assert from "node:assert/strict";
import test from "node:test";

const { runSignOut } = await import("../lib/sign-out.ts");

// A scripted browser: `version` is odd while a local write is in progress.
function scenario(overrides = {}) {
  const calls = [];
  const state = { version: 0, unsent: false, clock: 0, ...overrides.state };
  const steps = {
    version: () => state.version,
    sleep: async (ms) => { state.clock += ms; overrides.onTick?.(state); },
    drainSync: async () => { calls.push("drain"); },
    hasUnsent: async () => state.unsent,
    sync: async () => { calls.push("sync"); overrides.onSync?.(state); },
    serverReachable: async () => { calls.push("reachable"); return overrides.reachable ?? true; },
    confirmDiscard: () => { calls.push("confirm"); overrides.onConfirm?.(state); return overrides.discard ?? false; },
    block: () => calls.push("block"),
    unblock: () => calls.push("unblock"),
    endSession: async () => { calls.push("end"); return overrides.end ?? "ok"; },
    wipe: async () => { calls.push("wipe"); },
  };
  return { calls, state, steps };
}

test("a clean state signs out without asking", async () => {
  const run = scenario();
  assert.equal(await runSignOut(run.steps), "signed-out");
  assert.deepEqual(run.calls, ["drain", "block", "end", "wipe"]);
});

test("a local write that outlasts the wait stops sign-out before anything is removed", async () => {
  const run = scenario({ state: { version: 1 } });
  assert.equal(await runSignOut(run.steps, { writeTimeoutMs: 2000 }), "writing");
  assert.ok(run.state.clock >= 2000);
  assert.deepEqual(run.calls, []);
});

test("a write that finishes within the wait is synchronized, then sign-out proceeds", async () => {
  const run = scenario({ state: { version: 1 }, onTick: (state) => { if (state.clock >= 100 && state.version === 1) { state.version = 2; state.unsent = true; } },
    onSync: (state) => { state.unsent = false; } });
  assert.equal(await runSignOut(run.steps), "signed-out");
  assert.deepEqual(run.calls, ["drain", "sync", "block", "end", "wipe"]);
});

test("a write that starts during synchronization is waited for and checked again", async () => {
  let started = false;
  const run = scenario({ state: { unsent: true },
    onSync: (state) => { if (!started) { started = true; state.version = 1; } else if (state.version % 2 === 0) state.unsent = false; },
    onTick: (state) => { if (state.version === 1) state.version = 2; } });
  assert.equal(await runSignOut(run.steps), "signed-out");
  // Round one: two attempts while the write is still running. Round two: the write has finished and is sent.
  assert.deepEqual(run.calls, ["drain", "sync", "sync", "drain", "sync", "block", "end", "wipe"]);
});

test("a write that never finishes is never wiped, whatever round it starts in", async () => {
  const run = scenario({ state: { unsent: true }, onSync: (state) => { state.version = 1; } });
  assert.equal(await runSignOut(run.steps), "writing");
  assert.ok(!run.calls.includes("wipe") && !run.calls.includes("end"));
});

test("unsent changes with an unreachable server keep the session and the data", async () => {
  const run = scenario({ state: { unsent: true }, reachable: false });
  assert.equal(await runSignOut(run.steps), "offline");
  assert.deepEqual(run.calls, ["drain", "sync", "sync", "reachable"]);
});

test("declining to discard keeps the session and the data", async () => {
  const run = scenario({ state: { unsent: true }, discard: false });
  assert.equal(await runSignOut(run.steps), "kept");
  assert.ok(!run.calls.includes("wipe") && !run.calls.includes("end"));
});

test("agreeing to discard signs out and wipes", async () => {
  const run = scenario({ state: { unsent: true }, discard: true });
  assert.equal(await runSignOut(run.steps), "signed-out");
  assert.deepEqual(run.calls, ["drain", "sync", "sync", "reachable", "confirm", "block", "end", "wipe"]);
});

test("a change made while the discard question is open is checked before the wipe", async () => {
  let asked = 0;
  const run = scenario({ state: { unsent: true }, discard: true, onConfirm: (state) => { asked += 1; if (asked === 1) state.version += 2; } });
  assert.equal(await runSignOut(run.steps), "signed-out");
  assert.equal(asked, 2);
  assert.equal(run.calls.filter((call) => call === "wipe").length, 1);
});

test("a failed or unreachable sign-out request removes nothing and releases the page", async () => {
  for (const end of ["failed", "offline"]) {
    const run = scenario({ end });
    assert.equal(await runSignOut(run.steps), end);
    assert.deepEqual(run.calls, ["drain", "block", "end", "unblock"]);
  }
});

test("a synchronization that settles only on the second attempt does not raise the discard question", async () => {
  let attempts = 0;
  const run = scenario({ state: { unsent: true }, onSync: (state) => { attempts += 1; if (attempts === 2) state.unsent = false; } });
  assert.equal(await runSignOut(run.steps), "signed-out");
  assert.deepEqual(run.calls, ["drain", "sync", "sync", "block", "end", "wipe"]);
});
