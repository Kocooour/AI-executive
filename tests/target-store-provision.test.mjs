import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TARGET_PERSONAL_V1_REQUIRED_SETTINGS } from "../lib/target-personal-profile.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provision = path.join(repo, "scripts/target-store-provision.mjs");
const rehearsal = path.join(repo, "deployment/rehearsal/cutover-restore-rehearsal.mjs");
const names = TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(item => item.name);
const files = ["lumi-target.journal", "lumi-target-witness.sqlite", "lumi-target.sqlite"].sort();
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "lumi-r4-provision-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const legacy = path.join(base, "legacy");
  mkdirSync(legacy, { mode: 0o700 });
  writeFileSync(path.join(legacy, "sentinel"), "never overwrite", { mode: 0o600 });
  return { base, legacy };
}

function run(args, { legacy, cwd = repo, env = {}, script = provision } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: "utf8", timeout: 30000,
    env: {
      ...process.env,
      AI_EXECUTIVE_DATA_DIR: legacy ?? "",
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: "",
      ...env,
    },
  });
}

function rows(output) {
  const lines = output.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const values = lines.map((line, i) => {
    assert.ok(line.startsWith(names[i] + "="), line);
    return line.slice(names[i].length + 1);
  });
  return values;
}
function snapshot(dir) {
  return Object.fromEntries(files.map(name => [name, sha(path.join(dir, name))]));
}
function reject(args, options, candidate, hint = "") {
  const result = run(args, options);
  assert.notEqual(result.status, 0, hint + result.stderr);
  assert.equal(result.stdout, "");
  if (candidate) assert.equal(existsSync(candidate), false, hint);
  return result;
}

test("new target: exactly the required settings, private files, preflight, read-only --check", t => {
  const { base, legacy } = fixture(t);
  const dir = path.join(base, "target");
  const first = run([dir, "owner:alpha", "--confirmed"], { legacy });
  assert.equal(first.status, 0, first.stderr);
  const initial = rows(first.stdout);
  assert.equal(initial[0], dir);
  assert.equal(initial[1], "owner:alpha");
  assert.match(initial[2], /^[a-f0-9-]{36}$/i);
  assert.deepEqual(readdirSync(dir).sort(), files);
  assert.equal(lstatSync(dir).mode & 0o7777, 0o700);
  for (const name of files) {
    const st = lstatSync(path.join(dir, name));
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o7777, 0o600, name);
  }
  assert.deepEqual(readdirSync(base).sort(), ["legacy", "target"]);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "never overwrite");
  const before = snapshot(dir);
  const stats = files.map(name => lstatSync(path.join(dir, name)).mtimeMs);
  const checked = run(["--check", dir], { legacy });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, first.stdout);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(files.map(name => lstatSync(path.join(dir, name)).mtimeMs), stats);
});

test("strict invocation: confirmation, valid owner, absolute new target and existing parent required", t => {
  const { base, legacy } = fixture(t);
  const dir = path.join(base, "destination");
  const options = { legacy };
  reject([dir, "owner"], options, dir, "missing confirmation");
  reject([dir, "owner", "--confirmed", "extra"], options, dir);
  reject([dir, "bad\nowner", "--confirmed"], options, dir);
  reject([dir, "owner", "--yes"], options, dir);
  reject(["relative", "owner", "--confirmed"], options);
  reject([path.join(base, "missing-parent", "target"), "owner", "--confirmed"], options);
  reject(["--check", dir], options, dir, "missing check target");
  reject(["--check", dir, "--confirmed"], options, dir);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "sentinel"), "preserved");
  const existing = reject([dir, "owner", "--confirmed"], options);
  assert.match(existing.stderr, /already exists/);
  assert.equal(readFileSync(path.join(dir, "sentinel"), "utf8"), "preserved");
});

test("reject known live legacy, implicit cwd/.data and configured target paths, including both overlap directions", t => {
  const { base, legacy } = fixture(t);
  const options = { legacy };
  reject([path.join(legacy, "new"), "owner", "--confirmed"], options);
  const configuredFuture = path.join(base, "future-live", "inner");
  const ancestor = path.join(base, "future-live");
  reject([ancestor, "owner", "--confirmed"], {
    legacy, env: { AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: configuredFuture },
  }, ancestor, "must reject target ancestor of live path");
  const currentTarget = path.join(base, "current-staging");
  mkdirSync(currentTarget);
  reject([path.join(currentTarget, "new"), "owner", "--confirmed"], {
    legacy, env: { AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: currentTarget },
  });
  const cwd = path.join(base, "cwd");
  mkdirSync(cwd);
  const implicit = path.join(cwd, ".data");
  reject([implicit, "owner", "--confirmed"], {
    legacy: "", cwd, env: { AI_EXECUTIVE_DATA_DIR: "" },
  }, implicit);
  mkdirSync(implicit);
  reject([path.join(implicit, "new"), "owner", "--confirmed"], {
    legacy: "", cwd, env: { AI_EXECUTIVE_DATA_DIR: "" },
  });
  const liveAlias = path.join(base, "live-alias");
  symlinkSync(legacy, liveAlias, "dir");
  reject([path.join(base, "other"), "owner", "--confirmed"], {
    legacy, env: { AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: path.join(liveAlias, "..", "other") },
  }, path.join(base, "other"), "symlink-before-dotdot in configured paths");
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "never overwrite");
});

test("reject target symlinks, dangling links and normalized/path aliases before bootstrap", t => {
  const { base, legacy } = fixture(t);
  const options = { legacy };
  const alias = path.join(base, "alias");
  symlinkSync(base, alias, "dir");
  reject([path.join(alias, "new"), "owner", "--confirmed"], options);
  const dangling = path.join(base, "dangling");
  symlinkSync(path.join(base, "missing"), dangling, "dir");
  reject([dangling, "owner", "--confirmed"], options);
  reject([path.join(base, "target") + "/", "owner", "--confirmed"], options);
  reject([base + "/./target", "owner", "--confirmed"], options);
  reject([base + "/new/../target", "owner", "--confirmed"], options);
  assert.equal(existsSync(path.join(base, "target")), false);
});

test("repeat provision cannot overwrite existing store, its generation or other bytes", t => {
  const { base, legacy } = fixture(t);
  const dir = path.join(base, "created-once");
  const first = run([dir, "owner", "--confirmed"], { legacy });
  assert.equal(first.status, 0, first.stderr);
  const before = snapshot(dir);
  const rerun = reject([dir, "other", "--confirmed"], { legacy });
  assert.match(rerun.stderr, /already exists/);
  assert.deepEqual(snapshot(dir), before);
  const checked = run(["--check", dir], { legacy });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, first.stdout);
  assert.deepEqual(readdirSync(base).sort(), ["created-once", "legacy"]);
});

test("--check fails closed on permissions and missing security companion; never repairs anything", t => {
  const { base, legacy } = fixture(t);
  const dir = path.join(base, "checked");
  assert.equal(run([dir, "owner", "--confirmed"], { legacy }).status, 0);
  const journal = path.join(dir, "lumi-target.journal");
  const journalHash = sha(journal);
  chmodSync(journal, 0o644);
  reject(["--check", dir], { legacy });
  assert.equal(lstatSync(journal).mode & 0o7777, 0o644);
  assert.equal(sha(journal), journalHash);
  chmodSync(journal, 0o600);
  rmSync(journal);
  reject(["--check", dir], { legacy });
  assert.equal(existsSync(journal), false);
});

test("synthetic provision -> --check -> archived target-offline rehearsal", t => {
  const { base, legacy } = fixture(t);
  const dir = path.join(base, "target");
  const created = run([dir, "synthetic-owner", "--confirmed"], { legacy });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(run(["--check", dir], { legacy }).stdout, created.stdout);
  const offline = path.join(base, "offline-target-copy");
  cpSync(dir, offline, { recursive: true });
  const checkedCopy = run(["--check", offline], { legacy });
  assert.equal(checkedCopy.status, 0, checkedCopy.stderr);
  assert.equal(rows(checkedCopy.stdout)[2], rows(created.stdout)[2]);

  const source = path.join(base, "offline-legacy-copy");
  mkdirSync(source, { mode: 0o700 });
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec("CREATE TABLE entities(id TEXT PRIMARY KEY, payload TEXT);");
    db.prepare("INSERT INTO entities(id,payload) VALUES(?,?)").run("synthetic", "test-only");
  } finally { db.close(); }
  const out = path.join(base, "rehearsal");
  const rehearsed = run([source, out, "--target-offline", offline, "--offline-confirmed"], {
    legacy, script: rehearsal,
  });
  assert.equal(rehearsed.status, 0, rehearsed.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "rehearsal.json"), "utf8"));
  assert.equal(report.target.status, "bytes_and_sqlite_verified");
  assert.equal(report.target.files, 3);
  assert.equal(report.verificationScope, "single_source_copy_fidelity");
  assert.equal(report.independentCaptureEstablished, false);
  assert.deepEqual(snapshot(offline), snapshot(dir));
});
