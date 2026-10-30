import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

test("real SQLite inode proof and durable-session HTTP list remain available under repeated reads", async () => {
  // This uses the actual pinned read-only SQLite connection and the original
  // HTTP session route. Each request must succeed on its first attempt.
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-issue164-"));
  const keys = [
    "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
    "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY", "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
    "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    mkdirSync(path.join(root, "legacy"));
    process.env.NODE_ENV = "production";
    process.env.AI_EXECUTIVE_DATA_DIR = path.join(root, "legacy");
    process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" +
      Buffer.alloc(16, 1).toString("base64url") + ":" + Buffer.alloc(64, 2).toString("base64url");
    process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-issue164-session-secret-2026-10-30";
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
    const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
    const { pinTargetStagingFiles } = await import("../lib/target-staging-pinned-write.ts");
    const durable = await import("../lib/target-staging-durable-session.ts");
    const identityLib = await import("../lib/target-staging-http-identity.ts");
    const { GET } = await import("../app/api/target-staging/tasks/route.ts");
    const stage = bootstrapIsolatedTargetStore({
      stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
    });
    const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
    process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
    process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
    process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";

    const db = new DatabaseSync(stage.databasePath);
    try {
      db.prepare("INSERT INTO tasks(id, area_id, title) VALUES (?,?,?)")
        .run("issue164-1", stage.unassignedAreaId, "Synthetic task");
    } finally { db.close(); }
    const unrelatedPath = path.join(root, "unrelated");
    writeFileSync(unrelatedPath, "not a database");
    for (let n = 0; n < 24; n++) {
      const pinned = pinTargetStagingFiles(stage.directory);
      assert.ok(pinned, "source database must be pinned");
      const unrelatedFd = openSync(unrelatedPath, "r");
      let opened;
      try {
        opened = pinned.openDatabase({ readOnly: true });
        // Closing an unrelated *regular* file between the before/after fd
        // scans must not invalidate the SQLite source-inode proof.
        closeSync(unrelatedFd);
        opened.db.exec("BEGIN");
        opened.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
        assert.equal(opened.verifyOpened(), true, "SQLite must open the pinned inode");
        opened.db.exec("ROLLBACK");
      } finally {
        if (opened) opened.db.close();
        else closeSync(unrelatedFd);
        pinned.close();
      }
    }

    const issued = durable.issueDurableTargetStagingSession(store, "alice");
    assert.equal(issued.ok, true);
    const cookie = durable.TARGET_STAGING_SESSION_COOKIE + "=" + issued.sessionToken;
    const request = new Request("http://localhost:3001/api/target-staging/tasks", {
      headers: { cookie, "x-forwarded-for": "10.164.1.1" },
    });
    const identity = identityLib.resolveStagingHttpIdentity(request);
    assert.equal(identity?.kind, "session");

    // A broken pinned directory reliably triggers both admission and release
    // failures without disclosing any session or task content in the logs.
    const broken = { ...store, stagingDirectory: path.join(root, "does-not-exist") };
    const logs = [];
    const previous = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      const refused = identityLib.admitStagingIdentity(request, identity, broken);
      assert.equal(refused?.status, 503);
      assert.equal(identityLib.verifyStagingIdentityBeforeRelease(request, identity, broken), "unavailable");
      assert.equal((await identityLib.stagingUnauthorizedRefusal(request, identity, broken).json()).error,
        "Authentication required");
    } finally { console.error = previous; }
    assert.equal(logs.filter(line => line.includes("stage=identity_admission reason=live_read_unavailable")).length, 1);
    assert.equal(logs.filter(line => line.includes("stage=identity_release reason=live_read_unavailable")).length, 2);

    // Exercise both real live SQLite verification points AND the original
    // route/child response, with no retry and unchanged HTTP expectations.
    for (let n = 0; n < 48; n++) {
      const response = await GET(request);
      assert.equal(response.status, 200, "first-attempt HTTP session list #" + n);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.deepEqual(result.tasks.map(task => task.title), ["Synthetic task"]);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
