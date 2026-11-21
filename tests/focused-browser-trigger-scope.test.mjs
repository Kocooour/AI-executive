import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Shared Playwright harness edits should not fan out to every independently
// configured browser acceptance job. Focused jobs still run for their own
// relevant source/spec changes, and Browser E2E remains the exact-SHA release gate.
const directory = ".github/workflows";
const selected = [
  "global-index-preview-browser.yml", // privacy / default-off synthetic preview
  "r3-personal-acceptance-browser.yml", // real isolated SQLite integration
  "release0-c16-focused-browser.yml", // cross-spec session recovery
].sort();
const focusedWorkflows = readdirSync(directory).filter((name) =>
  name.endsWith(".yml") && name !== "pr-checks.yml" && name !== "browser-e2e.yml");

test("shared Playwright config triggers only representative focused browser sentinels", () => {
  const matching = focusedWorkflows.filter((name) => {
    const content = readFileSync(path.join(directory, name), "utf8");
    return /^\s*-\s*["']?playwright\.config\.ts["']?\s*$/m.test(content);
  }).sort();
  assert.deepEqual(matching, selected);
});

test("focused PR paths and explicit manual browser dispatches stay intact", () => {
  for (const name of selected) {
    const content = readFileSync(path.join(directory, name), "utf8");
    assert.match(content, /on:\s*\n\s*pull_request:\s*\n\s*paths:/);
    assert.match(content, /\n\s*workflow_dispatch:/);
  }
  const release = readFileSync(path.join(directory, "browser-e2e.yml"), "utf8");
  assert.match(release, /target_sha:/);
  assert.match(release, /Run all browser E2E tests/);
});
