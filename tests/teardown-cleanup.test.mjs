import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import teardown, { removeIsolatedRunDir } from "../e2e/teardown.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-e2e-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }));
  return dir;
}

test("run-wide teardown retries a transient ENOTEMPTY", async t => {
  const dir = fixture(t);
  let attempts = 0;
  const warnings = [];
  await removeIsolatedRunDir(dir, {
    cleanupMs: 100, retryMs: 1, warn: warning => warnings.push(warning),
    remove: async directory => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("late Chrome write"), { code: "ENOTEMPTY" });
      await rm(directory, { recursive: true, force: true });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(warnings, []);
});

test("permanent ENOTEMPTY in run-wide teardown warns without throwing", async t => {
  const dir = fixture(t);
  let attempts = 0;
  const warnings = [];
  await removeIsolatedRunDir(dir, {
    cleanupMs: 20, retryMs: 1, warn: warning => warnings.push(warning),
    remove: () => {
      attempts++;
      throw Object.assign(new Error("late Chrome write"), { code: "ENOTEMPTY" });
    },
  });
  assert.ok(attempts > 1, "cleanup should retry while within its time budget");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /run directory cleanup failed/);
  assert.ok(warnings[0].includes(dir), "warning must identify retained synthetic data");
  assert.equal(existsSync(dir), true);
});

test("a real browser-reported error still fails global teardown", async t => {
  const dir = fixture(t);
  const dataDir = path.join(dir, "data");
  mkdirSync(dataDir);
  const database = new DatabaseSync(path.join(dataDir, "store.sqlite"));
  try {
    database.exec("CREATE TABLE security_events (id INTEGER PRIMARY KEY, action TEXT, details TEXT)");
    database.prepare("INSERT INTO security_events (action, details) VALUES (?, ?)")
      .run("client.runtime", JSON.stringify({ kind: "error", message: "synthetic runtime failure" }));
  } finally {
    database.close();
  }
  const original = process.env.LUMI_E2E_RUN_DIR;
  process.env.LUMI_E2E_RUN_DIR = dir;
  try {
    await assert.rejects(teardown(), /synthetic runtime failure/);
  } finally {
    if (original === undefined) delete process.env.LUMI_E2E_RUN_DIR;
    else process.env.LUMI_E2E_RUN_DIR = original;
  }
  assert.equal(existsSync(dir), false, "cleanup is still performed after reported errors");
});

test("run-wide cleanup ignores paths outside synthetic run directories", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "not-lumi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let called = false;
  await removeIsolatedRunDir(dir, {
    remove: () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(existsSync(dir), true);
});
