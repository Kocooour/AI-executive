import assert from "node:assert/strict";
import test from "node:test";
import { classifiedTables, storeTables } from "../lib/backup-scope.ts";
import {
  checkLegacyAssigneeReadModelPreservation,
  LegacyAssigneeReadModelPostcheckBlocked,
} from "../lib/legacy-assignee-read-model-postcheck.ts";

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
const readModels = () => ({
  context: {
    actorUserId: "owner", asOf: "2026-10-26T11:00:00.000Z",
    timezone: "Europe/Prague", queryFingerprint: "synthetic-fixture-v1",
  },
  home: {
    cards: [{ id: "PRIVATE-home-card", title: "SECRET-home" }],
    summary: { open: 2, view: "home" },
  },
  today: [
    { id: "PRIVATE-today-1", order: 1, text: "SECRET-today" },
    { id: "PRIVATE-today-2", order: 2, text: "SECOND" },
  ],
  inbox: { items: [{ id: "PRIVATE-inbox", label: "SECRET-inbox" }], total: 1 },
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
    { key: "vapidKeys", value: "SECRET-private-credential" },
    { key: "future-security-policy", value: "{\"private\":true}" },
  ],
  readModels: readModels(),
});
const setMetadata = (rows, key, value) => {
  const row = rows.find(row => row.key === key);
  assert.ok(row);
  row.value = value;
};
const next = (old = initial()) => {
  const result = structuredClone(old);
  result.revision++;
  setMetadata(result.metadata, "revision", String(result.revision));
  setMetadata(result.metadata, "updatedAt", "101");
  const legacy = result.entities.find(entity => entity.id === "legacy-task");
  legacy.properties.assigneeUserId = "owner";
  legacy.updatedAt++;
  return result;
};
const check = (before, after) => checkLegacyAssigneeReadModelPreservation({
  before, after, legacySharedWorkspaceIds: ["legacy"],
});
const rejects = (before, after) =>
  assert.throws(() => check(before, after), LegacyAssigneeReadModelPostcheckBlocked);

test("2c/6 accepts identical opaque views in a valid migration, without leaking data or authorizing writes", () => {
  const before = initial(), after = next(before);
  before.sideTables.attention_history.push({ detail: "SECRET-attention" });
  after.sideTables.attention_history.push({ detail: "SECRET-attention" });
  after.metadata.reverse();
  // Nested object property order is immaterial, but array order is meaningful.
  after.readModels.home = {
    summary: { view: "home", open: 2 },
    cards: [{ title: "SECRET-home", id: "PRIVATE-home-card" }],
  };
  const original = structuredClone(before), updated = structuredClone(after);
  const result = check(before, after);
  assert.deepEqual(result, {
    phase: "legacy-assignee-read-model-postcheck-only",
    sourceRevision: 15, resultRevision: 16, restoreGeneration: 7,
    checkedEntityCount: 4, assignedTaskCount: 1, checkedRelationCount: 0,
    checkedTombstoneCount: 1, comparedSideTableCount: sideNames.length,
    comparedSideTableRowCount: 1, comparedMetadataKeyCount: 5,
    comparedReadModelCount: 3,
    verifiedPersistedState: false, verifiedMetadata: false,
    verifiedSideTables: false, verifiedHomeTodayInbox: false,
    canApply: false, canReleaseHold: false, canActivateMyPlan: false,
    canEnableSharing: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(before, original);
  assert.deepEqual(after, updated);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE-|vapidKeys|queryFingerprint/);
});

test("2c/6 accepts no-op if Home Today Inbox and metadata remain identical", () => {
  const before = next(initial());
  const after = structuredClone(before);
  const result = check(before, after);
  assert.equal(result.assignedTaskCount, 0);
  assert.equal(result.sourceRevision, result.resultRevision);
});

test("2c/6 blocks content changes in each named view", () => {
  const before = initial();
  const mutate = {
    home: view => { view.cards[0].title = "changed"; },
    today: view => { view[0].text = "changed"; },
    inbox: view => { view.total = 2; },
  };
  for (const [name, edit] of Object.entries(mutate)) {
    const after = next(before);
    edit(after.readModels[name]);
    rejects(before, after);
  }
  const differentOrder = next(before);
  differentOrder.readModels.today.reverse();
  rejects(before, differentOrder);
  const removedRow = next(before);
  removedRow.readModels.today.pop();
  rejects(before, removedRow);
});

test("2c/6 blocks drift in actor, date/time, timezone or read-query fingerprint", () => {
  const before = initial();
  for (const [field, value] of [
    ["actorUserId", "another"], ["asOf", "2026-10-27T11:00:00.000Z"],
    ["timezone", "UTC"], ["queryFingerprint", "different-sort"],
  ]) {
    const after = next(before);
    after.readModels.context[field] = value;
    rejects(before, after);
  }
  const missing = next(before);
  delete missing.readModels.context.queryFingerprint;
  rejects(before, missing);
  const empty = next(before);
  empty.readModels.context.actorUserId = " ";
  rejects(before, empty);
});

test("2c/6 requires all views, exact plain envelope and non-null composite view roots", () => {
  const before = initial();
  for (const name of ["home", "today", "inbox", "context"]) {
    const after = next(before);
    delete after.readModels[name];
    rejects(before, after);
  }
  const extra = next(before);
  extra.readModels.extra = [];
  rejects(before, extra);
  const primitive = next(before);
  primitive.readModels.inbox = "forged";
  rejects(before, primitive);
  const missingBefore = initial();
  delete missingBefore.readModels.today;
  rejects(missingBefore, next(initial()));
  const accessor = next(before);
  Object.defineProperty(accessor.readModels, "home", {
    enumerable: true, get() { throw Error("SHOULD NOT SURFACE"); },
  });
  rejects(before, accessor);
  const hidden = next(before);
  Object.defineProperty(hidden.readModels.context, "hidden", { value: "SECRET" });
  rejects(before, hidden);
});

test("2c/6 rejects getters, symbols, array holes, exotic instances and non-JSON values", () => {
  const before = initial();
  const tests = [
    after => { after.readModels.today[0].text = undefined; },
    after => { after.readModels.today[0].order = NaN; },
    after => { after.readModels.today[0].order = Infinity; },
    after => { after.readModels.today[0].order = 9_007_199_254_740_992; },
    after => { after.readModels.today[0].order = 10n; },
    after => { after.readModels.today[0].extra = Symbol("x"); },
    after => { after.readModels.home.cards[0].date = new Date(); },
    after => { after.readModels.home.cards[0].date = new Map(); },
    after => { after.readModels.inbox.items[0].self = after.readModels.inbox.items[0]; },
    after => { after.readModels.today = new Array(2); },
    after => { after.readModels.today.extra = true; },
    after => { Object.defineProperty(after.readModels.home.summary, "open", {
      enumerable: true, get() { throw Error("SHOULD NOT SURFACE"); },
    }); },
    after => { Object.defineProperty(after.readModels.home.summary, Symbol("private"), {
      value: "SECRET",
    }); },
  ];
  for (const mutation of tests) {
    const after = next(before);
    mutation(after);
    rejects(before, after);
  }
});

test("2c/6 bounds string size, recursive nesting and total serialized view volume", () => {
  const before = initial();
  const tooLong = next(before);
  tooLong.readModels.home.cards[0].title = "x".repeat(500_001);
  rejects(before, tooLong);

  const tooDeep = next(before);
  let node = tooDeep.readModels.home;
  for (let i = 0; i < 60; i++) {
    node.next = {};
    node = node.next;
  }
  rejects(before, tooDeep);

  // Each individual view is under 2m characters; all six exceed 8m.
  const big = initial();
  for (const viewName of ["home", "today", "inbox"]) {
    big.readModels[viewName] = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => ["field" + i, "x".repeat(300_000)]),
    );
  }
  rejects(big, next(big));
});

test("2c/6 inherits fail-closed metadata, side-table and canonical invariants", () => {
  const before = initial();
  const badMetadata = next(before);
  setMetadata(badMetadata.metadata, "vapidKeys", "SECRET-changed");
  rejects(before, badMetadata);
  const badSideTable = next(before);
  badSideTable.sideTables.mail_accounts.push({ token: "PRIVATE" });
  rejects(before, badSideTable);
  const badCanonical = next(before);
  badCanonical.entities.find(entity => entity.id === "private-task").title = "changed";
  rejects(before, badCanonical);
  const badTimestamp = next(before);
  setMetadata(badTimestamp.metadata, "updatedAt", "99");
  rejects(before, badTimestamp);
});
