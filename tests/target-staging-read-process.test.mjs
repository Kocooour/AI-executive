import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createStagingReadRunner, parseStagingPersonalPage } from "../lib/target-staging-read-process.ts";

const config = {
  stagingDirectory: "/synthetic/stage",
  expectedRestoreGeneration: "123e4567-e89b-42d3-a456-426614174000",
  ownerUserId: "alice",
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  child.finish = (payload, code = 0) => {
    if (payload !== undefined) child.stdout.write(JSON.stringify(payload));
    child.emit("close", code);
  };
  return child;
}

test("two child slots are shared; third read fails closed and a freed slot recovers", async () => {
  const children = [];
  const run = createStagingReadRunner(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }, 1_000);
  const first = run(config, "target-staging-detail-child.mjs", ["one"]);
  const second = run(config, "target-staging-read-child.mjs", ["1", "0"]);
  assert.equal(children.length, 2);
  assert.equal(await run(config, "target-staging-detail-child.mjs", ["three"]), null);
  assert.equal(children.length, 2, "over capacity must not spawn");
  children[0].finish({ ok: true });
  assert.deepEqual(await first, { ok: true });
  const recovered = run(config, "target-staging-detail-child.mjs", ["three"]);
  assert.equal(children.length, 3);
  children[1].finish({ ok: false });
  children[2].finish({ ok: true, recovered: true });
  assert.deepEqual(await second, { ok: false });
  assert.deepEqual(await recovered, { ok: true, recovered: true });
});

test("timeout hard-kills child, ignores late successful output, and releases slot", async () => {
  const children = [];
  const run = createStagingReadRunner(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }, 10);
  const timedOut = run(config, "target-staging-detail-child.mjs", ["one"]);
  assert.equal(await timedOut, null);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  const recovered = run(config, "target-staging-detail-child.mjs", ["two"]);
  children[1].finish({ ok: true });
  assert.deepEqual(await recovered, { ok: true });
});

test("spawn errors and oversized child output fail closed without leaking slots", async () => {
  let attempts = 0;
  const children = [];
  const run = createStagingReadRunner(() => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic spawn failure");
    const child = fakeChild();
    children.push(child);
    return child;
  }, 1_000);
  assert.equal(await run(config, "target-staging-detail-child.mjs", ["one"]), null);
  const oversized = run(config, "target-staging-detail-child.mjs", ["two"]);
  children[0].stdout.write(Buffer.alloc(1024 * 1024 + 1));
  assert.equal(await oversized, null);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  const recovered = run(config, "target-staging-detail-child.mjs", ["three"]);
  children[1].finish({ ok: true });
  assert.deepEqual(await recovered, { ok: true });
});

test("asynchronous child error and nonzero exit release capacity", async () => {
  const children = [];
  const run = createStagingReadRunner(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }, 1_000);
  const failed = run(config, "target-staging-detail-child.mjs", ["one"]);
  children[0].emit("error", new Error("synthetic launch failure"));
  children[0].finish({ ok: true });
  assert.equal(await failed, null);
  const exited = run(config, "target-staging-detail-child.mjs", ["two"]);
  children[1].finish(undefined, 1);
  assert.equal(await exited, null);
  const recovered = run(config, "target-staging-detail-child.mjs", ["three"]);
  children[2].finish({ ok: true });
  assert.deepEqual(await recovered, { ok: true });
});

test("personal page output rejects unexpected fields instead of forwarding private metadata", () => {
  const task = {
    id: "one", title: "Visible", projectId: null,
    effectiveAreaId: "private", areaKind: "private", assigneeUserId: null,
  };
  const page = { ok: true, tasks: [task], hasMore: false, revision: "a".repeat(64) };
  assert.deepEqual(parseStagingPersonalPage(page), {
    tasks: [task], hasMore: false, revision: page.revision,
  });
  assert.equal(parseStagingPersonalPage({ ...page, internal: "do not expose" }), null);
  assert.equal(parseStagingPersonalPage({ ...page,
    tasks: [{ ...task, privateNote: "do not expose" }],
  }), null);
});
