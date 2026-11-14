import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOrderedPair, selectedDesktopTests } from "../scripts/verify-release0-c16-pair.mjs";

const first = "e2e/c16-01-tabs.spec.ts";
const second = "e2e/c16-02-project.spec.ts";
const firstTitle = "signing out in one tab first saves a title being typed in another";
const originalFailure = "aggregate project deep links survive reload and stale list markers cannot reopen a record";

test("C16 selection guard accepts only the original project failure following logout", () => {
  const listing = `Listing tests:
  [setup] › auth.setup.ts:7:6 › sign in and seed synthetic data
  [desktop] › c16-01-tabs.spec.ts:25:5 › ${firstTitle}
  [desktop] › c16-02-project.spec.ts:399:5 › ${originalFailure}
Total: 3 tests in 3 files`;
  assert.deepEqual(assertOrderedPair(listing, first, firstTitle, second, originalFailure), [
    { file: "c16-01-tabs.spec.ts", title: firstTitle },
    { file: "c16-02-project.spec.ts", title: originalFailure },
  ]);
  const execution = `Running 3 tests using 1 worker
  ✓  1 [setup] › e2e/auth.setup.ts:7:6 › sign in and seed synthetic data (1s)
  ✓  2 [desktop] › e2e/c16-01-tabs.spec.ts:25:5 › ${firstTitle} (4s)
  ✓  3 [desktop] › e2e/c16-02-project.spec.ts:399:5 › ${originalFailure} (4s)
  3 passed (9s)`;
  assert.equal(assertOrderedPair(execution, first, firstTitle, second, originalFailure).length, 2);
});

test("C16 guard rejects historical wrong C10 test, empty selection and reversed order", () => {
  const wrong = `[desktop] › c16-01-tabs.spec.ts:25:5 › ${firstTitle}
[desktop] › c16-02-project.spec.ts:286:5 › C10: inspector Close preserves project Back origin and scoped typed parent`;
  assert.throws(() => assertOrderedPair(wrong, first, firstTitle, second, originalFailure), /required ordered pair/);
  assert.throws(() => assertOrderedPair("", first, firstTitle, second, originalFailure), /required ordered pair/);
  const reversed = `[desktop] › c16-02-project.spec.ts:399:5 › ${originalFailure}
[desktop] › c16-01-tabs.spec.ts:25:5 › ${firstTitle}`;
  assert.throws(() => assertOrderedPair(reversed, first, firstTitle, second, originalFailure), /required ordered pair/);
});

test("C16 guard rejects unanticipated extra cases and malformed desktop log lines", () => {
  const extra = `[desktop] › c16-01-tabs.spec.ts:25:5 › ${firstTitle}
[desktop] › c16-02-project.spec.ts:399:5 › ${originalFailure}
[desktop] › c16-02-project.spec.ts:402:5 › unrelated test`;
  assert.throws(() => assertOrderedPair(extra, first, firstTitle, second, originalFailure), /required ordered pair/);
  assert.throws(() => selectedDesktopTests("[desktop] › malformed"), /Unrecognized/);
});
