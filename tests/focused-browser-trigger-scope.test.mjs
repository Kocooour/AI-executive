import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BROWSER_PROFILES } from "../scripts/ci-playwright-config-scope.mjs";

const directory = ".github/workflows";
const dispatcherName = "playwright-config-impact-browser.yml";
const releaseName = "browser-e2e.yml";

// Always retain the original three independent release/PR sentinels.
// Additional sentinels are allowed only with both direct PR config paths and
// workflow_dispatch; all other shared-config Playwright suites must dispatch.
const requiredSentinels = [
  "global-index-preview-browser.yml",
  "r3-personal-acceptance-browser.yml",
  "release0-c16-focused-browser.yml",
];

// Explicit exception: this suite runs exclusively with its own independent
// configuration and neither imports nor uses root playwright.config.ts.
// If that changes, remove the exception and classify it normally.
const independentConfigs = new Map([
  ["target-sync-indexeddb.yml", "e2e/playwright.indexeddb.config.ts"],
]);

function workflowSources() {
  return new Map(readdirSync(directory).filter((name) => name.endsWith(".yml"))
    .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));
}

function hasPrConfigPath(yaml) {
  let pr = false;
  let paths = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^  pull_request:\s*$/.test(line)) {
      pr = true;
      paths = false;
      continue;
    }
    if (pr && /^  [a-z_]+:/.test(line)) break;
    if (pr && /^    paths:\s*$/.test(line)) {
      paths = true;
      continue;
    }
    if (paths && /^    [a-z_]+:/.test(line)) paths = false;
    if (paths && /^      - ["']?playwright\.config\.ts["']?\s*$/.test(line))
      return true;
  }
  return false;
}

function parseJobs(yaml) {
  const jobs = new Map();
  let inside = false;
  let name = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inside) {
      if (line === "jobs:") inside = true;
      continue;
    }
    const match = line.match(/^  ([a-z][a-z0-9_-]*):\s*$/);
    if (match) {
      name = match[1];
      assert.ok(!jobs.has(name), "duplicate job: " + name);
      jobs.set(name, "");
    } else if (name) {
      jobs.set(name, jobs.get(name) + line + "\n");
    }
  }
  assert.ok(inside, "dispatcher must declare jobs");
  return jobs;
}

function checkCoverage(files, profiles = BROWSER_PROFILES) {
  assert.equal(new Set(profiles).size, profiles.length, "duplicate BROWSER_PROFILES");
  const dispatcher = files.get(dispatcherName);
  assert.ok(dispatcher, "missing config-impact dispatcher");
  assert.ok(hasPrConfigPath(dispatcher), "dispatcher lacks config change PR trigger");
  assert.match(dispatcher, /ci-playwright-config-scope\.mjs --github-output/);

  const jobs = parseJobs(dispatcher);
  const scope = jobs.get("scope");
  assert.ok(scope, "dispatcher must have scope job");
  const outputBlock = scope.match(/^    outputs:[ \t]*\n((?:^      [^\n]*(?:\n|$))*)/m)?.[1];
  assert.ok(outputBlock, "scope job must expose output mappings");
  const outputs = [];
  for (const line of outputBlock.split(/\r?\n/).filter((line) => line.trim())) {
    const match = line.match(/^      ([a-z][a-z0-9_]*): [$][{][{] steps\.detect\.outputs\.([a-z][a-z0-9_]*) [}][}]\s*$/);
    assert.ok(match, "unrecognized scope output: " + line);
    assert.equal(match[1], match[2], "scope output must map to same detector profile");
    outputs.push(match[1]);
  }
  assert.equal(new Set(outputs).size, outputs.length, "duplicate scope output");
  assert.deepEqual([...outputs].sort(), [...profiles].sort(),
    "BROWSER_PROFILES and scope outputs must be 1:1");

  const called = new Set();
  const selectedProfiles = new Set();
  for (const [jobName, body] of jobs) {
    if (jobName === "scope") continue;
    const needs = [...body.matchAll(/^    needs:\s*(.+)\s*$/gm)];
    assert.equal(needs.length, 1, "dispatcher job must depend on scope: " + jobName);
    assert.equal(needs[0][1].trim(), "scope", "dispatcher dependency: " + jobName);
    const uses = [...body.matchAll(/^    uses:\s*(.*)$/gm)];
    assert.equal(uses.length, 1, "dispatcher job must call exactly one workflow: " + jobName);
    const use = uses[0][1].trim().match(/^\.\/\.github\/workflows\/([a-z0-9-]+\.yml)$/);
    assert.ok(use, "dispatcher job must use a local workflow: " + jobName);
    const conditions = [...body.matchAll(/^    if:\s*(.*)$/gm)];
    assert.equal(conditions.length, 1, "dispatcher job must have exactly one if: " + jobName);
    const condition = conditions[0][1].trim().match(/^needs\.scope\.outputs\.([a-z0-9_]+) == 'true'$/);
    assert.ok(condition, "dispatcher job must bind its if to scope: " + jobName);
    const profile = condition[1];
    const filename = use[1];
    assert.ok(!selectedProfiles.has(profile), "duplicate dispatcher profile: " + profile);
    assert.ok(!called.has(filename), "duplicate dispatcher workflow: " + filename);
    selectedProfiles.add(profile);
    called.add(filename);
    assert.ok(files.has(filename), "dispatcher calls missing workflow: " + filename);
    const calledYaml = files.get(filename);
    assert.match(calledYaml, /^  workflow_call:\s*$/m,
      "dispatched workflow lacks workflow_call: " + filename);
    // Direct PR and config-impact reusable calls may execute concurrently:
    // a shared concurrency group would cancel one and silently lose coverage.
    if (/^concurrency:\s*$/m.test(calledYaml)) {
      assert.match(calledYaml, /^  group: .*[$][{][{] github\.workflow [}][}]/m,
        "reusable workflow must isolate direct and dispatched runs: " + filename);
    }
  }
  assert.deepEqual([...selectedProfiles].sort(), [...profiles].sort(),
    "dispatcher jobs and BROWSER_PROFILES must be 1:1");

  const requiredCalls = [];
  for (const [filename, yaml] of files) {
    if (filename === releaseName || filename === dispatcherName) continue;
    if (!/\bplaywright\s+test\b/.test(yaml)) continue;
    const independentConfig = independentConfigs.get(filename);
    if (independentConfig) {
      const configPattern = new RegExp("^playwright\\s+test\\s+--config\\s+" +
        independentConfig.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&") + "(?:\\s|$)");
      const commands = [...yaml.matchAll(/\bplaywright\s+test\b[^\n]*/g)];
      assert.ok(commands.length, "allowlisted workflow must run Playwright: " + filename);
      for (const command of commands) {
        assert.match(command[0], configPattern,
          "every Playwright invocation must use the independent config: " + filename);
      }
      assert.equal(hasPrConfigPath(yaml), false,
        "independent workflow must not claim shared-config trigger: " + filename);
      continue;
    }
    if (hasPrConfigPath(yaml)) {
      assert.match(yaml, /^  workflow_dispatch:\s*$/m,
        "direct config sentinel needs workflow_dispatch: " + filename);
    } else {
      requiredCalls.push(filename);
      assert.match(yaml, /^  workflow_call:\s*$/m,
        "non-sentinel browser workflow needs workflow_call: " + filename);
    }
  }
  assert.deepEqual([...called].sort(), requiredCalls.sort(),
    "every focused Playwright suite must be dispatched or a valid sentinel");

  for (const name of requiredSentinels) {
    assert.ok(files.has(name), "missing original sentinel: " + name);
    assert.ok(hasPrConfigPath(files.get(name)), "original sentinel lost PR config path: " + name);
    assert.match(files.get(name), /^  workflow_dispatch:\s*$/m,
      "original sentinel lost workflow_dispatch: " + name);
  }
  // The isolated config's independence is the justification for the sole
  // allowlist entry. If it imports the root config, it must join the dispatcher.
  const isolatedConfig = readFileSync("e2e/playwright.indexeddb.config.ts", "utf8");
  assert.doesNotMatch(isolatedConfig, /playwright\.config(?:\.ts)?/,
    "independent configuration must not reference the root Playwright config");
  assert.deepEqual([...independentConfigs.keys()].sort(), ["target-sync-indexeddb.yml"]);

  const release = files.get(releaseName);
  assert.ok(release, "release-only full E2E workflow is required");
  assert.match(release, /target_sha:/);
  assert.match(release, /Run all browser E2E tests/);
}

test("every focused browser workflow is a complete sentinel or dispatcher target", () => {
  checkCoverage(workflowSources());
});

test("a new C-3b workflow cannot silently miss shared Playwright changes", () => {
  const files = workflowSources();
  files.set("r3-inbox-c3b-acceptance-browser.yml",
    "on:\n  pull_request:\n    paths:\n      - 'e2e/c3b.spec.ts'\njobs:\n" +
    "  chromium:\n    steps:\n      - run: pnpm exec playwright test e2e/c3b.spec.ts\n");
  assert.throws(() => checkCoverage(files), /workflow_call|every focused Playwright suite/);
});

test("a missing dispatcher job, output, or conditional fails closed", () => {
  const files = workflowSources();
  const dispatcher = files.get(dispatcherName);
  for (const mutated of [
    dispatcher.replace(/^  project-tasks:\n(?:^(?!  [a-z][a-z0-9-]*:).*\n?)*/m, ""),
    dispatcher.replace("      project_tasks: ", "      missing_project_tasks: "),
    dispatcher.replace("if: needs.scope.outputs.project_tasks == 'true'",
      "if: needs.scope.outputs.inbox == 'true'"),
    dispatcher.replace("if: needs.scope.outputs.project_tasks == 'true'",
      "if: needs.scope.outputs.project_tasks == 'true'\n    if: always()"),
    dispatcher.replace("uses: ./.github/workflows/project-tasks-preview-browser.yml",
      "uses: ./.github/workflows/r3-inbox-acceptance-browser.yml"),
  ]) {
    assert.notEqual(mutated, dispatcher, "mutation must change dispatcher");
    files.set(dispatcherName, mutated);
    assert.throws(() => checkCoverage(files));
  }
});

test("missing workflow_call, broken exception, or sentinel manual trigger is rejected", () => {
  const files = workflowSources();
  const original = workflowSources();
  files.set("project-tasks-preview-browser.yml",
    files.get("project-tasks-preview-browser.yml").replace("  workflow_call:\n", ""));
  assert.throws(() => checkCoverage(files), /workflow_call/);
  files.set("project-tasks-preview-browser.yml", original.get("project-tasks-preview-browser.yml"));

  files.set("target-sync-indexeddb.yml",
    files.get("target-sync-indexeddb.yml").replace(
      "--config e2e/playwright.indexeddb.config.ts", "--project=desktop"));
  assert.throws(() => checkCoverage(files), /independent config/);
  files.set("target-sync-indexeddb.yml", original.get("target-sync-indexeddb.yml"));
  files.set("target-sync-indexeddb.yml",
    files.get("target-sync-indexeddb.yml") +
    "\n      - run: pnpm exec playwright test e2e/unscoped.spec.ts\n");
  assert.throws(() => checkCoverage(files), /every Playwright invocation/);
  files.set("target-sync-indexeddb.yml", original.get("target-sync-indexeddb.yml"));

  files.set("r3-personal-acceptance-browser.yml",
    files.get("r3-personal-acceptance-browser.yml").replace("  workflow_dispatch:", "  manual_disabled:"));
  assert.throws(() => checkCoverage(files), /workflow_dispatch/);
});

test("orphaned profiles are not accepted as valid coverage", () => {
  assert.throws(() => checkCoverage(workflowSources(),
    [...BROWSER_PROFILES, "orphan_profile"]), /1:1/);
});
