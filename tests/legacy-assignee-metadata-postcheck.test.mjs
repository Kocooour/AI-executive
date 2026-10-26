import assert from "node:assert/strict";
import test from "node:test";
import { classifiedTables, storeTables } from "../lib/backup-scope.ts";
import {
  checkLegacyAssigneeMetadataPreservation,
  LegacyAssigneeMetadataPostcheckBlocked,
} from "../lib/legacy-assignee-metadata-postcheck.ts";

const sideNames = classifiedTables().filter(name => name !== "metadata" && !storeTables.includes(name));
const sideTables = () => Object.fromEntries(sideNames.map(name => [name, []]));
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
const initial = () => ({
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
    { key: "vapidKeys", value: "SECRET-private-push-credential" },
    { key: "future-security-policy", value: "{\"name\":\"SECRET-private-value\"}" },
  ],
});
const set = (rows, key, value) => {
  const row = rows.find(row => row.key === key);
  assert.ok(row, key);
  row.value = value;
};
const next = (old = initial()) => {
  const result = structuredClone(old);
  result.revision++;
  set(result.metadata, "revision", String(result.revision));
  set(result.metadata, "updatedAt", "101");
  const legacy = result.entities.find(entity => entity.id === "legacy-task");
  legacy.properties.assigneeUserId = "owner";
  legacy.updatedAt++;
  return result;
};
const check = (before = initial(), after = next(before)) =>
  checkLegacyAssigneeMetadataPreservation({
    before, after, legacySharedWorkspaceIds: ["legacy"],
  });
const rejects = (before, after) =>
  assert.throws(() => check(before, after), LegacyAssigneeMetadataPostcheckBlocked);

test("2c/5 accepts only revisions and updatedAt drift, reports no sensitive values or authorization", () => {
  const before = initial(), after = next(before);
  before.sideTables.attention_history.push({ private: "SECRET-history" });
  after.sideTables.attention_history.push({ private: "SECRET-history" });
  after.metadata.reverse();
  const previous = structuredClone(before), resultSnapshot = structuredClone(after);
  const result = check(before, after);
  assert.deepEqual(result, {
    phase: "legacy-assignee-metadata-postcheck-only",
    sourceRevision: 15, resultRevision: 16, restoreGeneration: 7,
    checkedEntityCount: 4, assignedTaskCount: 1, checkedRelationCount: 0,
    checkedTombstoneCount: 1, comparedSideTableCount: sideNames.length,
    comparedSideTableRowCount: 1, comparedMetadataKeyCount: 5,
    verifiedPersistedState: false, verifiedMetadata: false,
    verifiedSideTables: false, verifiedHomeTodayInbox: false,
    canApply: false, canReleaseHold: false, canActivateMyPlan: false,
    canEnableSharing: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(before, previous);
  assert.deepEqual(after, resultSnapshot);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|vapidKeys|legacy-task|attention_history|future-security-policy/);
});

test("2c/5 accepts no-op only with unchanged revision and updatedAt", () => {
  const before = next(initial()), after = structuredClone(before);
  assert.equal(check(before, after).assignedTaskCount, 0);
  set(after.metadata, "updatedAt", "102");
  rejects(before, after);
  const badRevision = structuredClone(before);
  set(badRevision.metadata, "revision", "17");
  rejects(before, badRevision);
});

test("2c/5 preserves exact metadata row set and confidential values", () => {
  const before = initial();
  const rewrite = next(before);
  set(rewrite.metadata, "vapidKeys", "SECRET-altered-key");
  rejects(before, rewrite);

  const futureRewrite = next(before);
  set(futureRewrite.metadata, "future-security-policy", "{\"name\":\"different\"}");
  rejects(before, futureRewrite);

  const added = next(before);
  added.metadata.push({ key: "unexpected", value: "secret" });
  rejects(before, added);

  const removed = next(before);
  removed.metadata = removed.metadata.filter(row => row.key !== "vapidKeys");
  rejects(before, removed);

  const duplicate = next(before);
  duplicate.metadata.push({ key: "vapidKeys", value: "SECRET-private-push-credential" });
  rejects(before, duplicate);

  const removedOld = initial(), current = next(removedOld);
  removedOld.metadata.pop();
  rejects(removedOld, current);
});

test("2c/5 verifies exact canonical decimal revision and monotone updatedAt", () => {
  const before = initial();
  const valid = next(before);
  assert.equal(check(before, valid).sourceRevision, 15);
  assert.equal(check(before, valid).resultRevision, 16);
  for (const revision of ["14", "15", "17", "015", "1e1", "-1", "", "9007199254740993"]) {
    const mutated = next(before);
    set(mutated.metadata, "revision", revision);
    rejects(before, mutated);
  }
  for (const stamp of ["99", "-1", "0101", "1e2", "9007199254740993"]) {
    const mutated = next(before);
    set(mutated.metadata, "updatedAt", stamp);
    rejects(before, mutated);
  }
  const oldRevision = initial();
  set(oldRevision.metadata, "revision", "0");
  rejects(oldRevision, next(initial()));
  const missingBefore = initial();
  missingBefore.metadata = missingBefore.metadata.filter(row => row.key !== "updatedAt");
  rejects(missingBefore, next(initial()));
});

test("2c/5 enforces restoreGeneration presence and unchanged value", () => {
  const before = initial();
  const tampered = next(before);
  set(tampered.metadata, "restoreGeneration", "8");
  rejects(before, tampered);
  const missing = next(before);
  missing.metadata = missing.metadata.filter(row => row.key !== "restoreGeneration");
  rejects(before, missing);

  const without = initial();
  without.restoreGeneration = 0;
  without.metadata = without.metadata.filter(row => row.key !== "restoreGeneration");
  const after = next(without);
  assert.equal(check(without, after).restoreGeneration, 0);
  const unexpected = next(without);
  unexpected.metadata.push({ key: "restoreGeneration", value: "0" });
  rejects(without, unexpected);
  const falselyMissing = initial();
  falselyMissing.metadata = falselyMissing.metadata.filter(row => row.key !== "restoreGeneration");
  rejects(falselyMissing, next(falselyMissing));
});

test("2c/5 rejects malformed metadata rows, accessors, hidden keys and sparse arrays", () => {
  const badRow = (mutate) => {
    const before = initial(), after = next(before);
    mutate(after.metadata[3]);
    rejects(before, after);
  };
  for (const mutate of [
    row => { row.extra = "x"; },
    row => { row.value = null; },
    row => { row.value = 10; },
    row => { row.key = ""; },
    row => { Object.defineProperty(row, "hidden", { value: "x" }); },
    row => { Object.defineProperty(row, Symbol("hidden"), { value: "x" }); },
    row => { Object.defineProperty(row, "value", { enumerable: true, get() { throw Error("NO ACCESS"); } }); },
  ]) badRow(mutate);

  const before = initial();
  const current = next(before);
  current.metadata[0] = null;
  rejects(before, current);
  const sparse = next(before);
  sparse.metadata = new Array(5);
  rejects(before, sparse);
  const extra = next(before);
  extra.metadata.extra = "hidden";
  rejects(before, extra);
  const accessor = next(before);
  Object.defineProperty(accessor.metadata, "0", { enumerable: true, get() { throw Error("NO ACCESS"); } });
  rejects(before, accessor);
});

test("2c/5 rejects over-budget rows, values and metadata snapshots", () => {
  const before = initial(), after = next(before);
  after.metadata[3].value = "x".repeat(1_000_001);
  rejects(before, after);

  const largeKey = next(before);
  largeKey.metadata[3].key = "a".repeat(257);
  rejects(before, largeKey);

  const tooMany = next(before);
  tooMany.metadata = Array.from({ length: 4_097 }, (_, i) => ({ key: "key-" + i, value: "" }));
  rejects(before, tooMany);

  const budgetBefore = initial(), budgetAfter = next(budgetBefore);
  for (let i = 0; i < 3; i++) {
    budgetBefore.metadata.push({ key: "extra-" + i, value: "x".repeat(900_000) });
    budgetAfter.metadata.push({ key: "extra-" + i, value: "x".repeat(900_000) });
  }
  rejects(budgetBefore, budgetAfter);
});

test("2c/5 rejects metadata proxies before invoking traps", () => {
  let trapCalls = 0;
  const wrap = object => new Proxy(object, {
    get(target, key, receiver) { trapCalls++; return Reflect.get(target, key, receiver); },
    getPrototypeOf(target) { trapCalls++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { trapCalls++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      trapCalls++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  for (const side of ["before", "after"]) {
    for (const change of [
      snapshot => { snapshot.metadata = wrap(snapshot.metadata); },
      snapshot => { snapshot.metadata[0] = wrap(snapshot.metadata[0]); },
    ]) {
      const old = initial(), current = next(old);
      change(side === "before" ? old : current);
      rejects(old, current);
      assert.equal(trapCalls, 0, "metadata proxy trap must not run");
    }
  }
});

test("2c/5 inherits canonical and side-table fail-closed checks", () => {
  const before = initial();
  before.sideTables.mail_accounts.push({ credential: "SECRET" });
  const changedTable = next(before);
  changedTable.sideTables.mail_accounts[0].credential = "CHANGED";
  rejects(before, changedTable);
  const changedEntity = next(before);
  changedEntity.entities.find(entity => entity.id === "private-task").title = "CHANGED";
  rejects(before, changedEntity);
  const changedTombstone = next(before);
  changedTombstone.tombstones[0].deletedAt++;
  rejects(before, changedTombstone);
});
