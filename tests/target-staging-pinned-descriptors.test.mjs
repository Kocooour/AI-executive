import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("real SQLite fd recycling and Bob's durable-session HTTP list remain available under repeated reads", async () => {
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
        .run("issue164-alice", stage.unassignedAreaId, "Alice private");
      db.prepare("INSERT INTO identities(id) VALUES (?)").run("bob");
      db.prepare("INSERT INTO workspaces(id, kind, owner_user_id) VALUES (?, ?, ?)")
        .run("bob-personal", "personal", "bob");
      db.prepare("INSERT INTO areas(id, title, kind, workspace_id, owner_user_id, system_key) VALUES (?,?,?,?,?,?)")
        .run("bob-private", "Bob", "private", "bob-personal", "bob", "unassigned");
      db.prepare("INSERT INTO tasks(id, area_id, title) VALUES (?,?,?)")
        .run("issue164-bob", "bob-private", "Bob private");
    } finally { db.close(); }
    const unrelatedPath = path.join(root, "unrelated");
    writeFileSync(unrelatedPath, "not a database");
    const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const regularFdSnapshot = () => {
      const descriptors = new Map();
      for (const name of readdirSync(descriptorRoot)) {
        if (!/^[0-9]+$/.test(name)) continue;
        const fd = Number(name);
        try {
          const stat = fstatSync(fd);
          if (stat.isFile()) descriptors.set(fd, { dev: stat.dev, ino: stat.ino });
        } catch { /* the directory scan itself can close its temporary fd */ }
      }
      return descriptors;
    };
    for (let n = 0; n < 24; n++) {
      const pinned = pinTargetStagingFiles(stage.directory);
      assert.ok(pinned, "source database must be pinned");
      const unrelatedFd = openSync(unrelatedPath, "r");
      let unrelatedIsOpen = true;
      let opened;
      let beforeSqliteOpen;
      try {
        opened = pinned.openDatabase({
          readOnly: true,
          afterSnapshotBeforeSQLiteOpen: () => {
            // The production code has already captured its 'before' fd map.
            // Free the numeric fd NOW, before DatabaseSync opens SQLite.
            beforeSqliteOpen = regularFdSnapshot();
            assert.ok(beforeSqliteOpen.has(unrelatedFd));
            closeSync(unrelatedFd);
            unrelatedIsOpen = false;
          },
        });
        opened.db.exec("BEGIN");
        opened.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
        const afterSqliteOpen = regularFdSnapshot();
        const pinnedStat = fstatSync(pinned.databaseFd);
        assert.deepEqual(afterSqliteOpen.get(unrelatedFd),
          { dev: pinnedStat.dev, ino: pinnedStat.ino },
          "SQLite must recycle the just-freed numeric fd for the pinned DB");
        assert.equal(
          [...afterSqliteOpen].filter(([fd]) => !beforeSqliteOpen.has(fd))
            .some(([, stat]) => stat.dev === pinnedStat.dev && stat.ino === pinnedStat.ino),
          false, "the previous fd-number-difference proof must fail on this real scenario");
        assert.equal(
          hasNewPinnedReadDescriptor(beforeSqliteOpen, afterSqliteOpen, pinnedStat),
          true, "the new inode-count proof must succeed on the same real scenario");
        assert.equal(opened.verifyOpened(), true, "production SQLite inode verification must succeed");
        opened.db.exec("ROLLBACK");
      } finally {
        if (opened) opened.db.close();
        if (unrelatedIsOpen) closeSync(unrelatedFd);
        pinned.close();
      }
    }

    const bob = durable.issueDurableTargetStagingSession(store, "bob");
    const alice = durable.issueDurableTargetStagingSession(store, "alice");
    assert.equal(bob.ok, true);
    assert.equal(alice.ok, true);
    const requestFor = (token, ip) => new Request("http://localhost:3001/api/target-staging/tasks", {
      headers: {
        cookie: durable.TARGET_STAGING_SESSION_COOKIE + "=" + token,
        "x-forwarded-for": ip,
      },
    });
    // The FIRST list request below uses Bob's session, not the configured owner.
    const request = requestFor(bob.sessionToken, "10.164.1.1");
    const ownerRequest = requestFor(alice.sessionToken, "10.164.1.2");
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

    // Reproduce the original FIRST GET for a different, non-owner identity.
    // Every subsequent HTTP read must succeed on its FIRST attempt, never retry.
    for (let n = 0; n < 48; n++) {
      const response = await GET(request);
      assert.equal(response.status, 200, "first-attempt Bob HTTP session list #" + n);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json();
      assert.deepEqual(result.tasks.map(task => [task.id, task.title]),
        [["issue164-bob", "Bob private"]], "Bob must not see Alice's private task");
    }
    const aliceResponse = await GET(ownerRequest);
    assert.equal(aliceResponse.status, 200);
    assert.deepEqual((await aliceResponse.json()).tasks.map(task => [task.id, task.title]),
      [["issue164-alice", "Alice private"]], "Alice must not see Bob's private task");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
