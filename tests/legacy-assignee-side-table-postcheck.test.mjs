import assert from "node:assert/strict";
import test from "node:test";
import { classifiedTables, storeTables } from "../lib/backup-scope.ts";
import {
  checkLegacyAssigneeSideTablePreservation,
  LegacyAssigneeSideTablePostcheckBlocked,
} from "../lib/legacy-assignee-side-table-postcheck.ts";

const tableNames = classifiedTables().filter(name =>
  name !== "metadata" && !storeTables.includes(name));
const tables = () => Object.fromEntries(tableNames.map(name => [name, []]));

const workspace = (id, kind = "shared") => ({
  id: "workspace:" + id, type: "workspace", title: "SECRET-" + id,
  status: "active", workspaceId: id,
  properties: { kind, role: "owner", members: [{ id: "owner", role: "owner" }] },
  createdAt: 1, updatedAt: 2,
});
const task = (id, workspaceId, properties = {}) => ({
  id, type: "task", workspaceId, title: "SECRET-" + id,
  status: "open", properties, createdAt: 1, updatedAt: 2,
});
const before = () => ({
  revision: 15, restoreGeneration: 7,
  entities: [
    workspace("legacy"),
    workspace("personal", "personal"),
    task("legacy-task", "legacy", { inbox: true, today: true }),
    task("private-task", "personal"),
  ],
  relations: [],
  tombstones: [{ id: "deleted-task", deletedAt: 10 }],
  sideTables: tables(),
});
const after = (source = before()) => {
  const current = structuredClone(source);
  current.revision += 1;
  current.entities.find(e => e.id === "legacy-task").properties.assigneeUserId = "owner";
  current.entities.find(e => e.id === "legacy-task").updatedAt += 1;
  return current;
};
const audit = (old = before(), current = after(old)) =>
  checkLegacyAssigneeSideTablePreservation({
    before: old, after: current, legacySharedWorkspaceIds: ["legacy"],
  });
const rejected = (old, current) =>
  assert.throws(() => audit(old, current), LegacyAssigneeSideTablePostcheckBlocked);

test("2c/4 preserves every classified non-metadata table, with immutable aggregate-only output", () => {
  const old = before();
  old.sideTables.context_claims.push({ id: "SECRET-claim", status: "active", revision: 3 });
  old.sideTables.notification_deliveries.push({ delivery_key: "SECRET-key", attempts: 2 });
  old.sideTables.calendar_events.push({ occurrence_key: "SECRET-event", payload: { a: [1, null] } });
  old.sideTables.passkey_credentials.push({ id: "SECRET-credential", blob: "private" });
  const current = after(old);
  const savedOld = structuredClone(old), savedCurrent = structuredClone(current);
  const result = audit(old, current);
  assert.deepEqual(result, {
    phase: "legacy-assignee-side-table-postcheck-only",
    sourceRevision: 15, resultRevision: 16, restoreGeneration: 7,
    checkedEntityCount: 4, assignedTaskCount: 1,
    checkedRelationCount: 0, checkedTombstoneCount: 1,
    comparedSideTableCount: tableNames.length, comparedSideTableRowCount: 4,
    verifiedPersistedState: false, verifiedMetadata: false,
    verifiedSideTables: false, verifiedHomeTodayInbox: false,
    canApply: false, canReleaseHold: false,
    canActivateMyPlan: false, canEnableSharing: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(old, savedOld);
  assert.deepEqual(current, savedCurrent);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|legacy-task|private-task|passkey|claims|payload|delivery/);
});

test("2c/4 compares side-table row MULTISETS, not indexes or column order", () => {
  const old = before();
  old.sideTables.context_claims.push(
    { id: "a", columns: { x: [1, 2], y: "z" }, n: 0 },
    { id: "b", columns: { z: null } },
  );
  const current = after(old);
  current.sideTables.context_claims.reverse();
  current.sideTables.context_claims[0] = { columns: { z: null }, id: "b" };
  current.sideTables.context_claims[1] = { n: 0, columns: { y: "z", x: [1, 2] }, id: "a" };
  assert.equal(audit(old, current).comparedSideTableRowCount, 2);
  current.sideTables.context_claims[1].columns.x.reverse();
  rejected(old, current);
});

test("2c/4 preserves duplicate row multiplicity even without canonical row IDs", () => {
  const old = before();
  old.sideTables.attention_history.push({ k: "a" }, { k: "a" }, { k: "b" });
  const current = after(old);
  current.sideTables.attention_history[1].k = "b";
  rejected(old, current);
  const extra = after(old);
  extra.sideTables.attention_history.push({ k: "a" });
  rejected(old, extra);
  const removed = after(old);
  removed.sideTables.attention_history.pop();
  rejected(old, removed);
});

test("2c/4 blocks omissions and unknown table keys on either snapshot, including metadata", () => {
  for (const name of ["context_claims", "notification_deliveries", "calendar_events", "passkey_credentials"]) {
    const old = before(), current = after(old);
    delete old.sideTables[name];
    rejected(old, current);
    const old2 = before(), current2 = after(old2);
    delete current2.sideTables[name];
    rejected(old2, current2);
  }
  for (const name of ["metadata", "unclassified_schema_table", "entities", "__unexpected"]) {
    const old = before(), current = after(old);
    current.sideTables[name] = [];
    rejected(old, current);
  }
  const old = before(), current = after(old);
  current.sideTables = {};
  rejected(old, current);
  const noTableObject = after(old);
  delete noTableObject.sideTables;
  rejected(old, noTableObject);
});

test("2c/4 blocks changes in sensitive and excluded-cleared side tables", () => {
  const samples = [
    ["mail_accounts", { account_id: "SECRET-a", encrypted_token: "old" }, row => { row.encrypted_token = "changed"; }],
    ["passkey_credentials", { credential_id: "SECRET-c", private_value: "old" }, row => { row.private_value = "changed"; }],
    ["attention_states", { workspace_id: "legacy", snooze_until: 42 }, row => { row.snooze_until = 43; }],
    ["calendar_events", { id: "cached", start_at: 100 }, row => { row.start_at = 200; }],
    ["notification_deliveries", { delivery_key: "SECRET-k", attempts: 1 }, row => { row.attempts = 2; }],
    ["context_change_events", { id: "event", payload: "{\"source\":1}" }, row => { row.payload = "{\"source\":2}"; }],
  ];
  for (const [name, row, mutate] of samples) {
    const old = before();
    old.sideTables[name].push(row);
    const current = after(old);
    mutate(current.sideTables[name][0]);
    rejected(old, current);
  }
});

test("2c/4 rejects malformed JSON rows, accessors, cycles and sparse arrays", () => {
  const mutations = [
    row => { row.value = undefined; },
    row => { row.value = new Date("2026-10-26"); },
    row => { row.value = NaN; },
    row => { row.value = Infinity; },
    row => { row.value = BigInt(7); },
    row => { row.value = Symbol("secret"); },
    row => { row.value = new Array(1); },
    row => { row.value = new Map(); },
    row => { row.value = {}; row.value.self = row.value; },
    row => { Object.defineProperty(row, "invisible", { value: 1 }); },
    row => { Object.defineProperty(row, "accessor", { enumerable: true, get() { return 1; } }); },
  ];
  for (const mutate of mutations) {
    const old = before(), current = after(old);
    current.sideTables.context_claims.push({ id: "x" });
    mutate(current.sideTables.context_claims[0]);
    rejected(old, current);
  }
  const old = before(), current = after(old);
  current.sideTables.context_claims = [null];
  rejected(old, current);
  const sparse = after(old);
  sparse.sideTables.context_claims = new Array(1);
  rejected(old, sparse);
});

test("2c/4 refuses noncanonical inherited entity/tombstone state and revisions", () => {
  const old = before();
  const current = after(old);
  current.entities.find(e => e.id === "private-task").title = "changed";
  rejected(old, current);

  const wrong = after(old);
  wrong.tombstones[0].deletedAt++;
  rejected(old, wrong);
  const wrongRevision = after(old);
  wrongRevision.revision++;
  rejected(old, wrongRevision);
  const wrongGeneration = after(old);
  wrongGeneration.restoreGeneration++;
  rejected(old, wrongGeneration);
});

test("2c/4 requires an unchanged revision for a legitimate no-op", () => {
  const old = after(before()), current = structuredClone(old);
  const report = audit(old, current);
  assert.equal(report.assignedTaskCount, 0);
  assert.equal(report.sourceRevision, report.resultRevision);
  current.revision += 1;
  rejected(old, current);
});

test("2c/4 checks table row-count and accessor shape before deep traversal", () => {
  const old = before(), current = after(old);
  current.sideTables.context_claims = Array.from({ length: 20_001 }, () => ({}));
  rejected(old, current);

  const injected = after(old);
  Object.defineProperty(injected.sideTables, "context_claims", {
    enumerable: true, get() { throw new Error("must not invoke accessor"); },
  });
  rejected(old, injected);

  const sparseTable = after(old);
  sparseTable.sideTables.context_claims = new Array(1);
  rejected(old, sparseTable);
});

test("2c/4 enforces row size and nesting limits during encoding", () => {
  const old = before(), current = after(old);
  current.sideTables.context_claims.push({ oversized: "x".repeat(1_000_001) });
  rejected(old, current);

  const nested = after(old);
  let root = {};
  let pointer = root;
  for (let i = 0; i < 70; i++) {
    pointer.child = {};
    pointer = pointer.child;
  }
  nested.sideTables.context_claims.push(root);
  rejected(old, nested);

  const budgetBefore = before();
  const payload = "x".repeat(900_000);
  for (let i = 0; i < 20; i++) {
    budgetBefore.sideTables.attention_history.push({ id: i, payload });
  }
  // Each side is below 32M by itself, but the combined signature budget is not.
  rejected(budgetBefore, after(budgetBefore));
});

test("2c/4 rejects unsafe integer numbers and compares lossless tagged SQLite INTEGERs", () => {
  const old = before();
  old.sideTables.context_claims.push({ maxSafe: Number.MAX_SAFE_INTEGER });
  assert.equal(audit(old, after(old)).comparedSideTableRowCount, 1);

  for (const unsafe of [Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1)]) {
    const beforeUnsafe = before();
    beforeUnsafe.sideTables.context_claims.push({ integer: unsafe });
    rejected(beforeUnsafe, after(beforeUnsafe));
    const validBefore = before(), invalidAfter = after(validBefore);
    invalidAfter.sideTables.context_claims.push({ integer: unsafe });
    rejected(validBefore, invalidAfter);
  }

  const exact = before();
  exact.sideTables.context_claims.push({
    integer: { $sqliteInteger: "9007199254740992" },
  });
  const unchanged = after(exact);
  assert.equal(audit(exact, unchanged).comparedSideTableRowCount, 1);
  unchanged.sideTables.context_claims[0].integer.$sqliteInteger = "9007199254740993";
  rejected(exact, unchanged);
});
