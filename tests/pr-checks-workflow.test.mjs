import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The PR workflow is executable security policy. When its YAML changes,
// select this focused, file-reading regression rather than silently relying
// on the large unrelated main-regression suite.
test("PR Checks runs the privileged R4 ownership check as a required gate", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pr-checks.yml", import.meta.url), "utf8");
  assert.equal(workflow.split("\n  main-regression:").length, 2, "exactly one main-regression job");
  const prJob = workflow.split("\n  main-regression:")[0];
  assert.match(prJob, /name: PR Checks/);
  assert.match(prJob, /runs-on: ubuntu-24\.04/);
  assert.match(prJob, /permissions:\n  contents: read/);
  assert.match(prJob, /- name: Privileged R4 ownership regression/);
  const block = prJob.split("      - name: Privileged R4 ownership regression\n")[1]
    ?.split("\n      - name: ")[0];
  assert.ok(block, "privileged ownership step must exist in PR Checks");
  assert.match(block, /if: steps\.scope\.outputs\.code == 'true'/);
  assert.match(block, /sudo -n env TMPDIR=\/tmp R4_REQUIRE_ROOT_OWNERSHIP_TEST=1/);
  assert.match(block, /--test-name-pattern='\^--check rejects foreign-owned directory or each companion without modifying it\$'/);
  assert.match(block, /tests\/target-store-provision\.test\.mjs/);
  assert.ok(prJob.indexOf("      - name: Typecheck") < prJob.indexOf("      - name: Privileged R4 ownership regression"));
  assert.ok(prJob.indexOf("      - name: Privileged R4 ownership regression") < prJob.indexOf("      - name: Focused PR unit tests"));
  assert.ok(prJob.indexOf("      - name: Focused PR unit tests") < prJob.indexOf("      - name: Production build"));
  const regression = readFileSync(new URL("./target-store-provision.test.mjs", import.meta.url), "utf8");
  assert.match(regression, /R4_REQUIRE_ROOT_OWNERSHIP_TEST !== "1"/);
  assert.match(regression, /assert\.equal\(process\.geteuid\?\.\(\), 0, "privileged ownership regression must run as root"\)/);
});
