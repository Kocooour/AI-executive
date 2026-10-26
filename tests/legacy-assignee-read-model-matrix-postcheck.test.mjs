import assert from "node:assert/strict";
import test from "node:test";
import { classifiedTables, storeTables } from "../lib/backup-scope.ts";
import {
  matrixFingerprintBudget,
  matrixStoreTransitionFingerprint,
} from "../lib/legacy-assignee-matrix-state-fingerprint.ts";
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

test("2c/7 rejects otherwise valid cases with divergent claimed store transitions", () => {
  const differentRevisions = fixture();
  const caseWithDifferentRevisions = differentRevisions.cases[1];
  caseWithDifferentRevisions.before.revision = 25;
  caseWithDifferentRevisions.after.revision = 26;
  caseWithDifferentRevisions.before.metadata.find(row => row.key === "revision").value = "25";
  caseWithDifferentRevisions.after.metadata.find(row => row.key === "revision").value = "26";
  rejects(differentRevisions);

  const differentSideTableCount = fixture();
  differentSideTableCount.cases[0].before.sideTables.attention_history.push({ id: "shared" });
  differentSideTableCount.cases[0].after.sideTables.attention_history.push({ id: "shared" });
  rejects(differentSideTableCount);
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
    input => { input.cases[0].after = wrap(input.cases[0].after); },
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

test("2c/7 rejects snapshot field getters without executing them on either side", () => {
  const fields = [
    "revision", "restoreGeneration", "entities", "relations", "tombstones",
    "sideTables", "metadata", "readModels",
  ];
  let getterCalls = 0;
  for (const side of ["before", "after"]) {
    for (const field of fields) {
      const input = fixture();
      const snapshot = input.cases[0][side];
      const original = snapshot[field];
      Object.defineProperty(snapshot, field, {
        enumerable: true, configurable: true,
        get() { getterCalls++; return original; },
      });
      rejects(input);
      assert.equal(getterCalls, 0, `${side}.${field} getter must never run`);
    }
  }
});

test("2c/7 rejects inherited, missing, additional and exotic snapshot fields", () => {
  let getterCalls = 0;
  for (const side of ["before", "after"]) {
    const inherited = fixture();
    const target = inherited.cases[0][side];
    const metadata = target.metadata;
    delete target.metadata;
    Object.setPrototypeOf(target, {
      get metadata() { getterCalls++; return metadata; },
    });
    rejects(inherited);
    assert.equal(getterCalls, 0, "inherited metadata getter must never run");

    const missing = fixture();
    delete missing.cases[0][side].metadata;
    rejects(missing);

    const extra = fixture();
    extra.cases[0][side].untrusted = true;
    rejects(extra);

    const nonEnumerable = fixture();
    Object.defineProperty(nonEnumerable.cases[0][side], "hidden", {
      value: "SECRET", enumerable: false,
    });
    rejects(nonEnumerable);

    const symbol = fixture();
    symbol.cases[0][side][Symbol("hidden")] = "SECRET";
    rejects(symbol);

    const exotic = fixture();
    Object.setPrototypeOf(exotic.cases[0][side], Date.prototype);
    rejects(exotic);

    // Plain objects with null prototypes remain valid inputs.
    const nullPrototype = fixture();
    Object.setPrototypeOf(nullPrototype.cases[0][side], null);
    assert.equal(check(nullPrototype).checkedContextCount, 3);
  }
});

test("2c/7 blocks nested proxy traps in every delegated data layer", () => {
  let trapCalls = 0;
  const wrap = target => new Proxy(target, {
    get(target, key, receiver) { trapCalls++; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { trapCalls++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { trapCalls++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      trapCalls++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const withRows = () => {
    const input = fixture();
    for (const pair of input.cases) {
      for (const snapshot of [pair.before, pair.after]) {
        snapshot.sideTables.mail_accounts.push({ nested: { items: [{ token: "SECRET" }] } });
      }
    }
    return input;
  };
  assert.equal(check(withRows()).checkedContextCount, 3);
  const mutate = [
    ["metadata array", snapshot => { snapshot.metadata = wrap(snapshot.metadata); }],
    ["metadata row", snapshot => { snapshot.metadata[0] = wrap(snapshot.metadata[0]); }],
    ["side-table envelope", snapshot => { snapshot.sideTables = wrap(snapshot.sideTables); }],
    ["side-table array", snapshot => {
      snapshot.sideTables.mail_accounts = wrap(snapshot.sideTables.mail_accounts);
    }],
    ["side-table row", snapshot => {
      snapshot.sideTables.mail_accounts[0] = wrap(snapshot.sideTables.mail_accounts[0]);
    }],
    ["side-table nested object", snapshot => {
      const row = snapshot.sideTables.mail_accounts[0];
      row.nested = wrap(row.nested);
    }],
    ["side-table nested array", snapshot => {
      const nested = snapshot.sideTables.mail_accounts[0].nested;
      nested.items = wrap(nested.items);
    }],
    ["side-table deeply nested row", snapshot => {
      const nested = snapshot.sideTables.mail_accounts[0].nested;
      nested.items[0] = wrap(nested.items[0]);
    }],
    ["canonical entities array", snapshot => { snapshot.entities = wrap(snapshot.entities); }],
    ["canonical entity", snapshot => { snapshot.entities[0] = wrap(snapshot.entities[0]); }],
    ["canonical nested properties", snapshot => {
      snapshot.entities[0].properties = wrap(snapshot.entities[0].properties);
    }],
    ["canonical nested members array", snapshot => {
      const properties = snapshot.entities[0].properties;
      properties.members = wrap(properties.members);
    }],
  ];
  for (const [label, change] of mutate) {
    for (const side of ["before", "after"]) {
      const input = withRows();
      change(input.cases[0][side]);
      rejects(input);
      assert.equal(trapCalls, 0, `${label} (${side}) must not run proxy traps`);
    }
  }
});

test("2c/8 rejects different canonical records even when every aggregate count agrees", () => {
  const input = fixture();
  for (const side of ["before", "after"]) {
    input.cases[0][side].entities.find(row => row.id === "private-task").title =
      "SECRET-different-private-task";
  }
  rejects(input);
});

test("2c/8 rejects different side-table row content with matching counts", () => {
  const input = fixture();
  for (const pair of input.cases) {
    for (const snapshot of [pair.before, pair.after]) {
      snapshot.sideTables.mail_accounts.push({ account: "same", encrypted: "SECRET-original" });
    }
  }
  assert.equal(check(input).checkedContextCount, 3);
  for (const side of ["before", "after"]) {
    input.cases[0][side].sideTables.mail_accounts[0].encrypted = "SECRET-different";
  }
  rejects(input);
});

test("2c/8 rejects different unchanged metadata values across contexts", () => {
  const input = fixture();
  for (const side of ["before", "after"]) {
    input.cases[1][side].metadata.find(row => row.key === "vapidKeys").value =
      "SECRET-different-but-consistent-within-pair";
  }
  rejects(input);
});

test("2c/8 permits reordering of canonical rows, metadata and side-table multisets", () => {
  const input = fixture();
  for (const pair of input.cases) {
    for (const snapshot of [pair.before, pair.after]) {
      snapshot.sideTables.mail_accounts.push(
        { id: "x", payload: { b: [1, 2], a: "unchanged" } },
        { id: "y", payload: { a: null, b: 3 } },
      );
    }
  }
  for (const snapshot of [input.cases[0].before, input.cases[0].after]) {
    snapshot.entities.reverse();
    snapshot.metadata.reverse();
    snapshot.sideTables.mail_accounts.reverse();
    snapshot.sideTables.mail_accounts[0] = {
      payload: { b: 3, a: null }, id: "y",
    };
    snapshot.sideTables.mail_accounts[1] = {
      payload: { a: "unchanged", b: [1, 2] }, id: "x",
    };
  }
  const result = check(input);
  assert.equal(result.checkedContextCount, 3);
  assert.equal(result.canApply, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|digest|fingerprint|metadata/);
});

test("2c/8 preserves duplicate side-table row multiplicity across contexts", () => {
  const input = fixture();
  const aRow = { id: "A", encrypted: "SECRET-A" };
  const bRow = { id: "B", encrypted: "SECRET-B" };
  for (const pair of input.cases) {
    for (const snapshot of [pair.before, pair.after]) {
      snapshot.sideTables.mail_accounts.push(
        structuredClone(aRow), structuredClone(aRow), structuredClone(bRow));
    }
  }

  // The first context has [B, A, A], all others have [A, A, B].
  for (const snapshot of [input.cases[0].before, input.cases[0].after]) {
    snapshot.sideTables.mail_accounts.reverse();
  }
  assert.equal(check(input).checkedContextCount, 3);

  // Now the first context has [B, B, A], with the same total row count
  // and an identical before/after pair; only cross-context multiplicity differs.
  for (const snapshot of [input.cases[0].before, input.cases[0].after]) {
    snapshot.sideTables.mail_accounts[1] = structuredClone(bRow);
  }
  rejects(input);
});

test("2c/8 enforces exact and one-over node/UTF-16 budgets shared across contexts", () => {
  const factoryBudget = matrixFingerprintBudget();
  assert.deepEqual(factoryBudget, {
    remainingNodes: 1_000_000,
    remainingStringChars: 64_000_000,
  });

  // Calibrate a complete transition, not a partial row. The fixture has two
  // distinct actor/query contexts but the identical claimed persisted state.
  const [first, second] = fixture().cases;
  const fingerprint = matrixStoreTransitionFingerprint(
    first.before, first.after, factoryBudget);
  const perTransitionNodes = 1_000_000 - factoryBudget.remainingNodes;
  const perTransitionChars = 64_000_000 - factoryBudget.remainingStringChars;
  assert.ok(perTransitionNodes > 0);
  assert.ok(perTransitionChars > 0);

  for (const field of ["remainingNodes", "remainingStringChars"]) {
    const atLimit = {
      remainingNodes: 2 * perTransitionNodes,
      remainingStringChars: 2 * perTransitionChars,
    };
    assert.equal(matrixStoreTransitionFingerprint(first.before, first.after, atLimit), fingerprint);
    assert.equal(matrixStoreTransitionFingerprint(second.before, second.after, atLimit), fingerprint);
    assert.deepEqual(atLimit, { remainingNodes: 0, remainingStringChars: 0 });

    // One code unit or node short: first transition succeeds; the second
    // fails solely because it shares the remaining budget with the first.
    const oneOver = {
      remainingNodes: 2 * perTransitionNodes,
      remainingStringChars: 2 * perTransitionChars,
    };
    oneOver[field]--;
    assert.equal(matrixStoreTransitionFingerprint(first.before, first.after, oneOver), fingerprint);
    assert.throws(() => matrixStoreTransitionFingerprint(second.before, second.after, oneOver));
    assert.ok(oneOver[field] < 0);
  }
});

test("2c/8 fails closed on an over-depth cross-context fingerprint input", () => {
  const input = fixture();
  let nested = { flag: "safe" };
  for (let i = 0; i < 100; i++) nested = { child: nested };
  for (const side of ["before", "after"]) {
    input.cases[0][side].entities.find(row => row.id === "private-task").properties.deep = nested;
  }
  rejects(input);
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
  const hugeId = fixture();
  hugeId.legacySharedWorkspaceIds = ["x".repeat(257)];
  rejects(hugeId);
});
