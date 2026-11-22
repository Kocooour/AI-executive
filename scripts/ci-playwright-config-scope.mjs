#!/usr/bin/env node
// Fail-closed PR impact selection for the shared Playwright config.
// Matching a variable name in an arbitrary changed expression is NOT proof
// that the enclosing feature owns the change (cross-feature references exist).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const BROWSER_PROFILES = [
  "main_title", "humanwiki", "mobile_more", "note_preview",
  "detail_races", "global_capture", "inbox", "note_edit",
  "note_areas", "note_create", "task_create", "project_title",
  "task_preview", "title_preview",
];

// These two defaults are inert unless their *own* opt-in test flag is true.
// Every other executable edit, including a changed feature guard, added object
// property, comment-only edit or a line mentioning another known feature flag,
// is ambiguous without checking the surrounding TypeScript scope: run ALL.
// Keep this allowlist small; do not match arbitrary variable occurrences.
const ISOLATED_PROFILE_DEFAULTS = [
  {
    profile: "note_edit",
    declaration: /^const noteEditProfile = process\.env\.LUMI_TARGET_NOTE_EDIT_PROFILE \?\? "(?:legacy|combined|4b)";$/,
  },
  {
    profile: "main_title",
    declaration: /^const mainTitleSearchMode = process\.env\.LUMI_TARGET_MAIN_SEARCH_MODE \?\? "(?:on|off)";$/,
  },
];

export function selectBrowserProfiles(patch) {
  if (typeof patch !== "string" || !patch.trim() || patch.includes("Binary files ")) {
    return [...BROWSER_PROFILES];
  }
  // Only a single contiguous old/new declaration replacement is provably
  // isolated without a TS parser. Extra hunks/lines, comments, deletions or
  // additions are deliberately fail-closed, never guessed from variable names.
  const hunks = patch.split("\n").filter((line) => line.startsWith("@@ ")).length;
  const changed = patch.split("\n").filter((line) =>
    /^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line));
  if (hunks !== 1 || changed.length !== 2
    || !changed[0].startsWith("-") || !changed[1].startsWith("+")) {
    return [...BROWSER_PROFILES];
  }
  const before = changed[0].slice(1);
  const after = changed[1].slice(1);
  for (const { profile, declaration } of ISOLATED_PROFILE_DEFAULTS) {
    if (declaration.test(before) && declaration.test(after)) return [profile];
  }
  return [...BROWSER_PROFILES];
}

function main() {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!/^[a-f0-9]{40}$/i.test(base ?? "") || !/^[a-f0-9]{40}$/i.test(head ?? "")) {
    throw new Error("Expected complete BASE_SHA and HEAD_SHA from the pull request");
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT");
  const patch = execFileSync("git", ["diff", "--unified=0",
    base + "..." + head, "--", "playwright.config.ts"], { encoding: "utf8" });
  const selected = new Set(selectBrowserProfiles(patch));
  for (const profile of BROWSER_PROFILES) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      profile + "=" + (selected.has(profile) ? "true" : "false") + "\n");
  }
  console.log("Playwright config affected profiles: " +
    (selected.size ? [...selected].join(", ") : "sentinels only"));
}

if (process.argv[1]?.endsWith("/ci-playwright-config-scope.mjs")) main();
