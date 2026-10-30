import assert from "node:assert/strict";
import { test } from "node:test";
import { hasNewPinnedReadDescriptor } from "../lib/target-staging-pinned-write.ts";
import { logStagingFailure } from "../lib/target-staging-failure-log.ts";

test("read-only SQLite inode proof accepts an unrelated fd number reused by SQLite", () => {
  const pinned = { dev: 7, ino: 321 };
  const before = new Map([[12, { dev: 1, ino: 123 }], [13, pinned]]);
  const after = new Map([[12, pinned], [13, pinned]]);
  assert.equal(hasNewPinnedReadDescriptor(before, after, pinned), true);
  assert.equal(hasNewPinnedReadDescriptor(before, before, pinned), false);
  assert.equal(hasNewPinnedReadDescriptor(before, new Map([[12, pinned]]), pinned), false);
  assert.equal(hasNewPinnedReadDescriptor(before, new Map([[12, { dev: 4, ino: 9 }], [13, pinned]]), pinned), false);
});

test("staging diagnostic messages contain only allowlisted codes, never exception contents", () => {
  const prev = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    logStagingFailure("live_read", "exception", Object.assign(new Error("private title /secret token"), { code: "SQLITE_BUSY" }));
    logStagingFailure("read_child", "invalid_json", new Error("private stdout"));
  } finally {
    console.error = prev;
  }
  assert.deepEqual(logs, [
    "[target-staging] stage=live_read reason=exception error_code=SQLITE_BUSY",
    "[target-staging] stage=read_child reason=invalid_json error_code=none",
  ]);
});
