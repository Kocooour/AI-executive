import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Exercise the shell statement from the real workflow rather than a copied
// implementation. Backticks inside double-quoted echo used to silently execute
// the commit SHA as a command and leave the audited job summary empty.
test("Browser E2E workflow records the exact checked-out SHA as literal Markdown", () => {
  const workflow = readFileSync(".github/workflows/browser-e2e.yml", "utf8");
  const verify = workflow.split("      - name: Verify exact E2E target SHA\n")[1]
    ?.split("\n      - name: ")[0];
  assert.ok(verify, "the exact-target verification step must exist");

  const shaLines = verify.split("\n").filter((line) =>
    line.includes(">> \"$GITHUB_STEP_SUMMARY\"") && line.includes("$TARGET_SHA"));
  assert.equal(shaLines.length, 1, "exactly one summary statement must record TARGET_SHA");

  const root = mkdtempSync(path.join(tmpdir(), "lumi-e2e-summary-"));
  const summary = path.join(root, "summary.md");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  try {
    const run = spawnSync("bash", ["-e", "-c", shaLines[0].trim()], {
      encoding: "utf8",
      env: { ...process.env, TARGET_SHA: sha, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(run.status, 0, run.stderr || "summary writer failed");
    assert.equal(run.stderr, "", "SHA must never be executed through shell substitution");
    assert.equal(readFileSync(summary, "utf8"), "`" + sha + "`\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
