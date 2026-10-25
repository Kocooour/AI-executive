import assert from "node:assert/strict";
import test from "node:test";
import { runLatestRecoveryInspection } from "../lib/d2b-recovery-review-request.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("D2b: cancelling an in-flight file selection clears busy and ignores its late result", async () => {
  const sequence = { current: 0 };
  const updates = [];
  const capture = (state) => updates.push(state);
  const slow = deferred();
  const first = runLatestRecoveryInspection(sequence, { name: "old" }, () => slow.promise, capture);
  assert.deepEqual(updates.at(-1), { busy: true, result: null, error: null });
  await runLatestRecoveryInspection(sequence, null, () => Promise.reject(Error("must not run")), capture);
  assert.deepEqual(updates.at(-1), { busy: false, result: null, error: null });
  const beforeLateResponse = updates.length;
  slow.resolve({ totalCandidates: 9 });
  await first;
  assert.equal(updates.length, beforeLateResponse, "a late result must not overwrite cancelled state");
});

test("D2b: second selection wins even when the first read returns last", async () => {
  const sequence = { current: 0 };
  const updates = [];
  const slow = deferred();
  const fast = deferred();
  const publish = (state) => updates.push(state);
  const first = runLatestRecoveryInspection(sequence, "first", () => slow.promise, publish);
  const second = runLatestRecoveryInspection(sequence, "second", () => fast.promise, publish);
  fast.resolve({ totalCandidates: 2 });
  await second;
  assert.deepEqual(updates.at(-1), {
    busy: false, result: { totalCandidates: 2 }, error: null,
  });
  slow.resolve({ totalCandidates: 1 });
  const count = updates.length;
  await first;
  assert.equal(updates.length, count, "old completion cannot replace current summary");
});

test("D2b: stale errors and stale completions never lock the picker", async () => {
  const sequence = { current: 0 };
  const updates = [];
  const slow = deferred();
  const publish = (state) => updates.push(state);
  const first = runLatestRecoveryInspection(sequence, "old", () => slow.promise, publish);
  await runLatestRecoveryInspection(sequence, "new", async () => {
    throw new Error("OFFLINE_REVIEW_SERVER");
  }, publish);
  assert.deepEqual(updates.at(-1), { busy: false, result: null, error: "server" });
  slow.reject(new Error("OFFLINE_REVIEW_INVALID"));
  const count = updates.length;
  await first;
  assert.equal(updates.length, count, "stale error cannot modify current error");
  await runLatestRecoveryInspection(sequence, "third", async () => {
    throw new Error("invalid file");
  }, publish);
  assert.deepEqual(updates.at(-1), { busy: false, result: null, error: "invalid" });
  await runLatestRecoveryInspection(sequence, null, async () => null, publish);
  assert.deepEqual(updates.at(-1), { busy: false, result: null, error: null });
});
