import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/check-data.mjs");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("check-data reports facts for a healthy database and exits 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-data-"));
  try {
    const file = path.join(dir, "store.sqlite");
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE entities (id TEXT, title TEXT); INSERT INTO entities VALUES ('a','secret title'),('b','x'); CREATE TABLE empty (id TEXT)");
    database.close();
    const result = run(file);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.integrity, "ok");
    assert.equal(report.foreignKeyViolations, 0);
    assert.deepEqual(report.tables, { empty: 0, entities: 2 });
    assert.match(report.mainFileSha256, /^[0-9a-f]{64}$/);
    assert.ok(report.mainFileBytes > 0);
    assert.equal(report.walBytes, null);
    assert.ok(!result.stdout.includes("secret title"), "row content must never be printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-data fails for a file that is not a database", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-data-"));
  try {
    const file = path.join(dir, "store.sqlite");
    writeFileSync(file, "this is not a sqlite database, only text ".repeat(50));
    const result = run(file);
    assert.equal(result.status, 1);
    assert.notEqual(JSON.parse(result.stdout).integrity, "ok");
    assert.equal(run(path.join(dir, "missing.sqlite")).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-data reports the WAL file and fails for an empty file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-data-"));
  try {
    const file = path.join(dir, "store.sqlite");
    const database = new DatabaseSync(file);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a')");
    // The connection stays open, so the data is still in -wal.
    const report = JSON.parse(run(file).stdout);
    assert.ok(report.walBytes > 0);
    assert.match(report.walSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(report.tables, { t: 1 });
    database.close();

    const empty = path.join(dir, "empty.sqlite");
    writeFileSync(empty, "");
    const result = run(empty);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).problem, "no-tables");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-data exits 2 without exactly one path", () => {
  assert.equal(run().status, 2);
  assert.equal(run("a", "b").status, 2);
});
