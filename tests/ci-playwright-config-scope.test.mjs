import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  }
});
