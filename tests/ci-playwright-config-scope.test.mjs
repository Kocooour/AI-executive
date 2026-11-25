import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { BROWSER_PROFILES, selectBrowserProfiles } from "../scripts/ci-playwright-config-scope.mjs";

function patch(...changes) {
  return ["diff --git a/playwright.config.ts b/playwright.config.ts",
    "--- a/playwright.config.ts", "+++ b/playwright.config.ts",
    "@@ -1,1 +1,1 @@", ...changes].join("\n");
}

test("P2: a config-only note editor branch edit still runs the legacy/combined/4b matrix", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-        ...(noteEditProfile==="4b" ? {} : {AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED: "true"}),',
    '+        ...(noteEditProfile==="combined" ? {} : {AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED: "true"}),'
  )), BROWSER_PROFILES);
});

test("P2: a cross-feature insertion cannot bypass private-task browser acceptance", () => {
  // This insertion is in the privateTaskCreateTest object but only mentions
  // inboxAcceptanceTest. Matching only changed-line names would select Inbox
  // and falsely skip the private-task Quick Capture regression.
  assert.deepEqual(selectBrowserProfiles(patch(
    '+        ...(!inboxAcceptanceTest ? { AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED: "false" } : {}),'
  )), BROWSER_PROFILES);
});

test("changed private task opt-in default may activate other browser suites; fail closed", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-const privateTaskCreateTest = process.env.LUMI_PRIVATE_TASK_CREATE_E2E === "true";',
    '+const privateTaskCreateTest = process.env.LUMI_PRIVATE_TASK_CREATE_E2E !== "false";'
  )), BROWSER_PROFILES);
});

test("unrecognized, mixed, and newly added config logic always run all profiles", () => {
  for (const diff of [
    patch("-  workers: 1,", "+  workers: 4,"),
    patch("-const noteEditProfile = old;", "+const noteEditProfile = next;"),
    patch("-const inboxAcceptanceTest = old;", "+const inboxAcceptanceTest = next;"),
    patch("-const noteEditProfile = old;", "+const noteEditProfile = next;",
      "+  use: { storageState: 'shared.json' },"),
    patch("+  process.env.UNRELATED = 'true';"),
    patch("-  // previous comment", "+  // edited comment"),
    patch("-const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? 'legacy';",
      "+const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? 'combined';"),
    "",
  ]) {
    assert.deepEqual(selectBrowserProfiles(diff), BROWSER_PROFILES);
  }
});

test("only an unchanged feature opt-in with a simple default-string edit is scoped", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "legacy";',
    '+const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "combined";'
  )), ["note_edit"]);
  assert.deepEqual(selectBrowserProfiles(patch(
    '-const mainTitleSearchMode = process.env.LUMI_TARGET_MAIN_SEARCH_MODE ?? "on";',
    '+const mainTitleSearchMode = process.env.LUMI_TARGET_MAIN_SEARCH_MODE ?? "off";'
  )), ["main_title"]);
});

test("multiple independent safe edits fail closed instead of inferring semantics", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "legacy";',
    '+const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "combined";',
    '-const mainTitleSearchMode = process.env.LUMI_TARGET_MAIN_SEARCH_MODE ?? "on";',
    '+const mainTitleSearchMode = process.env.LUMI_TARGET_MAIN_SEARCH_MODE ?? "off";'
  )), BROWSER_PROFILES);
  const twoHunks = [
    "diff --git a/playwright.config.ts b/playwright.config.ts",
    "--- a/playwright.config.ts", "+++ b/playwright.config.ts",
    '@@ -1,1 +1,1 @@',
    '-const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "legacy";',
    '@@ -20,1 +20,1 @@',
    '+const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "combined";'
  ].join("\n");
  assert.deepEqual(selectBrowserProfiles(twoHunks), BROWSER_PROFILES);
});

test("diff header filter counts double-prefixed source lines inside a hunk", () => {
  const defaultOld = '-const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "legacy";';
  const defaultNew = '+const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "combined";';
  for (const extra of ["---counter;", "+++counter;", "----state;", "++++state;"]) {
    // +++/--- file headers occur before @@, but inside a hunk these are edits.
    assert.deepEqual(selectBrowserProfiles(patch(defaultOld, defaultNew, extra)),
      BROWSER_PROFILES, extra);
    assert.deepEqual(selectBrowserProfiles(patch(extra, defaultOld, defaultNew)),
      BROWSER_PROFILES, extra);
  }
});

test("config impact workflow retains all affected existing reusable workflows", () => {
  const workflow = readFileSync(".github/workflows/playwright-config-impact-browser.yml", "utf8");
  assert.match(workflow, /playwright\.config\.ts/);
  assert.match(workflow, /ci-playwright-config-scope\.mjs --github-output/);
  for (const profile of BROWSER_PROFILES) {
    assert.match(workflow, new RegExp("steps\\.detect\\.outputs\\." + profile));
    assert.match(workflow, new RegExp("needs\\.scope\\.outputs\\." + profile));
  }
  const matches = [...workflow.matchAll(/uses: \.\/\.github\/workflows\/([a-z0-9-]+)\.yml/g)];
  assert.equal(matches.length, BROWSER_PROFILES.length);
  for (const [, name] of matches) {
    const called = readFileSync(".github/workflows/" + name + ".yml", "utf8");
    assert.match(called, /\n  workflow_call:/);
    // Direct PR and config-impact reusable invocations must not cancel each other.
    if (/^concurrency:/m.test(called)) {
      assert.match(called, /^  group: .*\$\{\{ github\.workflow \}\}/m);
    }
  }
});

test("#493: every dispatched profile maps to a workflow with a fully understood path filter", async () => {
  const scope = await import("../scripts/ci-playwright-config-scope.mjs");
  const dispatcher = readFileSync(".github/workflows/playwright-config-impact-browser.yml", "utf8");
  const map = scope.dispatchedWorkflows(dispatcher);
  assert.deepEqual(Object.keys(map).sort(), [...scope.BROWSER_PROFILES].sort());
  for (const [profile, file] of Object.entries(map)) {
    const filters = scope.workflowPathFilters(readFileSync(".github/workflows/" + file, "utf8"));
    assert.ok(filters && filters.length, profile + ": path filter parsed");
    assert.ok(filters.every((glob) => scope.globToRegExp(glob)), profile + ": every glob modelled");
  }
});

test("#493: GitHub glob semantics: * stays in one segment, ** crosses, [] is a class", async () => {
  const { globToRegExp } = await import("../scripts/ci-playwright-config-scope.mjs");
  assert.ok(globToRegExp("lib/target-*.ts").test("lib/target-inbox.ts"));
  assert.equal(globToRegExp("lib/target-*.ts").test("lib/target/inbox.ts"), false);
  assert.ok(globToRegExp("app/api/target-staging/**").test("app/api/target-staging/a/b/route.ts"));
  assert.ok(globToRegExp("e2e/note-preview-ui09d*.spec.ts").test("e2e/note-preview-ui09d-x.spec.ts"));
  // Literal "[projectId]" is a character class in GitHub filters: it does NOT
  // match the literal directory, so we must not claim a direct run for it.
  assert.equal(globToRegExp("app/api/x/[projectId]/route.ts").test("app/api/x/[projectId]/route.ts"), false);
  assert.ok(globToRegExp("app/api/x/[projectId]/route.ts").test("app/api/x/p/route.ts"));
  for (const unsupported of ["!lib/a.ts", "lib/{a,b}.ts", "lib/a+.ts", "a?b", "lib/[a_b].ts", "lib/[.].ts"])
    assert.equal(globToRegExp(unsupported), null, unsupported);
});

test("#493: a suite already triggered by its own paths is not dispatched twice; unknown filters stay dispatched", async () => {
  const { withoutDirectRuns, workflowPathFilters, directlyTriggered } =
    await import("../scripts/ci-playwright-config-scope.mjs");
  const dispatcher = [
    "    if: needs.scope.outputs.alpha == 'true'", "    uses: ./.github/workflows/alpha.yml",
    "    if: needs.scope.outputs.beta_2 == 'true'", "    uses: ./.github/workflows/beta.yml",
    "    if: needs.scope.outputs.gamma == 'true'", "    uses: ./.github/workflows/gamma.yml",
  ].join("\n");
  const files = {
    "alpha.yml": 'on:\n  workflow_call:\n  pull_request:\n    paths:\n      - "lib/alpha-*.ts"\n      - "playwright.config.ts"\n',
    "beta.yml": 'on:\n  pull_request:\n    paths:\n      - "lib/beta.ts"\n  workflow_dispatch:\n',
    "gamma.yml": 'on:\n  pull_request:\n    branches: [main]\n    paths:\n      - "lib/alpha-x.ts"\n',
  };
  const read = (file) => files[file];
  const changed = ["playwright.config.ts", "lib/alpha-x.ts"];
  assert.deepEqual(withoutDirectRuns(["alpha", "beta_2", "gamma", "delta"], changed, read, dispatcher),
    ["beta_2", "gamma", "delta"], "only alpha runs directly; unmodelled gamma and unmapped delta stay");
  assert.equal(workflowPathFilters(files["gamma.yml"]), null);
  assert.equal(workflowPathFilters('on:\n  pull_request:\n'), null, "no paths = unknown, keep dispatch");
  assert.equal(directlyTriggered(["lib/beta.ts"], ["lib/{beta}.ts"]), false);
  assert.deepEqual(withoutDirectRuns(["alpha"], changed, () => { throw Error("missing"); }, dispatcher), ["alpha"]);
});

test("#493: more than 300 changed files never suppresses a dispatch (GitHub path-filter limit)", async () => {
  const { withoutDirectRuns, GITHUB_PATH_FILTER_FILE_LIMIT } = await import("../scripts/ci-playwright-config-scope.mjs");
  assert.equal(GITHUB_PATH_FILTER_FILE_LIMIT, 300);
  const dispatcher = "    if: needs.scope.outputs.alpha == 'true'\n    uses: ./.github/workflows/alpha.yml";
  const read = () => 'on:\n  pull_request:\n    paths:\n      - "lib/alpha.ts"\n';
  const few = ["lib/alpha.ts"];
  const many = [...Array.from({ length: 300 }, (_, i) => "docs/f" + i + ".md"), "lib/alpha.ts"];
  assert.deepEqual(withoutDirectRuns(["alpha"], few, read, dispatcher), []);
  assert.deepEqual(withoutDirectRuns(["alpha"], many, read, dispatcher), ["alpha"]);
});

test("#493: every test that touches workflow files is found by the workflow-reader rule", () => {
  // The PR selector finds workflow readers by the literal ".github/workflows";
  // a test assembling that path in pieces would be missed, so forbid it.
  for (const file of readdirSync("tests").filter((name) => name.endsWith(".test.mjs"))) {
    const source = readFileSync("tests/" + file, "utf8");
    if (/["'`]\.github["'`]/.test(source) && /workflows/.test(source))
      assert.match(source, /\.github\/workflows/, file + " must reference .github/workflows literally");
  }
});
