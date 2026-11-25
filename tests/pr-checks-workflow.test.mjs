import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootTest = "tests/target-store-provision-ownership-root.test.mjs";
const workflow = readFileSync(path.join(repo, ".github/workflows/pr-checks.yml"), "utf8");

test("PR Checks requires the privileged ownership test, even if its file is missing", () => {
  assert.equal(workflow.split("\n  main-regression:").length, 2, "exactly one main-regression job");
  const prJob = workflow.split("\n  main-regression:")[0];
  assert.match(prJob, /name: PR Checks/);
  assert.match(prJob, /runs-on: ubuntu-24\.04/);
  assert.match(prJob, /permissions:\n  contents: read/);

  const block = prJob.split("      - name: Privileged R4 ownership regression\n")[1]
    ?.split("\n      - name: ")[0];
  assert.ok(block, "privileged ownership step must exist in PR Checks");
  assert.match(block, /^\s*if: steps\.scope\.outputs\.code == 'true'\s*$/m);
  assert.doesNotMatch(block, /hashFiles|continue-on-error|--test-name-pattern|--test-skip-pattern/);
  assert.match(block, /set -euo pipefail/);
  assert.match(block, /sudo -n env TMPDIR=\/tmp R4_REQUIRE_ROOT_OWNERSHIP_TEST=1/);
  assert.match(block, /--test --test-reporter=tap/);
  assert.ok(block.includes(rootTest), "dedicated root test must run by filename");
  assert.match(block, / \| tee "\$tap_output"/);
  for (const line of ["# tests 1", "# pass 1", "# fail 0", "# skipped 0"]) {
    assert.ok(block.includes("grep -Fxq '" + line + "' \"$tap_output\""),
      "CI must fail when the expected TAP count is absent: " + line);
  }
  // #493: static checks (typecheck → privileged → build) and the sharded unit
  // suite are separate jobs; the stable "PR Checks" job requires both.
  const staticJob=prJob.split("\n  pr-static:\n")[1]?.split("\n  pr-unit:\n")[0];
  const unitJob=prJob.split("\n  pr-unit:\n")[1]?.split("\n  pr-checks:\n")[0];
  const gateJob=prJob.split("\n  pr-checks:\n")[1];
  assert.ok(staticJob&&unitJob&&gateJob,"pr-static, pr-unit and pr-checks jobs in this order");
  assert.ok(staticJob.includes("      - name: Privileged R4 ownership regression\n"),"privileged test is a static gate");
  assert.ok(staticJob.indexOf("      - name: Typecheck") < staticJob.indexOf("      - name: Privileged R4 ownership regression"));
  assert.ok(staticJob.indexOf("      - name: Privileged R4 ownership regression") < staticJob.indexOf("      - name: Production build"));
  assert.match(unitJob,/shard: \[1, 2, 3, 4, 5\]/);
  assert.match(unitJob,/fail-fast: false/);
  assert.match(unitJob,/run: node scripts\/ci-pr-tests\.mjs --test --shard \$\{\{ matrix\.shard \}\}\/5/);
  assert.match(unitJob,/name: PR unit tests \(shard \$\{\{ matrix\.shard \}\}\/5\)/);
  assert.match(gateJob,/^    name: PR Checks$/m);
  assert.match(gateJob,/^    if: always\(\) && github\.event_name == 'pull_request'$/m);
  assert.match(gateJob,/^    needs: \[pr-static, pr-unit\]$/m);
  assert.match(gateJob,/test "\$STATIC_RESULT" = success/);
  assert.match(gateJob,/test "\$UNIT_RESULT" = success/);
  assert.equal((workflow.match(/^    name: PR Checks$/gm)||[]).length,1,"exactly one stable PR Checks status");

  const regression = readFileSync(path.join(repo, rootTest), "utf8");
  assert.match(regression, /test\("privileged --check rejects foreign-owned directory and each companion"/);
  assert.match(regression, /R4_REQUIRE_ROOT_OWNERSHIP_TEST !== "1"/);
  assert.match(regression, /assert\.equal\(process\.geteuid\?\.\(\), 0, "privileged ownership regression must run as root"\)/);
  assert.match(regression, /for \(const currentPath of \[dir, \.\.\.files\.map/);
});

test("missing dedicated root-test file produces a failing Node test run", () => {
  const missing = path.join(repo, "tests/this-file-does-not-exist-root-ownership.test.mjs");
  assert.equal(existsSync(missing), false);
  const result = spawnSync(process.execPath, ["--test", missing], {
    cwd: repo, encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(result.status, 0, "missing security regression must never count as passed");
});
