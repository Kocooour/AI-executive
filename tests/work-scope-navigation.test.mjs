import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_WORK_READ_SCOPE,
  WORK_READ_SCOPE_ORDER,
  WORK_READ_SCOPE_TEXT,
  parseWorkReadScope,
} = await import("../lib/work-scope-navigation.ts");

test("D3 scope navigation has exactly the approved three read-only scopes", () => {
  assert.deepEqual([...WORK_READ_SCOPE_ORDER], ["my-plan", "personal", "shared"]);
  assert.equal(DEFAULT_WORK_READ_SCOPE, "my-plan");
  for (const scope of WORK_READ_SCOPE_ORDER) assert.equal(parseWorkReadScope(scope), scope);
});

test("internal workspaces and malformed values are not user-visible read scopes", () => {
  for (const value of ["all", "workspace:personal", "area:shared", "", "My plan", null, undefined, 1, {}, []]) {
    assert.equal(parseWorkReadScope(value), null);
  }
});

test("both languages label all scopes without inventing a third workspace", () => {
  assert.equal(WORK_READ_SCOPE_TEXT.cs.labels["my-plan"], "Můj plán");
  for (const language of ["cs", "en"]) {
    assert.ok(WORK_READ_SCOPE_TEXT[language].group);
    assert.deepEqual(Object.keys(WORK_READ_SCOPE_TEXT[language].labels), [...WORK_READ_SCOPE_ORDER]);
    assert.ok(WORK_READ_SCOPE_ORDER.every((scope) => WORK_READ_SCOPE_TEXT[language].labels[scope]));
  }
});
