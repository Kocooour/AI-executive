import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BROWSER_PROFILES, selectBrowserProfiles } from "../scripts/ci-playwright-config-scope.mjs";

function patch(...changes) {
  return ["diff --git a/playwright.config.ts b/playwright.config.ts",
    "--- a/playwright.config.ts", "+++ b/playwright.config.ts",
    "@@ -1,1 +1,1 @@", ...changes].join("\n");
}

test("P2: config-only note-editor profile change selects all note-edit browser matrix jobs", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-        ...(noteEditProfile==="4b" ? {} : {AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED: "true"}),',
    '+        ...(noteEditProfile==="combined" ? {} : {AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED: "true"}),'
  )), ["note_edit"]);
});

test("config-only private capture switch selects its owning browser suite", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    '-const privateTaskCreateTest = process.env.LUMI_PRIVATE_TASK_CREATE_E2E === "true";',
    '+const privateTaskCreateTest = process.env.LUMI_PRIVATE_TASK_CREATE_E2E !== "false";'
  )), ["task_create"]);
});

test("mixed independent feature edits select union of owning jobs", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    "-const noteEditProfile = something;",
    "+const noteEditProfile = somethingElse;",
    "-const inboxAcceptanceTest = oldValue;",
    "+const inboxAcceptanceTest = newValue;"
  )), ["inbox", "note_edit"]);
});

test("unknown global Playwright/server changes run every focused browser profile", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    "-  workers: 1,",
    "+  workers: 4,"
  )), BROWSER_PROFILES);
  assert.deepEqual(selectBrowserProfiles(patch(
    "-const noteEditProfile = old;",
    "+const noteEditProfile = next;",
    "+  use: { storageState: 'shared.json' },"
  )), BROWSER_PROFILES);
  assert.deepEqual(selectBrowserProfiles(""), BROWSER_PROFILES);
});

test("comments do not inflate scoped profile selection", () => {
  assert.deepEqual(selectBrowserProfiles(patch(
    "- // Legacy helper comment",
    "+ // Updated helper comment",
    "-const inboxAcceptanceTest = oldValue;",
    "+const inboxAcceptanceTest = newValue;"
  )), ["inbox"]);
});

test("config impact workflow calls all affected existing scoped workflows", () => {
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
