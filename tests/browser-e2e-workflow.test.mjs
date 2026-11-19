import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


// Execute the *actual* release workflow installer body against simulated exact-SHA
// checkouts, rather than testing a separately copied shell implementation.
// 447f216... predates the helper added in PR #476 and remains a valid main ancestor.
function releaseChromiumInstallScript() {
  const workflow = readFileSync(".github/workflows/browser-e2e.yml", "utf8");
  assert.match(workflow, /ref: \$\{\{ inputs\.target_sha \}\}/, "release must still checkout the requested exact SHA");
  const step = workflow.split("      - name: Install and verify Playwright Chromium\n")[1]
    ?.split("\n      - name: ")[0];
  assert.ok(step, "release Chromium install step must exist");
  assert.match(step, /\n        shell: bash\n/);
  const body = step.split("\n        run: |\n")[1];
  assert.ok(body, "release installer must use a shell block");
  const lines = body.trimEnd().split("\n");
  for (const line of lines) assert.ok(line.startsWith("          "), "unexpected installer indentation");
  return lines.map((line) => line.slice(10)).join("\n") + "\n";
}

function runReleaseInstall({ helperPresent, helperExit = 0, pnpmExit = 0 }) {
  const root = mkdtempSync(path.join(tmpdir(), "lumi-exact-sha-chromium-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "pnpm"), [
    "#!/usr/bin/env bash",
    'printf "pnpm:%s\n" "$*" >> "$CHROMIUM_CALLS"',
    'exit "$CHROMIUM_PNPM_EXIT"',
    "",
  ].join("\n"), { mode: 0o755 });
  if (helperPresent) {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "ci-install-chromium.sh"), [
      "#!/usr/bin/env bash",
      'printf "helper\n" >> "$CHROMIUM_CALLS"',
      'exit "$CHROMIUM_HELPER_EXIT"',
      "",
    ].join("\n"));
  }
  try {
    const run = spawnSync("bash", ["-e", "-o", "pipefail", "-c", releaseChromiumInstallScript()], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + path.delimiter + (process.env.PATH || ""),
        CHROMIUM_CALLS: log,
        CHROMIUM_HELPER_EXIT: String(helperExit),
        CHROMIUM_PNPM_EXIT: String(pnpmExit),
      },
    });
    return {
      status: run.status,
      stderr: run.stderr,
      calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pre-#476 exact-SHA checkout without helper installs the original Chromium", () => {
  const result = runReleaseInstall({ helperPresent: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["pnpm:exec playwright install --with-deps chromium"]);
});

test("modern exact-SHA checkout uses shared Chromium bootstrap, not apt fallback", () => {
  const result = runReleaseInstall({ helperPresent: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["helper"]);
});

test("broken helper fails closed instead of hiding an installation regression", () => {
  const result = runReleaseInstall({ helperPresent: true, helperExit: 17 });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ["helper"]);
});

test("historical Chromium dependency-install failure still blocks release E2E", () => {
  const result = runReleaseInstall({ helperPresent: false, pnpmExit: 18 });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ["pnpm:exec playwright install --with-deps chromium"]);
});
