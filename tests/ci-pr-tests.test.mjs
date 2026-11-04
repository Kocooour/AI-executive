import test from "node:test";
import assert from "node:assert/strict";
import { chooseTests, needsCodeChecks } from "../scripts/ci-pr-tests.mjs";

const available = [
  "tests/server-errors.test.mjs",
  "tests/client-auth-status.test.mjs",
  "tests/view-url.test.mjs",
  "tests/area-write-invariants.test.mjs",
  "tests/context-evidence-leaks.test.mjs",
  "tests/target-area-policy.test.mjs",
  "tests/target-note-access.test.mjs",
  "tests/target-staging-membership-command.test.mjs",
  "tests/target-staging-session-authority.test.mjs",
  "tests/target-staging-shared-reads.test.mjs",
  "tests/target-task-authenticated-read.test.mjs",
  "tests/work-read-scope.test.mjs",
  "tests/mobile-navigation-v1.test.mjs",
  "tests/task-row-value.test.mjs",
  "tests/work-scope-navigation.test.mjs",
  "tests/example.test.mjs",
  "tests/calendar-overview.test.mjs",
  "tests/target-staging-notes-http.test.mjs",
];

test("documentation-only changes skip expensive code validation", () => {
  assert.equal(needsCodeChecks(["AGENTS.md", "docs/DEVELOPMENT.md"]), false);
  assert.equal(needsCodeChecks(["docs/README.md", "lib/auth.ts"]), true);
  assert.equal(needsCodeChecks([".github/workflows/pr-checks.yml"]), true);
});

test("ordinary PR selects smoke, changed tests and direct consumers", () => {
  const out = chooseTests(["lib/example.ts", "tests/example.test.mjs"], available, {
    "tests/example.test.mjs": 'import "../lib/example.ts";',
  });
  assert.equal(out.full, false);
  assert.ok(out.selected.includes("tests/example.test.mjs"));
  assert.ok(out.selected.includes("tests/server-errors.test.mjs"));
  assert.equal(out.selected.includes("tests/context-evidence-leaks.test.mjs"), false);
});

test("security-sensitive change always selects authorization regressions", () => {
  const out = chooseTests(["lib/target-staging-session-authority.ts"], available);
  assert.equal(out.full, false);
  assert.ok(out.selected.includes("tests/target-staging-session-authority.test.mjs"));
  assert.ok(out.selected.includes("tests/context-evidence-leaks.test.mjs"));
});

test("P1: changing an API route selects its exact HTTP regression test", () => {
  const route = "app/api/target-staging/notes/[noteId]/route.ts";
  const out = chooseTests([route], available, {
    "tests/target-staging-notes-http.test.mjs":
      'const { GET } = await import("../app/api/target-staging/notes/[noteId]/route.ts");',
  });
  assert.equal(out.full, false);
  assert.ok(out.selected.includes("tests/target-staging-notes-http.test.mjs"));
  assert.ok(out.selected.includes("tests/target-note-access.test.mjs"));
  assert.equal(out.selected.includes("tests/mobile-navigation-v1.test.mjs"), false);
});

test("P1: untraceable API endpoints trigger all unit tests instead of green smoke only", () => {
  const out = chooseTests(["app/api/untested/route.ts"], available);
  assert.equal(out.full, true);
  assert.equal(out.selected.length, available.length);
});

test("P2: local-dates changes run transitively dependent calendar overview tests", () => {
  const out = chooseTests(["lib/local-dates.ts"], available, {
    "lib/calendar-overview.ts":
      'import { zonedDateTimeToIso } from "./local-dates";',
    "tests/calendar-overview.test.mjs":
      'import { calendarOverviewIntersects } from "../lib/calendar-overview.ts";',
  });
  assert.equal(out.full, false);
  assert.ok(out.selected.includes("tests/calendar-overview.test.mjs"));
});

test("reverse import traversal handles cycles, extensionless imports and alias imports", () => {
  const out = chooseTests(["lib/shared.ts"], available, {
    "lib/a.ts": 'import "./b"; import "@/lib/shared";',
    "lib/b.ts": 'import "./a";',
    "tests/example.test.mjs": 'import "../lib/b.ts";',
  });
  assert.ok(out.selected.includes("tests/example.test.mjs"));
});

test("UI changes select focused mobile/navigation checks", () => {
  const out = chooseTests(["app/page.tsx"], available);
  assert.ok(out.selected.includes("tests/mobile-navigation-v1.test.mjs"));
  assert.ok(out.selected.includes("tests/task-row-value.test.mjs"));
});

test("toolchain changes force the complete unit suite even on PRs", () => {
  const out = chooseTests(["pnpm-lock.yaml"], available);
  assert.equal(out.full, true);
  assert.equal(out.selected.length, available.length);
});
