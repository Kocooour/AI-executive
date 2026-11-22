import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The shared Playwright config is checked by three complementary sentinels,
// plus a fail-closed impact-aware reusable-workflow dispatcher.
const directory = ".github/workflows";
const sentinels = [
  "global-index-preview-browser.yml",
  "r3-personal-acceptance-browser.yml",
  "release0-c16-focused-browser.yml",
].sort();

test("config changes retain three sentinels and an impact-aware dispatcher", () => {
  const focused = readdirSync(directory).filter((name) =>
    name.endsWith(".yml") && ![
      "pr-checks.yml", "browser-e2e.yml", "playwright-config-impact-browser.yml"
    ].includes(name));
  const matching = focused.filter((name) =>
    /^\s*-\s*["']?playwright\.config\.ts["']?\s*$/m.test(
      readFileSync(path.join(directory, name), "utf8"))).sort();
  assert.deepEqual(matching, sentinels);
  const dispatcher = readFileSync(path.join(directory,
    "playwright-config-impact-browser.yml"), "utf8");
  assert.match(dispatcher, /on:\s*\n\s*pull_request:\s*\n\s*paths:\s*\n\s*-\s*"playwright\.config\.ts"/);
});

test("three sentinels keep independent PR paths and manual dispatches", () => {
  for (const name of sentinels) {
    const content = readFileSync(path.join(directory, name), "utf8");
    assert.match(content, /on:\s*\n\s*pull_request:\s*\n\s*paths:/);
    assert.match(content, /\n\s*workflow_dispatch:/);
  }
  const release = readFileSync(path.join(directory, "browser-e2e.yml"), "utf8");
  assert.match(release, /target_sha:/);
  assert.match(release, /Run all browser E2E tests/);
});
