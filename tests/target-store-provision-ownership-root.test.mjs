import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provision = path.join(repo, "scripts/target-store-provision.mjs");
const files = ["lumi-target.journal", "lumi-target-witness.sqlite", "lumi-target.sqlite"].sort();
const sha = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");
const snapshot = dir => Object.fromEntries(files.map(name => [name, sha(path.join(dir, name))]));

function run(args, legacy) {
  return spawnSync(process.execPath, [provision, ...args], {
    cwd: repo, encoding: "utf8", timeout: 30000,
    env: {
      ...process.env,
      AI_EXECUTIVE_DATA_DIR: legacy,
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: "",
    },
  });
}

// Run the whole dedicated file from the required PR security step, WITHOUT a
// name-pattern filter. If the file is missing or this test fails, CI fails.
// Ordinary unprivileged local/main regression runs may skip this one test.
test("privileged --check rejects foreign-owned directory and each companion", {
  skip: process.env.R4_REQUIRE_ROOT_OWNERSHIP_TEST !== "1" && process.geteuid?.() !== 0
    ? "requires root to create a foreign-UID fixture" : false,
}, t => {
  assert.equal(process.geteuid?.(), 0, "privileged ownership regression must run as root");
  const base = mkdtempSync(path.join(tmpdir(), "lumi-r4-foreign-owner-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const legacy = path.join(base, "legacy");
  mkdirSync(legacy, { mode: 0o700 });
  writeFileSync(path.join(legacy, "sentinel"), "never overwrite", { mode: 0o600 });
  const dir = path.join(base, "target");

  const provisioned = run([dir, "owner", "--confirmed"], legacy);
  assert.equal(provisioned.status, 0, provisioned.stderr);
  const baseline = snapshot(dir);
  const foreignUid = 65534; // synthetic unprivileged UID; no account required

  for (const currentPath of [dir, ...files.map(name => path.join(dir, name))]) {
    const original = lstatSync(currentPath);
    chownSync(currentPath, foreignUid, original.gid);
    try {
      assert.equal(lstatSync(currentPath).uid, foreignUid);
      const denied = run(["--check", dir], legacy);
      assert.notEqual(denied.status, 0, currentPath);
      assert.equal(denied.stdout, "");
      assert.match(denied.stderr, /^R4 target provision: FAIL — [^\n]+\n$/);
      assert.match(denied.stderr, /ownership or type is unsafe/);
      assert.deepEqual(snapshot(dir), baseline);
      const current = lstatSync(currentPath);
      assert.equal(current.uid, foreignUid, "read-only check must not repair ownership");
      assert.equal(current.mode & 0o7777, currentPath === dir ? 0o700 : 0o600);
    } finally {
      chownSync(currentPath, original.uid, original.gid);
    }
  }

  const verified = run(["--check", dir], legacy);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, "");
  assert.equal(verified.stdout, provisioned.stdout);
  assert.deepEqual(snapshot(dir), baseline);
});
