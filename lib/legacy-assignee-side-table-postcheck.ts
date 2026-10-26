// 2c, part 4: pure snapshot-only side-table preservation diagnostic.
// Never consume live SQLite, store raw records in results, write data or authorize
// a migration, recovery hold release, My Plan activation or sharing.
import { classifiedTables, storeTables } from "./backup-scope";
import { isJsonData } from "./legacy-assignee-json";
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
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "s" + JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "n-0" : "n" + JSON.stringify(value);
  if (Array.isArray(value)) return "a[" + value.map(canonicalJson).join(",") + "]";
  const row = value as Record<string, unknown>;
  return "o{" + Object.keys(row).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJson(row[key])).join(",") + "}";
}

function rowMultiset(rows: readonly Readonly<Record<string, unknown>>[], byteBudget: { remaining: number }): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) blocked();
    const signature = canonicalJson(row);
    // Keep caller-controlled snapshots bounded even when few rows are huge.
    byteBudget.remaining -= signature.length;
    if (signature.length > 1_000_000 || byteBudget.remaining < 0) blocked();
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

    // This rejects unknown or omitted table names, getters, symbols, missing
    // arrays, sparse arrays, cycles and all exotic/non-JSON values, on both sides.
    let comparedRows = 0;
    const budget = { remaining: 32_000_000 };
    for (const snapshot of [before, after]) {
      const tables = snapshot.sideTables;
      if (!tables || typeof tables !== "object" || Array.isArray(tables) ||
          !isJsonData(tables) ||
          Reflect.ownKeys(tables).length !== expected.length ||
          expected.some(name => !Object.prototype.hasOwnProperty.call(tables, name))) blocked();
      let rows = 0;
      for (const name of expected) {
        const table = tables[name];
        if (!Array.isArray(table) || table.length > 20_000) blocked();
        rows += table.length;
        if (rows > 100_000) blocked();
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
