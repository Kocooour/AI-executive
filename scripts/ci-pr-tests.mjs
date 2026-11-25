#!/usr/bin/env node
// Conservative, dependency-free PR test selection. Main and releases run the full suite.
// Operates on the PR's base/head commits, not GitHub's temporary merge checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

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
  return paths.some((filename) => !filename.endsWith(".md"));
}

// Run the built Next router smoke on PRs that can change owner-cookie
// issuance, revocation, auth endpoints or the smoke/provisioning harness.
// This is additive to the existing conservative unit-test selector.
export function needsNextRouterSmoke(paths) {
  return paths.some((filename) =>
    filename === "lib/auth.ts" ||
    /^lib\/owner-session-[^/]+\.ts$/.test(filename) ||
    filename.startsWith("app/api/auth/") ||
    filename === "scripts/target-staging-next-smoke.mjs" ||
    filename === "scripts/owner-session-revocation-init.mjs");
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
  "tests/target-r2d-security-matrix.test.mjs",
  "tests/target-personal-boundary-matrix.test.mjs",
  "tests/target-r2d-security-matrix-mutation-guards.test.mjs",
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
const TOOLCHAIN = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tests\/ts-loader\.mjs|tests\/(?:fixtures|support)\/|scripts\/ci-pr-tests\.mjs|\.github\/workflows\/pr-checks\.yml)/;
// File-reading tests cannot be discovered from imports. Keep these explicit.
const FILE_INPUT_TESTS = [
  { path: /^docs\/design-system\//, tests: ["tests/design-tokens.test.mjs"] },
  { path: /^\.github\/workflows\/browser-e2e\.yml$/, tests: ["tests/browser-e2e-workflow.test.mjs"] },
  { path: /^deployment\/deploy-safe\.sh$/, tests: ["tests/deploy-safe.test.mjs"] },
];
// Other workflow definitions cannot change unit-test outcomes; only tests that
// read workflow files can. pr-checks.yml itself stays in TOOLCHAIN (full suite).
const OTHER_WORKFLOWS = /^\.github\/workflows\/(?!browser-e2e\.yml$)/;
const WORKFLOW_READER = /\.github\/workflows/;
const SENSITIVE = /^(?:lib\/(?:auth\.ts|owner-session-[^/]+\.ts|passkeys\.ts|http-security\.ts|security-|server-store\.ts|server-sync\.ts|db\.ts|data-dir\.ts|schema-migrations\.ts|backup-|mail-gmail\.ts|area-|target-|context(?:-|\.ts)|work-read-scope\.ts)|app\/api\/)/;

// Build a reverse dependency graph from relative imports. Scanning the tracked
// source tree rather than only tests covers API route imports and transitive
// library dependencies (including extensionless TypeScript imports).
const extensions = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".cjs", ".json"];

function resolveImport(importer, specifier, known) {
  if (!(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/"))) {
    return null;
  }
  const candidate = specifier.startsWith("@/")
    ? specifier.slice(2)
    : path.posix.join(path.posix.dirname(importer), specifier);
  const base = path.posix.normalize(candidate);
  if (base.startsWith("../") || base.startsWith("/")) return null;
  for (const value of [base, ...extensions.map((ext) => base + ext),
    ...extensions.map((ext) => base + "/index" + ext)]) {
    if (known.has(value)) return value;
  }
  return null;
}

function dependencyGraph(sources, paths, available) {
  const known = new Set([...Object.keys(sources), ...paths, ...available]);
  const reverse = new Map();
  for (const [filename, body] of Object.entries(sources)) {
    // Handles import/export ... from, import "side-effect", import("dynamic"), require().
    // Only literal local specifiers count; tests with non-literal loading need a fallback.
    const pattern = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"'\r\n]+)["']/g;
    for (const match of body.matchAll(pattern)) {
      const imported = resolveImport(filename, match[1], known);
      if (!imported) continue;
      if (!reverse.has(imported)) reverse.set(imported, new Set());
      reverse.get(imported).add(filename);
    }
  }
  return reverse;
}

function testsDependingOn(changed, reverse, available) {
  const tests = new Set(available);
  const found = new Set();
  const visited = new Set([changed]);
  const pending = [changed];
  for (let index = 0; index < pending.length; index += 1) {
    for (const dependent of reverse.get(pending[index]) ?? []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      if (tests.has(dependent)) found.add(dependent);
      pending.push(dependent);
    }
  }
  return found;
}

export function chooseTests(paths, available, sources = {}) {
  if (paths.some((filename) => TOOLCHAIN.test(filename))) {
    return { full: true, selected: [...available].sort() };
  }
  const selected = new Set(CORE);
  if (paths.some((filename) => OTHER_WORKFLOWS.test(filename))) {
    // Every test that inspects workflow definitions (trigger scopes, release
    // gates, CI policy). An unknown reader pattern fails safe to the full suite.
    const readers = available.filter((test) => WORKFLOW_READER.test(sources[test] ?? ""));
    if (!readers.length) return { full: true, selected: [...available].sort() };
    for (const test of readers) selected.add(test);
  }
  for (const filename of paths) {
    if (available.includes(filename)) selected.add(filename);
  }
  for (const filename of paths) {
    for (const rule of FILE_INPUT_TESTS) {
      if (rule.path.test(filename)) {
        for (const test of rule.tests) selected.add(test);
      }
    }
  }
  if (paths.some((filename) => SENSITIVE.test(filename))) {
    for (const filename of SECURITY) selected.add(filename);
  }
  if (paths.some((filename) => (filename.startsWith("app/") && !filename.startsWith("app/api/")) ||
    filename.startsWith("e2e/") || filename.startsWith("public/") ||
    filename.startsWith("lib/work-scope-"))) {
    for (const filename of UI) selected.add(filename);
  }

  const reverse = dependencyGraph(sources, paths, available);
  const referenced = paths.filter((filename) =>
    /^(?:lib|scripts|app)\//.test(filename));
  const fallbackSearch = referenced.map((filename) =>
    filename.replace(/\.(?:tsx?|mjs|cjs|jsx?)$/, ""));
  for (const filename of referenced) {
    const consumers = testsDependingOn(filename, reverse, available);
    // Dynamic path construction or indirect HTTP test routing may not be
    // statically visible. For an API change with no reachable tests, fail safe
    // by running the complete unit suite instead of silently skipping coverage.
    if (filename.startsWith("app/api/") && consumers.size === 0 &&
      !available.some((test) => (sources[test] ?? "").includes(filename))) {
      return { full: true, selected: [...available].sort() };
    }
    for (const test of consumers) selected.add(test);
  }
  // Some tests invoke modules via process spawning or read paths as strings,
  // rather than importing them. Preserve these direct references too.
  for (const test of available) {
    const source = sources[test] ?? "";
    if (fallbackSearch.some((needle) => source.includes(needle))) selected.add(test);
  }
  return {
    full: false,
    selected: [...selected].filter((filename) => available.includes(filename)).sort(),
  };
}

function main() {
  const paths = changedPaths();
  const code = needsCodeChecks(paths);
  if (process.argv.includes("--scope")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT missing");
    const routerSmoke = needsNextRouterSmoke(paths);
    appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\nrouter_smoke=${routerSmoke}\n`);
    console.log(`Changed files: ${paths.length}; code checks: ${code}; Next router smoke: ${routerSmoke}`);
    return;
  }
  if (!code) {
    console.log("Documentation-only PR: no executable tests needed.");
    return;
  }
  const available = readdirSync("tests").filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `tests/${name}`);
  const files = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" })
    .split("\0").filter((filename) =>
      /^(?:app|lib|scripts|tests)\//.test(filename) &&
      /\.(?:tsx?|mjs|cjs|jsx?)$/.test(filename) && existsSync(filename));
  const sources = Object.fromEntries(files.map((filename) => [filename, readFileSync(filename, "utf8")]));
  const { full, selected: all } = chooseTests(paths, available, sources);
  if (!all.length || !all.every((path) => existsSync(path))) {
    throw new Error("Selected PR test list is empty or invalid");
  }
  const shard = parseShard(process.argv);
  const selected = shard
    ? shardTests(all, shard.index, shard.count, (file) => statSync(file).size)
    : all;
  console.log(`PR unit tests: ${full ? "full suite" : "focused suite"} (${all.length}/${available.length} files)` +
    (shard ? `; shard ${shard.index}/${shard.count}: ${selected.length} files` : ""));
  console.log(selected.join("\n"));
  if (!selected.length) {
    console.log("This shard has no selected files.");
    return;
  }
  // Release and rollback safety must fail early: a broad PR suite can run
  // for many minutes, obscuring which deployment invariant broke.
  // The full selected suite still runs unchanged after this first gate.
  if (selected.includes("tests/deploy-safe.test.mjs")) {
    const smoke = spawnSync(process.execPath, [
      "--experimental-loader", "./tests/ts-loader.mjs",
      "--test", "tests/deploy-safe.test.mjs",
    ], { stdio: "inherit", env: process.env });
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0) {
      process.exitCode = smoke.status ?? 1;
      return;
    }
  }
  // The early deployment gate already ran deploy-safe in full: never twice.
  const rest = selected.filter((file) => file !== "tests/deploy-safe.test.mjs");
  if (!rest.length) return;
  const outcome = spawnSync(process.execPath, [
    "--experimental-loader", "./tests/ts-loader.mjs", "--test", ...rest,
  ], { stdio: "inherit", env: process.env });
  if (outcome.error) throw outcome.error;
  process.exitCode = outcome.status ?? 1;
}

/** Deterministic longest-processing-time split of the selected test files into
 * `count` shards, weighted by file size with explicit hints for slow suites.
 * Every file lands in exactly one shard. */
export const SLOW_TEST_WEIGHTS = { "tests/deploy-safe.test.mjs": 10_000_000 };
export function shardTests(selected, index, count, sizeOf) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) {
    throw new Error("Invalid shard; expected --shard <index>/<count>");
  }
  const weight = (file) => SLOW_TEST_WEIGHTS[file] ?? sizeOf(file);
  const ordered = [...selected].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const loads = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  for (const file of ordered) {
    let target = loads[0];
    for (const load of loads) if (load.total < target.total) target = load;
    target.total += weight(file);
    target.files.push(file);
  }
  return loads[index - 1].files.sort();
}
export function parseShard(argv) {
  const at = argv.indexOf("--shard");
  if (at < 0) return null;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(argv[at + 1] ?? "");
  if (!match) throw new Error("Invalid shard; expected --shard <index>/<count>");
  return { index: Number(match[1]), count: Number(match[2]) };
}

// Keep the pure selection functions importable by unit tests.
if (process.argv[1]?.endsWith("/ci-pr-tests.mjs")) main();
