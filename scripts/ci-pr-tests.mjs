#!/usr/bin/env node
// Conservative, dependency-free PR test selection. Main and releases run the full suite.
// Operates on the PR's base/head commits, not GitHub's temporary merge checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";

const BASE = process.env.BASE_SHA;
const HEAD = process.env.HEAD_SHA;
const SHA = /^[a-f0-9]{40}$/i;

export function changedPaths(base = BASE, head = HEAD) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) {
    throw new Error("BASE_SHA and HEAD_SHA must be complete commit hashes");
  }
  return execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], {
    encoding: "utf8",
  }).split("\0").filter(Boolean);
}

export function needsCodeChecks(paths) {
  // Documentation-only PRs retain a required green status without spending a build.
  return paths.some((path) => !path.startsWith("docs/") && !path.endsWith(".md"));
}

const CORE = [
  "tests/server-errors.test.mjs",
  "tests/client-auth-status.test.mjs",
  "tests/view-url.test.mjs",
];
const SECURITY = [
  "tests/area-write-invariants.test.mjs",
  "tests/context-evidence-leaks.test.mjs",
  "tests/target-area-policy.test.mjs",
  "tests/target-note-access.test.mjs",
  "tests/target-staging-membership-command.test.mjs",
  "tests/target-staging-session-authority.test.mjs",
  "tests/target-staging-shared-reads.test.mjs",
  "tests/target-task-authenticated-read.test.mjs",
  "tests/work-read-scope.test.mjs",
];
const UI = [
  "tests/mobile-navigation-v1.test.mjs",
  "tests/task-row-value.test.mjs",
  "tests/work-scope-navigation.test.mjs",
];
const TOOLCHAIN = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tests\/ts-loader\.mjs)$/;
const SENSITIVE = /^(?:lib\/(?:auth\.ts|passkeys\.ts|http-security\.ts|security-|server-store\.ts|server-sync\.ts|db\.ts|data-dir\.ts|schema-migrations\.ts|backup-|mail-gmail\.ts|area-|target-|context(?:-|\.ts)|work-read-scope\.ts)|app\/api\/)/;

export function chooseTests(paths, available, sources = {}) {
  if (paths.some((path) => TOOLCHAIN.test(path))) {
    return { full: true, selected: [...available].sort() };
  }
  const selected = new Set(CORE);
  const testPaths = paths.filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"));
  for (const path of testPaths) selected.add(path);
  if (paths.some((path) => SENSITIVE.test(path))) {
    for (const path of SECURITY) selected.add(path);
  }
  if (paths.some((path) => (path.startsWith("app/") && !path.startsWith("app/api/")) || path.startsWith("e2e/") ||
    path.startsWith("public/") || path.startsWith("lib/work-scope-"))) {
    for (const path of UI) selected.add(path);
  }
  // Match changed implementation modules against test imports / references.
  // This also catches tests invoking scripts indirectly, even when filenames differ.
  const needles = paths.filter((path) => /^(lib|scripts)\//.test(path))
    .map((path) => path.replace(/\.(?:tsx?|mjs|js)$/, ""));
  for (const test of available) {
    const source = sources[test] ?? "";
    if (needles.some((needle) => source.includes(needle))) selected.add(test);
  }
  return { full: false, selected: [...selected].filter((path) => available.includes(path)).sort() };
}

function main() {
  const paths = changedPaths();
  const code = needsCodeChecks(paths);
  if (process.argv.includes("--scope")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT missing");
    appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
    console.log(`Changed files: ${paths.length}; code checks: ${code}`);
    return;
  }
  if (!code) {
    console.log("Documentation-only PR: no executable tests needed.");
    return;
  }
  const available = readdirSync("tests").filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`);
  const sources = Object.fromEntries(available.map((path) => [path, readFileSync(path, "utf8")]));
  const { full, selected } = chooseTests(paths, available, sources);
  if (!selected.length || !selected.every((path) => existsSync(path))) {
    throw new Error("Selected PR test list is empty or invalid");
  }
  console.log(`PR unit tests: ${full ? "full suite" : "focused suite"} (${selected.length}/${available.length} files)`);
  console.log(selected.join("\n"));
  const outcome = spawnSync(process.execPath, [
    "--experimental-loader", "./tests/ts-loader.mjs", "--test", ...selected,
  ], { stdio: "inherit", env: process.env });
  if (outcome.error) throw outcome.error;
  process.exitCode = outcome.status ?? 1;
}

// Keep the pure selection functions importable by unit tests.
if (process.argv[1]?.endsWith("/ci-pr-tests.mjs")) main();
