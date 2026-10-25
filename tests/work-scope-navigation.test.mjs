import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_WORK_READ_SCOPE,
  WORK_READ_SCOPE_ORDER,
  WORK_SCOPE_GROUP_COPY_KEY,
  workScopeCopyKey,
  parseWorkReadScope,
} = await import("../lib/work-scope-navigation.ts");
const { copy } = await import("../app/ui/copy.ts");

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

test("both languages label all scopes in the app copy without inventing a third workspace", () => {
  assert.equal(copy.cs[workScopeCopyKey("my-plan")], "Můj plán");
  assert.equal(copy.en[workScopeCopyKey("my-plan")], "My plan");
  for (const language of ["cs", "en"]) {
    assert.ok(copy[language][WORK_SCOPE_GROUP_COPY_KEY]);
    assert.ok(WORK_READ_SCOPE_ORDER.every((scope) => copy[language][workScopeCopyKey(scope)]));
    assert.deepEqual(Object.keys(copy[language]).filter((key) => key.startsWith("workScope") && key !== WORK_SCOPE_GROUP_COPY_KEY).sort(),
      WORK_READ_SCOPE_ORDER.map(workScopeCopyKey).sort());
  }
});
