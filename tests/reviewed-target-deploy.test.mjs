import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

test("first rollout executes the reviewed target deployment script, not the old checkout copy", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-reviewed-deploy-"));
  try {
    const bare = path.join(root, "origin.git");
    const source = path.join(root, "source");
    const checkedOut = path.join(root, "checked-out");
    run("git", ["init", "--bare", bare]);
    run("git", ["init", "-b", "main", source]);
    run("git", ["-C", source, "config", "user.email", "test-only@invalid.example"]);
    run("git", ["-C", source, "config", "user.name", "Synthetic release test"]);
    mkdirSync(path.join(source, "deployment"));
    const file = path.join(source, "deployment", "deploy-safe.sh");
    writeFileSync(file, '#!/usr/bin/env bash\necho OLD > "$MARKER"\n');
    run("git", ["-C", source, "add", "."]);
    run("git", ["-C", source, "commit", "-m", "old deployed version"]);
    run("git", ["-C", source, "remote", "add", "origin", bare]);
    run("git", ["-C", source, "push", "origin", "main"]);
    run("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
    run("git", ["clone", "-b", "main", bare, checkedOut]);
    const oldSha = run("git", ["-C", checkedOut, "rev-parse", "HEAD"]);
    writeFileSync(file, '#!/usr/bin/env bash\necho NEW > "$MARKER"\ngit rev-parse HEAD > "$HEAD_AT_EXECUTION"\n');
    run("git", ["-C", source, "add", "."]);
    run("git", ["-C", source, "commit", "-m", "reviewed target version"]);
    run("git", ["-C", source, "push", "origin", "main"]);
    const targetSha = run("git", ["-C", source, "rev-parse", "HEAD"]);
    const runbook = readFileSync("deployment/DEPLOY.md", "utf8");
    const match = runbook.match(/sudo bash -c '([^']+)' _ "\$TARGET_SHA"/);
    assert.ok(match, "the documented bootstrap command is the one exercised by the test");
    const snippet = match[1].replace("/opt/ai-executive", checkedOut);
    const marker = path.join(root, "used-script");
    const headMarker = path.join(root, "head-at-execution");
    const env = { ...process.env, MARKER: marker, HEAD_AT_EXECUTION: headMarker };
    run("bash", ["-c", snippet, "_", targetSha], { env });
    assert.equal(readFileSync(marker, "utf8").trim(), "NEW", "new target script, not stale checked-out script, must execute");
    assert.equal(readFileSync(headMarker, "utf8").trim(), oldSha, "new script must execute before checkout updates");
    rmSync(marker);
    const mismatch = spawnSync("bash", ["-c", snippet, "_", oldSha], { env, encoding: "utf8" });
    assert.notEqual(mismatch.status, 0, "launcher refuses any SHA not equal to remote main");
    assert.equal(existsSync(marker), false, "mismatched SHA never executes a deployment script");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
