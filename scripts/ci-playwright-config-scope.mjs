#!/usr/bin/env node
// Fail-closed PR impact selection for the shared Playwright config.
// Matching a variable name in an arbitrary changed expression is NOT proof
// that the enclosing feature owns the change (cross-feature references exist).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const BROWSER_PROFILES = [
  "main_title", "humanwiki", "mobile_more", "note_preview",
  "detail_races", "global_capture", "inbox", "note_edit",
  "note_areas", "note_create", "task_create", "project_title",
  "task_preview", "title_preview", "project_tasks", "backup_restore", "legacy_c4",
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
  const changed = [];
  let hunks = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      hunks++;
    } else if (hunks > 0 && (line.startsWith("+") || line.startsWith("-"))) {
      // Once inside a hunk, ---/+++ can be real source (e.g. --counter;).
      // Only the diff headers BEFORE the first hunk may be ignored.
      changed.push(line);
    }
  }
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

// #493: a dispatched suite whose OWN pull_request path filter already matches
// this PR runs directly anyway; dispatching it again only duplicates the job.
// Only a provably matching, fully understood filter suppresses a dispatch;
// anything unusual keeps the (redundant but safe) dispatched run.

/** GitHub workflow path glob -> RegExp, or null for syntax we do not model. */
export function globToRegExp(glob) {
  if (typeof glob !== "string" || !glob || /[!+{}()|\\]/.test(glob)) return null;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) return null;
      const body = glob.slice(i + 1, end);
      if (!/^[A-Za-z0-9_.-]+$/.test(body)) return null;
      out += "[" + body.replace(/[-\]]/g, "\\$&") + "]";
      i = end;
    } else out += c.replace(/[.^$]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

/** Exact `on.pull_request.paths` list of a workflow, or null if absent/unusual. */
export function workflowPathFilters(text) {
  const lines = String(text).split("\n");
  const on = lines.indexOf("on:");
  if (on < 0) return null;
  let i = on + 1;
  for (; i < lines.length && /^\s|^$/.test(lines[i]); i++) {
    if (lines[i] === "  pull_request:") break;
  }
  if (lines[i] !== "  pull_request:" || lines[i + 1] !== "    paths:") return null;
  const paths = [];
  for (i += 2; i < lines.length; i++) {
    const m = /^      - (["']?)([^"']+)\1\s*$/.exec(lines[i]);
    if (!m) break;
    paths.push(m[2]);
  }
  // Any further pull_request key (branches, paths-ignore, types) is not modelled.
  if (!paths.length || /^    \S/.test(lines[i] ?? "")) return null;
  return paths;
}

export function directlyTriggered(changed, filters) {
  if (!Array.isArray(filters)) return false;
  const regexps = filters.map(globToRegExp);
  if (regexps.some((r) => r === null)) return false;
  return changed.some((file) => regexps.some((r) => r.test(file)));
}

/** profile -> reusable workflow file, read from the dispatcher itself. */
export function dispatchedWorkflows(dispatcher) {
  const map = {};
  for (const m of String(dispatcher).matchAll(
    /if: needs\.scope\.outputs\.([a-z0-9_]+) == 'true'\n\s+uses: \.\/\.github\/workflows\/([A-Za-z0-9_.-]+\.yml)/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

export function withoutDirectRuns(selected, changed, readWorkflow, dispatcher) {
  const map = dispatchedWorkflows(dispatcher);
  return selected.filter((profile) => {
    const file = map[profile];
    if (!file) return true;
    let text;
    try { text = readWorkflow(file); } catch { return true; }
    return !directlyTriggered(changed, workflowPathFilters(text));
  });
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
  const changed = execFileSync("git", ["diff", "--name-only", "-z", base + "..." + head],
    { encoding: "utf8" }).split("\0").filter(Boolean);
  const dispatcher = readFileSync(".github/workflows/playwright-config-impact-browser.yml", "utf8");
  const affected = selectBrowserProfiles(patch);
  const selected = new Set(withoutDirectRuns(affected, changed,
    (file) => readFileSync(".github/workflows/" + file, "utf8"), dispatcher));
  const direct = affected.filter((profile) => !selected.has(profile));
  if (direct.length) console.log("Already running directly (not dispatched again): " + direct.join(", "));
  for (const profile of BROWSER_PROFILES) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      profile + "=" + (selected.has(profile) ? "true" : "false") + "\n");
  }
  console.log("Playwright config affected profiles: " +
    (selected.size ? [...selected].join(", ") : "sentinels only"));
}

if (process.argv[1]?.endsWith("/ci-playwright-config-scope.mjs")) main();
