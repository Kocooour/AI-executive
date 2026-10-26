// 2c, part 4: pure snapshot-only side-table preservation diagnostic.
// Never consume live SQLite, store raw records in results, write data or authorize
// a migration, recovery hold release, My Plan activation or sharing.
import { classifiedTables, storeTables } from "./backup-scope";
import {
  checkLegacyAssigneeStorePreservation,
  type LegacyAssigneeStoreSnapshot,
} from "./legacy-assignee-store-postcheck";

export type LegacyAssigneeSideTableSnapshot = LegacyAssigneeStoreSnapshot & Readonly<{
  // Every classified table other than canonical store tables and metadata must
  // be explicitly present; [] is the only representation of an empty table.
  sideTables: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
}>;

export type LegacyAssigneeSideTablePostcheckInput = Readonly<{
  before: LegacyAssigneeSideTableSnapshot;
  after: LegacyAssigneeSideTableSnapshot;
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneeSideTablePostcheck = Readonly<{
  phase: "legacy-assignee-side-table-postcheck-only";
  sourceRevision: number;
  resultRevision: number;
  restoreGeneration: number;
  checkedEntityCount: number;
  assignedTaskCount: number;
  checkedRelationCount: number;
  checkedTombstoneCount: number;
  comparedSideTableCount: number;
  comparedSideTableRowCount: number;
  // Metadata, completeness, transaction/ACL and derived views are NOT verified.
  verifiedPersistedState: false;
  verifiedMetadata: false;
  verifiedSideTables: false;
  verifiedHomeTodayInbox: false;
  canApply: false;
  canReleaseHold: false;
  canActivateMyPlan: false;
  canEnableSharing: false;
}>;

export class LegacyAssigneeSideTablePostcheckBlocked extends Error {
  constructor() {
    super("Legacy assignee side-table postcheck blocked");
    this.name = "LegacyAssigneeSideTablePostcheckBlocked";
  }
}
const blocked = (): never => { throw new LegacyAssigneeSideTablePostcheckBlocked(); };

// Rows can have composite keys and tables without a canonical ID, so equality
// must compare entire ROW MULTISETS (including duplicate multiplicity), not IDs,
// index positions or lossy JSON.stringify with caller-controlled object key order.
// Bound validation and serialization *while they happen*. A check after a
// recursive JSON walk or a completed JSON.stringify is too late to limit work.
const MAX_ROWS_PER_TABLE = 20_000;
const MAX_ROWS_PER_SNAPSHOT = 100_000;
const MAX_ROW_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 32_000_000;
const MAX_CONTAINER_MEMBERS = 20_000;
const MAX_NESTING_DEPTH = 64;

function canonicalJson(row: Readonly<Record<string, unknown>>, budget: { remaining: number }): string {
  const parts: string[] = [];
  const ancestors = new WeakSet<object>();
  let length = 0;
  const append = (part: string): void => {
    length += part.length;
    budget.remaining -= part.length;
    if (length > MAX_ROW_CHARS || budget.remaining < 0) blocked();
    parts.push(part);
  };
  const encode = (value: unknown, depth: number): void => {
    if (depth > MAX_NESTING_DEPTH) blocked();
    if (value === null) { append("null"); return; }
    if (typeof value === "string") {
      // A raw string larger than either remaining limit cannot fit once quoted.
      // Limit this BEFORE JSON.stringify allocates the escaped representation.
      if (value.length > MAX_ROW_CHARS - length || value.length > budget.remaining) blocked();
      append("s");
      append(JSON.stringify(value));
      return;
    }
    if (typeof value === "boolean") { append(value ? "true" : "false"); return; }
    if (typeof value === "number") {
      // SQLite INTEGER is 64-bit; a JS number outside the safe range may
      // already have lost precision. Require a lossless tagged representation.
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) blocked();
      append(Object.is(value, -0) ? "n-0" : "n" + JSON.stringify(value));
      return;
    }
    if (typeof value !== "object") blocked();
    const objectValue = value as object;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(objectValue);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) blocked();
    if (ancestors.has(objectValue)) blocked();
    ancestors.add(objectValue);
    try {
      if (array) {
        const items = value as unknown[];
        if (items.length > MAX_CONTAINER_MEMBERS ||
            Reflect.ownKeys(items).length !== items.length + 1) blocked();
        append("a[");
        for (let i = 0; i < items.length; i++) {
          const item = Object.getOwnPropertyDescriptor(items, String(i));
          if (!item || !item.enumerable || !("value" in item)) blocked();
          if (i) append(",");
          encode(item.value, depth + 1);
        }
        append("]");
      } else {
        const object = value as Record<string, unknown>;
        const keys = Reflect.ownKeys(object);
        if (keys.length > MAX_CONTAINER_MEMBERS || keys.some(key => typeof key !== "string")) blocked();
        const sorted = (keys as string[]).sort();
        append("o{");
        for (let i = 0; i < sorted.length; i++) {
          const key = sorted[i];
          const property = Object.getOwnPropertyDescriptor(object, key);
          if (!property || !property.enumerable || !("value" in property)) blocked();
          if (i) append(",");
          if (key.length > MAX_ROW_CHARS - length || key.length > budget.remaining) blocked();
          append(JSON.stringify(key));
          append(":");
          encode(property.value, depth + 1);
        }
        append("}");
      }
    } finally {
      ancestors.delete(objectValue);
    }
  };
  if (!row || typeof row !== "object" || Array.isArray(row)) blocked();
  encode(row, 0);
  return parts.join("");
}

function rowMultiset(rows: readonly Readonly<Record<string, unknown>>[], budget: { remaining: number }): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const row of rows) {
    const signature = canonicalJson(row, budget);
    frequencies.set(signature, (frequencies.get(signature) ?? 0) + 1);
  }
  return frequencies;
}

function equalMultisets(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [signature, count] of a) if (b.get(signature) !== count) return false;
  return true;
}

/**
 * Check that a caller-supplied 2c before/after pair preserves every classified
 * non-metadata side-table row as a complete multiset, alongside the entity,
 * relation and tombstone preservation proved only on the same supplied values.
 *
 * A caller may forge full, consistent snapshots. This neither authenticates
 * table completeness nor verifies the metadata table (the store revision
 * changes in a real backfill), current ACL, backup or actual read models.
 */
export function checkLegacyAssigneeSideTablePreservation(
  input: LegacyAssigneeSideTablePostcheckInput,
): LegacyAssigneeSideTablePostcheck {
  try {
    if (!input || !input.before || !input.after) blocked();
    const { before, after } = input;
    const expected = classifiedTables().filter(name =>
      name !== "metadata" && !(storeTables as readonly string[]).includes(name));
    if (new Set(expected).size !== expected.length || expected.length === 0) blocked();

    // Validate shallow shape and row counts *before* walking any row values.
    // Deep validation is performed by the bounded canonical encoder below.
    let comparedRows = 0;
    const budget = { remaining: MAX_TOTAL_CHARS };
    for (const snapshot of [before, after]) {
      const tables = snapshot.sideTables;
      if (!tables || typeof tables !== "object" || Array.isArray(tables) ||
          (Object.getPrototypeOf(tables) !== Object.prototype && Object.getPrototypeOf(tables) !== null)) blocked();
      const keys = Reflect.ownKeys(tables);
      if (keys.length !== expected.length ||
          keys.some(key => typeof key !== "string") ||
          expected.some(name => !Object.prototype.hasOwnProperty.call(tables, name))) blocked();
      let rows = 0;
      for (const name of expected) {
        const property = Object.getOwnPropertyDescriptor(tables, name);
        if (!property || !property.enumerable || !("value" in property)) blocked();
        const table = property.value;
        if (!Array.isArray(table) || Object.getPrototypeOf(table) !== Array.prototype ||
            table.length > MAX_ROWS_PER_TABLE) blocked();
        rows += table.length;
        if (rows > MAX_ROWS_PER_SNAPSHOT || Reflect.ownKeys(table).length !== table.length + 1) blocked();
        for (let i = 0; i < table.length; i++) {
          const item = Object.getOwnPropertyDescriptor(table, String(i));
          if (!item || !item.enumerable || !("value" in item)) blocked();
        }
      }
    }

    // Reuse complete canonical checks first; this never replaces entity,
    // relation, tombstone, assignee, revision or generation validation.
    const canonical = checkLegacyAssigneeStorePreservation({
      before, after, legacySharedWorkspaceIds: input.legacySharedWorkspaceIds,
    });
    for (const name of expected) {
      const left = before.sideTables[name];
      const right = after.sideTables[name];
      if (left.length !== right.length ||
          !equalMultisets(rowMultiset(left, budget), rowMultiset(right, budget))) blocked();
      comparedRows += left.length;
    }

    return Object.freeze({
      phase: "legacy-assignee-side-table-postcheck-only",
      sourceRevision: canonical.sourceRevision,
      resultRevision: canonical.resultRevision,
      restoreGeneration: canonical.restoreGeneration,
      checkedEntityCount: canonical.checkedEntityCount,
      assignedTaskCount: canonical.assignedTaskCount,
      checkedRelationCount: canonical.checkedRelationCount,
      checkedTombstoneCount: canonical.checkedTombstoneCount,
      comparedSideTableCount: expected.length,
      comparedSideTableRowCount: comparedRows,
      verifiedPersistedState: false,
      verifiedMetadata: false,
      verifiedSideTables: false,
      verifiedHomeTodayInbox: false,
      canApply: false,
      canReleaseHold: false,
      canActivateMyPlan: false,
      canEnableSharing: false,
    });
  } catch {
    blocked();
  }
}
