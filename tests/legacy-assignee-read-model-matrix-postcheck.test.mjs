import assert from "node:assert/strict";
import test from "node:test";
import { classifiedTables, storeTables } from "../lib/backup-scope.ts";
import {
  checkLegacyAssigneeReadModelMatrixPreservation,
  LegacyAssigneeReadModelMatrixBlocked,
} from "../lib/legacy-assignee-read-model-matrix-postcheck.ts";

const sideNames = classifiedTables().filter(
  name => name !== "metadata" && !storeTables.includes(name));
const sideTables = () => Object.fromEntries(sideNames.map(name => [name, []]));
const context = (actorUserId, asOf = "2026-10-26T11:00:00.000Z",
  queryFingerprint = "route-v1:sort-by-due") => ({
  actorUserId, asOf, timezone: "Europe/Prague", queryFingerprint,
});
const workspace = (id, kind = "shared") => ({
  id: "workspace:" + id, type: "workspace", title: "PRIVATE-" + id,
  status: "active", workspaceId: id,
  properties: { kind, role: "owner", members: [{ id: "owner", role: "owner" }] },
  createdAt: 1, updatedAt: 2,
});
const task = (id, workspaceId, properties = {}) => ({
  id, type: "task", workspaceId, title: "PRIVATE-" + id, status: "open",
  properties, createdAt: 1, updatedAt: 2,
});
const initial = ctx => ({
  revision: 15, restoreGeneration: 7,
  entities: [
    workspace("legacy"), workspace("personal", "personal"),
    task("legacy-task", "legacy", { inbox: true, today: true }),
    task("private-task", "personal"),
  ],
  relations: [], tombstones: [{ id: "removed", deletedAt: 10 }],
  sideTables: sideTables(),
  metadata: [
    { key: "revision", value: "15" },
    { key: "updatedAt", value: "100" },
    { key: "restoreGeneration", value: "7" },
    { key: "vapidKeys", value: "SECRET-credentials" },
  ],
  readModels: {
    context: structuredClone(ctx),
    home: { cards: [{ id: "SECRET-home", count: 2 }] },
    today: [{ id: "SECRET-today", done: false }],
    inbox: { items: [{ id: "SECRET-inbox" }], total: 1 },
  },
});
const next = old => {
  const result = structuredClone(old);
  result.revision++;
  result.metadata.find(row => row.key === "revision").value = "16";
  result.metadata.find(row => row.key === "updatedAt").value = "101";
  const legacyTask = result.entities.find(entity => entity.id === "legacy-task");
  legacyTask.properties.assigneeUserId = "owner";
  legacyTask.updatedAt++;
  return result;
};
const scenario = ctx => {
  const before = initial(ctx);
  return { before, after: next(before) };
};
const a = context("owner");
const b = context("member", "2026-10-26T13:00:00.000Z");
const c = context("owner", "2026-10-27T10:00:00.000Z", "route-v2:sort-by-priority");
const fixture = () => ({
  expectedContexts: [structuredClone(a), structuredClone(b), structuredClone(c)],
  cases: [scenario(b), scenario(c), scenario(a)],
  legacySharedWorkspaceIds: ["legacy"],
});
const check = input => checkLegacyAssigneeReadModelMatrixPreservation(input);
const rejects = input =>
  assert.throws(() => check(input), LegacyAssigneeReadModelMatrixBlocked);

test("2c/7 accepts an exact unordered context manifest, reports counts only, never authorizes actions", () => {
  const input = fixture();
  const frozenBefore = structuredClone(input);
  const result = check(input);
  assert.deepEqual(result, {
    phase: "legacy-assignee-read-model-matrix-postcheck-only",
    checkedContextCount: 3,
    comparedReadModelCount: 9,
    verifiedPersistedState: false,
    verifiedMetadata: false,
    verifiedSideTables: false,
    verifiedHomeTodayInbox: false,
    canApply: false,
    canReleaseHold: false,
    canActivateMyPlan: false,
    canEnableSharing: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(input, frozenBefore);
  assert.doesNotMatch(JSON.stringify(result), /owner|member|SECRET|queryFingerprint/);
});

test("2c/7 permits one complete context but rejects an empty or overlarge manifest", () => {
  const one = { expectedContexts: [a], cases: [scenario(a)], legacySharedWorkspaceIds: ["legacy"] };
  assert.equal(check(one).comparedReadModelCount, 3);
  rejects({ ...one, expectedContexts: [], cases: [] });
  const tooMany = Array.from({ length: 17 }, (_, i) =>
    context("owner", "2026-10-26T11:00:00.000Z", "fingerprint:" + i));
  rejects({ ...one, expectedContexts: tooMany });
  rejects({ ...one, cases: Array.from({ length: 17 }, () => scenario(a)) });
});

test("2c/7 rejects missing, extra and duplicate cases or manifest contexts", () => {
  const missing = fixture();
  missing.cases.pop();
  rejects(missing);
  const extra = fixture();
  extra.cases.push(scenario(context("stranger")));
  rejects(extra);
  const duplicated = fixture();
  duplicated.cases[1] = scenario(b);
  rejects(duplicated);
  const repeatedManifest = fixture();
  repeatedManifest.expectedContexts[1] = structuredClone(a);
  rejects(repeatedManifest);
  const missingExpected = fixture();
  missingExpected.expectedContexts[1] = context("unknown");
  rejects(missingExpected);
});

test("2c/7 rejects mismatched or swapped contexts even with unchanged view responses", () => {
  const mismatched = fixture();
  mismatched.cases[0].after.readModels.context.actorUserId = "other";
  rejects(mismatched);
  const swapped = fixture();
  swapped.cases[0].after.readModels.context = structuredClone(a);
  rejects(swapped);
  const alteredQuery = fixture();
  alteredQuery.cases[1].after.readModels.context.queryFingerprint = "other-sort";
  rejects(alteredQuery);
  const missingField = fixture();
  delete missingField.expectedContexts[0].timezone;
  rejects(missingField);
  const extraField = fixture();
  extraField.expectedContexts[1].untrusted = "x";
  rejects(extraField);
  const changedVisibility = fixture();
  changedVisibility.cases[0].before.readModels.context.queryFingerprint = "different-ACL";
  changedVisibility.cases[0].after.readModels.context.queryFingerprint = "different-ACL";
  rejects(changedVisibility);
});

test("2c/7 uses collision-free context identifiers", () => {
  const ctx1 = context("a|b", "c");
  const ctx2 = context("a", "b|c");
  const input = {
    expectedContexts: [ctx1, ctx2],
    cases: [scenario(ctx2), scenario(ctx1)],
    legacySharedWorkspaceIds: ["legacy"],
  };
  assert.equal(check(input).checkedContextCount, 2);
  input.cases[0].before.readModels.context = structuredClone(ctx1);
  input.cases[0].after.readModels.context = structuredClone(ctx1);
  rejects(input);
});

test("2c/7 propagates view and prior-stage failures across the whole matrix", () => {
  const changedToday = fixture();
  changedToday.cases[1].after.readModels.today[0].done = true;
  rejects(changedToday);
  const changedPrivateTask = fixture();
  changedPrivateTask.cases[2].after.entities.find(x => x.id === "private-task").title = "changed";
  rejects(changedPrivateTask);
  const changedMetadata = fixture();
  changedMetadata.cases[0].after.metadata.find(x => x.key === "vapidKeys").value = "SECRET-rotated";
  rejects(changedMetadata);
  const changedSideTable = fixture();
  changedSideTable.cases[1].after.sideTables.mail_accounts.push({ token: "SECRET-token" });
  rejects(changedSideTable);
});

test("2c/7 rejects getters, non-data fields, sparse arrays, symbols and proxies without running traps", () => {
  let getterCalls = 0, trapCalls = 0;
  const wrap = target => new Proxy(target, {
    getPrototypeOf(value) { trapCalls++; return Reflect.getPrototypeOf(value); },
    ownKeys(value) { trapCalls++; return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, key) {
      trapCalls++;
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
  for (const mutate of [
    input => { input.cases = wrap(input.cases); },
    input => { input.expectedContexts[0] = wrap(input.expectedContexts[0]); },
    input => { input.cases[0] = wrap(input.cases[0]); },
    input => { input.cases[0].before = wrap(input.cases[0].before); },
    input => { input.cases[0].before.readModels = wrap(input.cases[0].before.readModels); },
    input => { input.cases[0].before.readModels.context =
      wrap(input.cases[0].before.readModels.context); },
    input => { input.legacySharedWorkspaceIds = wrap(input.legacySharedWorkspaceIds); },
  ]) {
    const input = fixture();
    mutate(input);
    rejects(input);
    assert.equal(trapCalls, 0, "no proxy handler must run");
  }
  const getter = fixture();
  const before = getter.cases[0].before;
  Object.defineProperty(getter.cases[0], "before", {
    enumerable: true, get() { getterCalls++; return before; },
  });
  rejects(getter);
  assert.equal(getterCalls, 0);

  const inherited = fixture();
  const value = inherited.cases[0].before;
  delete inherited.cases[0].before;
  Object.setPrototypeOf(inherited.cases[0], { before: value });
  rejects(inherited);

  const sparse = fixture();
  delete sparse.cases[1];
  rejects(sparse);

  const symbol = fixture();
  symbol.expectedContexts[0][Symbol("hidden")] = "SECRET";
  rejects(symbol);

  const accessorArray = fixture();
  Object.defineProperty(accessorArray.cases, "0", {
    enumerable: true, get() { getterCalls++; return scenario(b); },
  });
  rejects(accessorArray);
  assert.equal(getterCalls, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const revokedInput = fixture();
  revokedInput.cases[0] = revoked.proxy;
  rejects(revokedInput);
});

test("2c/7 rejects malformed context text and unexpected shell keys", () => {
  const blank = fixture();
  blank.expectedContexts[0].actorUserId = "   ";
  rejects(blank);
  const huge = fixture();
  huge.cases[0].before.readModels.context.queryFingerprint = "x".repeat(513);
  huge.cases[0].after.readModels.context.queryFingerprint = "x".repeat(513);
  rejects(huge);
  const extra = fixture();
  extra.extra = "SECRET";
  rejects(extra);
  const unexpectedPair = fixture();
  unexpectedPair.cases[0].unexpected = true;
  rejects(unexpectedPair);
  const legacyId = fixture();
  legacyId.legacySharedWorkspaceIds = ["legacy", ""];
  rejects(legacyId);
});
