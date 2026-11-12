import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createStagingReadRunner, parseStagingPersonalPage } from "../lib/target-staging-read-process.ts";
import {MAX_MY_PLAN_SLICE_OUTPUT_BYTES} from "../lib/target-my-plan-read-limits.ts";

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

test("child error, timeout, output limit and nonzero exit log distinct sanitized reasons", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const children = [];
    const run = createStagingReadRunner(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }, 1000);
    const childError = run(config, "target-staging-detail-child.mjs", ["one"]);
    children[0].emit("error", new Error("private child details"));
    children[0].finish({ ok: true });
    assert.equal(await childError, null);
    const tooLarge = run(config, "target-staging-detail-child.mjs", ["two"]);
    children[1].stdout.write(Buffer.alloc(1024 * 1024 + 1));
    assert.equal(await tooLarge, null);
    const failed = run(config, "target-staging-detail-child.mjs", ["three"]);
    children[2].finish(undefined, 2);
    assert.equal(await failed, null);
    const timeChildren = [];
    const timeoutRun = createStagingReadRunner(() => {
      const child = fakeChild();
      timeChildren.push(child);
      return child;
    }, 5);
    assert.equal(await timeoutRun(config, "target-staging-detail-child.mjs", ["four"]), null);
    assert.deepEqual(timeChildren[0].kills, ["SIGKILL"]);
  } finally { console.error = original; }
  assert.deepEqual(logged, [
    "[target-staging] stage=read_child reason=child_error error_code=none",
    "[target-staging] stage=read_child reason=output_limit error_code=none",
    "[target-staging] stage=read_child reason=nonzero_exit error_code=none",
    "[target-staging] stage=read_child reason=timeout error_code=none",
  ]);
});

test("master staging HTTP flag is forwarded from the parent, never forced on", async () => {
  const key = "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED";
  const previous = process.env[key];
  const seen = [];
  const run = createStagingReadRunner((_command, _args, options) => {
    seen.push(Object.hasOwn(options.env, key) ? options.env[key] : "<missing>");
    const child = fakeChild();
    queueMicrotask(() => child.finish({ ok: true }));
    return child;
  }, 1_000);
  try {
    for (const value of [undefined, "false", "true"]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      assert.deepEqual(await run(config, "target-staging-attention-child.mjs", []), { ok: true });
    }
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  assert.deepEqual(seen, ["", "false", "true"]);
});

test("three-window My Plan child accepts full 100-row buckets but remains bounded",async()=>{
  const children=[];
  const run=createStagingReadRunner(()=>{const child=fakeChild();children.push(child);return child;},1000);
  const title="x"+String.fromCharCode(1).repeat(4095);
  const tasks=Array.from({length:100},(_,i)=>({taskId:String(i).padStart(3,"0"),title}));
  const payload={ok:true,today:{tasks},tomorrow:{tasks},undated:{tasks}};
  const size=Buffer.byteLength(JSON.stringify(payload),"utf8");
  assert.ok(size>1024*1024);
  assert.ok(size<MAX_MY_PLAN_SLICE_OUTPUT_BYTES);
  const read=run(config,"target-staging-my-plan-slice-child.mjs",[]);
  children[0].finish(payload);
  assert.deepEqual(await read,payload);
  assert.deepEqual(children[0].kills,[]);
  const tooBig=run(config,"target-staging-my-plan-slice-child.mjs",[]);
  children[1].stdout.write(Buffer.alloc(MAX_MY_PLAN_SLICE_OUTPUT_BYTES+1));
  assert.equal(await tooBig,null);
  assert.deepEqual(children[1].kills,["SIGKILL"]);
  const unaffected=run(config,"target-staging-detail-child.mjs",[]);
  children[2].stdout.write(Buffer.alloc(1024*1024+1));
  assert.equal(await unaffected,null);
  assert.deepEqual(children[2].kills,["SIGKILL"]);
});
