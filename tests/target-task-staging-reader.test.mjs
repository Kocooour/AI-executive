import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-preflight-reader-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy data unchanged");
const previous = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const {
  listPreflightedIsolatedTargetTasks: listTasks,
  readPreflightedIsolatedTargetTask: readTask,
} = await import("../lib/target-task-staging-reader.ts");
const { TARGET_STAGING_TASK_READ_AUDIENCE: audience, listAuthenticatedIsolatedTargetTasks } =
  await import("../lib/target-task-authenticated-read.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { withPinnedTargetSnapshot } = await import("../lib/target-store-read-snapshot.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"),
  ownerUserId: "alice",
});
const store = {
  stagingDirectory: stage.directory,
  expectedRestoreGeneration: stage.restoreGeneration,
};
const writer = new DatabaseSync(stage.databasePath);
writer.exec("PRAGMA foreign_keys = ON");
writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('shared-space','shared','alice')").run();
writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('shared-area','Shared','shared','shared-space','alice')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('shared-area','alice','admin')").run();
writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('shared-area','bob','editor')").run();
const add = writer.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,?)");
add.run("alice-private", stage.unassignedAreaId, "Alice only", null);
add.run("bob-private-task", "bob-private", "Bob only", null);
add.run("shared-alice", "shared-area", "Shared with Alice", "alice");
add.run("shared-bob", "shared-area", "Shared with Bob", "bob");

after(() => {
  writer.close();
  if (previous === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const key = randomBytes(32);
const sign = (sub = "alice", changes = {}, signingKey = key) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1, aud: audience, sub, gen: stage.restoreGeneration,
    iat: now - 5, exp: now + 100, ...changes,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update("lumi:r2:target-task-read:staging:v1\0")
    .update(payload).digest("base64url");
  return payload + "." + signature;
};
const credentials = (sub = "alice", changes = {}) => ({
  signingKey: key, sessionToken: sign(sub, changes),
});
const list = (sub, scope, config = store) => listTasks(config, credentials(sub), { scope });
const detail = (sub, taskId, config = store) => readTask(config, credentials(sub), { taskId });
const ids = result => {
  assert.equal(result.ok, true);
  return result.tasks.map(task => task.id);
};
const noList = { ok: false, reason: "unauthorized", tasks: [], nextCursor: null };
const noDetail = { ok: false, reason: "unauthorized", task: null };
const unavailable = { ok: false, reason: "unavailable", task: null };

test("preflighted reader keeps every actor inside their live Area ACL", () => {
  assert.deepEqual(ids(list("alice", "personal")), ["alice-private"]);
  assert.deepEqual(ids(list("bob", "personal")), ["bob-private-task"]);
  assert.deepEqual(ids(list("alice", "my-plan")), ["alice-private", "shared-alice"]);
  assert.deepEqual(ids(list("bob", "my-plan")), ["bob-private-task", "shared-bob"]);
  assert.deepEqual(ids(list("bob", "shared")), ["shared-alice", "shared-bob"]);
  assert.deepEqual(detail("bob", "alice-private"), unavailable);
  assert.equal(detail("alice", "shared-bob").task.id, "shared-bob");
});

test("invalid credentials and client-supplied actors never expose private data", () => {
  const forged = { signingKey: randomBytes(32), sessionToken: sign() };
  assert.deepEqual(listTasks(store, forged, { scope: "personal" }), noList);
  assert.deepEqual(readTask(store, forged, { taskId: "alice-private" }), noDetail);
  assert.deepEqual(listTasks(store, credentials("bob"), {
    scope: "personal", actorUserId: "alice",
  }), { ok: false, reason: "invalid_request", tasks: [], nextCursor: null });
  assert.deepEqual(readTask(store, credentials("bob"), {
    taskId: "alice-private", actorUserId: "alice",
  }), { ok: false, reason: "invalid_request", task: null });
});

test("staging path and restore-generation preflight deny unsafe reads", () => {
  const mismatch = { ...store, expectedRestoreGeneration: randomUUID() };
  assert.deepEqual(list("alice", "personal", mismatch), noList);
  assert.deepEqual(detail("alice", "alice-private", mismatch), noDetail);
  assert.deepEqual(list("alice", "personal", {
    ...store, expectedRestoreGeneration: "not-a-uuid",
  }), noList);
  assert.deepEqual(detail("alice", "alice-private", {
    ...store, stagingDirectory: legacy,
  }), noDetail);
  assert.deepEqual(list("alice", "personal", {
    ...store, stagingDirectory: path.join(root, "missing"),
  }), noList);
});

test("activation and noncanonical schema fail closed before any task query", () => {
  writer.prepare("UPDATE metadata SET value='true' WHERE key='activated'").run();
  assert.deepEqual(list("alice", "personal"), noList);
  assert.deepEqual(detail("alice", "alice-private"), noDetail);
  writer.prepare("UPDATE metadata SET value='false' WHERE key='activated'").run();
  writer.exec("CREATE TABLE unexpected_schema_change (id TEXT)");
  assert.deepEqual(list("alice", "personal"), noList);
  assert.deepEqual(detail("alice", "alice-private"), noDetail);
  writer.exec("DROP TABLE unexpected_schema_change");
  assert.deepEqual(ids(list("alice", "personal")), ["alice-private"]);
});

test("a revoked membership is reflected on the next independently opened read", () => {
  assert.equal(detail("bob", "shared-bob").ok, true);
  writer.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='shared-bob'").run();
  writer.prepare("DELETE FROM area_members WHERE area_id='shared-area' AND user_id='bob'").run();
  assert.deepEqual(ids(list("bob", "shared")), []);
  assert.deepEqual(detail("bob", "shared-bob"), unavailable);
  assert.deepEqual(ids(list("bob", "personal")), ["bob-private-task"]);
});

test("no legacy data files are changed by preflighted reads", () => {
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy data unchanged");
});

test("preflighted gateway rejects an otherwise valid SQLite file symlink", () => {
  const linked = path.join(root, "linked-stage");
  mkdirSync(linked);
  symlinkSync(stage.databasePath, path.join(linked, "lumi-target.sqlite"));
  const linkedStore = { ...store, stagingDirectory: linked };
  assert.deepEqual(list("alice", "personal", linkedStore), noList);
  assert.deepEqual(detail("alice", "alice-private", linkedStore), noDetail);
});

test("staging file replacement before SQLite opens cannot redirect its database", {
  skip: !["linux", "darwin"].includes(process.platform),
}, () => {
  const snapshotStage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "swap-stage"), ownerUserId: "alice",
  });
  const originalTitle = "Pinned private title";
  const replacementTitle = "Replacement private title";
  const setup = new DatabaseSync(snapshotStage.databasePath);
  try {
    setup.prepare("INSERT INTO tasks(id,project_id,area_id,title) VALUES (?,NULL,?,?)")
      .run("snapshot-private", snapshotStage.unassignedAreaId, originalTitle);
  } finally { setup.close(); }

  const replacementPath = snapshotStage.databasePath + ".replacement";
  const parkedPath = snapshotStage.databasePath + ".parked";
  copyFileSync(snapshotStage.databasePath, replacementPath);
  const replacement = new DatabaseSync(replacementPath);
  try {
    replacement.prepare("UPDATE tasks SET title=? WHERE id='snapshot-private'")
      .run(replacementTitle);
  } finally { replacement.close(); }

  const descriptor = openSync(snapshotStage.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let moved = false;
  let temporaryDirectory;
  try {
    withPinnedTargetSnapshot(descriptor, (snapshotDirectory, snapshotFd) => {
      temporaryDirectory = snapshotDirectory;

      // The critical attack window: replace the SOURCE pathname before SQLite
      // opens any connection. The query must still use the original bytes.
      renameSync(snapshotStage.databasePath, parkedPath);
      renameSync(replacementPath, snapshotStage.databasePath);
      moved = true;

      const reader = new DatabaseSync(path.join(snapshotDirectory, "lumi-target.sqlite"),
        { readOnly: true });
      try {
        reader.exec("PRAGMA query_only = ON");
        const results = listAuthenticatedIsolatedTargetTasks(reader, {
          signingKey: key, sessionToken: sign("alice", { gen: snapshotStage.restoreGeneration }),
        }, { scope: "personal" }, readDb => inspectIsolatedTargetStore({
          stagingDirectory: snapshotDirectory,
          expectedRestoreGeneration: snapshotStage.restoreGeneration,
          mode: "r2-model",
        }, { db: readDb, fd: snapshotFd }).ok);
        assert.equal(results.ok, true);
        assert.equal(results.tasks.length, 1);
        assert.equal(results.tasks[0].title, originalTitle);
      } finally { reader.close(); }
    });
  } finally {
    closeSync(descriptor);
    if (moved) {
      rmSync(snapshotStage.databasePath);
      renameSync(parkedPath, snapshotStage.databasePath);
    }
  }
  assert.equal(existsSync(temporaryDirectory), false);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy data unchanged");
});

test("an uncommitted rollback-journal writer is denied rather than exposing dirty task data", () => {
  const txStage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "uncommitted-stage"), ownerUserId: "alice",
  });
  const txStore = { stagingDirectory: txStage.directory, expectedRestoreGeneration: txStage.restoreGeneration };
  const txAccess = {
    signingKey: key,
    sessionToken: sign("alice", { gen: txStage.restoreGeneration }),
  };
  const read = () => listTasks(txStore, txAccess, { scope: "personal" });
  const pending = new DatabaseSync(txStage.databasePath);
  try {
    pending.exec("PRAGMA journal_mode = DELETE");
    pending.exec("PRAGMA cache_size = 10");
    const add = pending.prepare(
      "INSERT INTO tasks(id,project_id,area_id,title) VALUES (?,NULL,?,?)",
    );
    for (let i = 0; i < 240; i++) {
      add.run(`tx-item-${String(i).padStart(3, "0")}`, txStage.unassignedAreaId, "committed");
    }
    assert.equal(read().ok, true);

    pending.exec("BEGIN IMMEDIATE");
    try {
      const mutate = pending.prepare("UPDATE tasks SET title=? WHERE id=?");
      for (let i = 0; i < 240; i++) {
        mutate.run("uncommitted-" + "x".repeat(600),
          `tx-item-${String(i).padStart(3, "0")}`);
      }
      assert.equal(existsSync(txStage.databasePath + "-journal"), true);
      // A raw DB copy can include spilled uncommitted pages and still pass
      // integrity_check. The actual staging facade must deny it entirely.
      assert.deepEqual(read(), noList);
      assert.deepEqual(
        readTask(txStore, txAccess, { taskId: "tx-item-000" }),
        noDetail,
      );
    } finally {
      pending.exec("ROLLBACK");
    }
    const committed = read();
    assert.equal(committed.ok, true);
    assert.equal(committed.tasks[0].title, "committed");

    // Fail closed on even an apparently stray rollback journal.
    writeFileSync(txStage.databasePath + "-journal", "stray journal");
    try {
      assert.deepEqual(read(), noList);
    } finally {
      rmSync(txStage.databasePath + "-journal", { force: true });
    }
    assert.equal(read().ok, true);
  } finally {
    pending.close();
  }
});

test("temporary snapshots are cleaned after a denied read", () => {
  const descriptor = openSync(stage.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporaryDirectory;
  try {
    assert.throws(() => withPinnedTargetSnapshot(descriptor, directory => {
      temporaryDirectory = directory;
      throw new Error("Simulated denied read");
    }), /Simulated denied read/);
  } finally {
    closeSync(descriptor);
  }
  assert.equal(existsSync(temporaryDirectory), false);
});
