#!/usr/bin/env node
// Fail-closed PR impact selection for changes to the shared Playwright config.
// Independent feature workflows retain their normal path-scoped PR triggers.
// If changed executable lines cannot be classified, run ALL affected profiles.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const BROWSER_PROFILES = [
  "main_title", "humanwiki", "mobile_more", "note_preview",
  "detail_races", "global_capture", "inbox", "note_edit",
  "note_areas", "note_create", "task_create", "project_title",
  "task_preview", "title_preview",
];

// Only isolated feature switches can be categorized safely by their changed
// lines. Shared server config, fixtures, testMatch, webServer, security/auth,
// global browser options, unknown/new flags, etc. deliberately select ALL.
// Values below are NOT globs or claims of test coverage by unrelated sentinels.
const KNOWN_SWITCHES = [
  [/\b(?:noteEditProfile|noteEditRecoveryTest|LUMI_TARGET_NOTE_EDIT_PROFILE|LUMI_TARGET_NOTE_EDIT_E2E)\b/, ["note_edit"]],
  [/\b(?:mainTitleSearchTest|mainTitleSearchMode|LUMI_TARGET_MAIN_SEARCH_E2E|LUMI_TARGET_MAIN_SEARCH_MODE)\b/, ["main_title"]],
  [/\b(?:titleSearchPreviewTest|LUMI_TITLE_SEARCH_PREVIEW_E2E)\b/, ["title_preview"]],
  [/\b(?:taskPreviewTest|LUMI_TASK_PREVIEW_E2E)\b/, ["task_preview"]],
  [/\b(?:notePreviewTest|LUMI_NOTE_PREVIEW_E2E)\b/, ["note_preview"]],
  [/\b(?:targetDetailEditRaceTest|LUMI_TARGET_DETAIL_EDITS_E2E)\b/, ["detail_races"]],
  [/\b(?:privateNoteAreasTest|LUMI_PRIVATE_NOTE_AREAS_E2E)\b/, ["note_areas"]],
  [/\b(?:privateNoteCreateTest|LUMI_PRIVATE_NOTE_CREATE_E2E)\b/, ["note_create"]],
  [/\b(?:privateTaskCreateTest|LUMI_PRIVATE_TASK_CREATE_E2E)\b/, ["task_create"]],
  [/\b(?:globalCaptureTest|LUMI_TARGET_GLOBAL_CAPTURE_E2E)\b/, ["global_capture"]],
  [/\b(?:projectTitleRecoveryTest|LUMI_TARGET_PROJECT_TITLE_E2E)\b/, ["project_title"]],
  [/\b(?:inboxAcceptanceTest|LUMI_TARGET_INBOX_E2E)\b/, ["inbox"]],
  // The retained personal acceptance sentinel already runs for any config edit.
  [/\b(?:personalAcceptanceTest|LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E)\b/, []],
];

function changedExecutableLines(patch) {
  return patch.split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim())
    .filter((line) => line && !/^(?:\/\/|\/\*|\*|\*\/)/.test(line));
}

export function selectBrowserProfiles(patch) {
  if (typeof patch !== "string" || !patch.trim() || patch.includes("Binary files ")) {
    return [...BROWSER_PROFILES]; // No config diff (selector itself changed): fail closed.
  }
  const lines = changedExecutableLines(patch);
  if (!lines.length) return []; // Comment/whitespace-only change: 3 sentinels remain.
  const selected = new Set();
  for (const line of lines) {
    const rules = KNOWN_SWITCHES.filter(([pattern]) => pattern.test(line));
    if (!rules.length) return [...BROWSER_PROFILES]; // Unknown/global edit.
    for (const [, profiles] of rules) for (const profile of profiles) selected.add(profile);
  }
  return BROWSER_PROFILES.filter((profile) => selected.has(profile));
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
