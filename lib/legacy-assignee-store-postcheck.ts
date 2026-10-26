// 2c, part 3: pure, read-only canonical store preservation diagnostic.
// Never authorize a migration, a write, a hold release, My Plan or sharing.
import type { Relation } from "./db";
import { equalJsonData, isJsonData } from "./legacy-assignee-json";
import {
  checkLegacyOwnerAssigneeBackfill,
} from "./legacy-assignee-postcheck";
import type { LegacyAssigneeSource } from "./legacy-assignee-preflight";
import { validateSnapshotStructure } from "./snapshot-validation";

export type LegacyAssigneeStoreSnapshot = LegacyAssigneeSource & Readonly<{
  relations: readonly Relation[];
  tombstones: readonly { id: string; deletedAt: number }[];
}>;

export type LegacyAssigneeStorePostcheckInput = Readonly<{
  before: LegacyAssigneeStoreSnapshot;
  after: LegacyAssigneeStoreSnapshot;
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneeStorePostcheck = Readonly<{
  phase: "legacy-assignee-store-postcheck-only";
  sourceRevision: number;
  resultRevision: number;
  restoreGeneration: number;
  checkedEntityCount: number;
  assignedTaskCount: number;
  checkedRelationCount: number;
  checkedTombstoneCount: number;
  verifiedPersistedState: false;
  verifiedSideTables: false;
  verifiedHomeTodayInbox: false;
  canApply: false;
  canReleaseHold: false;
  canActivateMyPlan: false;
  canEnableSharing: false;
}>;

export class LegacyAssigneeStorePostcheckBlocked extends Error {
  constructor() {
    super("Legacy assignee store postcheck blocked");
    this.name = "LegacyAssigneeStorePostcheckBlocked";
  }
}

const blocked = (): never => { throw new LegacyAssigneeStorePostcheckBlocked(); };

// Relation and tombstone arrays have no meaningful enumeration order. We check
// canonical identity and *every* field, including timestamps, in both snapshots.
function unchangedRows<T extends { id: string }>(before: readonly T[], after: readonly T[]): boolean {
  if (before.length !== after.length) return false;
  const byId = new Map(after.map(row => [row.id, row]));
  if (byId.size !== after.length) return false;
  for (const row of before) {
    const counterpart = byId.get(row.id);
    if (!counterpart || !equalJsonData(row, counterpart)) return false;
  }
  return true;
}

/**
 * Diagnose a hypothetical assignee backfill and verify its complete canonical
 * entities/relations/tombstones arrays are preserved, except for precisely the
 * task-assignee changes allowed by the entity postcheck.
 *
 * Both input graphs, their claimed completeness, actor/member provenance and
 * all revisions are untrusted; side tables and derived UI are NOT inspected.
 * A successful result is never approval to change database state.
 */
export function checkLegacyAssigneeStorePreservation(
  input: LegacyAssigneeStorePostcheckInput,
): LegacyAssigneeStorePostcheck {
  try {
    if (!input || !input.before || !input.after) blocked();
    const { before, after, legacySharedWorkspaceIds } = input;

    // Required complete canonical collections, not optional arrays that could
    // accidentally be interpreted as empty and thus certified as unchanged.
    if (!Array.isArray(before.entities) || !Array.isArray(after.entities) ||
        !Array.isArray(before.relations) || !Array.isArray(after.relations) ||
        !Array.isArray(before.tombstones) || !Array.isArray(after.tombstones) ||
        before.entities.length > 20_000 || after.entities.length > 20_000 ||
        before.relations.length > 50_000 || after.relations.length > 50_000 ||
        before.tombstones.length > 50_000 || after.tombstones.length > 50_000 ||
        !isJsonData(before.entities) || !isJsonData(after.entities) ||
        !isJsonData(before.relations) || !isJsonData(after.relations) ||
        !isJsonData(before.tombstones) || !isJsonData(after.tombstones)) blocked();

    // Check relation endpoints, common entity/relation ID namespace, workspace
    // alignment, tombstone/live overlap and duplicate canonical IDs on EACH
    // side. This validation is storage-free and cannot attest the source.
    validateSnapshotStructure({
      entities: [...before.entities], relations: [...before.relations],
      tombstones: [...before.tombstones],
    });
    validateSnapshotStructure({
      entities: [...after.entities], relations: [...after.relations],
      tombstones: [...after.tombstones],
    });

    const entityReport = checkLegacyOwnerAssigneeBackfill({
      before, after, legacySharedWorkspaceIds,
    });
    if (!unchangedRows(before.relations, after.relations) ||
        !unchangedRows(before.tombstones, after.tombstones)) blocked();

    return Object.freeze({
      phase: "legacy-assignee-store-postcheck-only",
      sourceRevision: entityReport.sourceRevision,
      resultRevision: entityReport.resultRevision,
      restoreGeneration: entityReport.restoreGeneration,
      checkedEntityCount: entityReport.checkedEntityCount,
      assignedTaskCount: entityReport.assignedTaskCount,
      checkedRelationCount: before.relations.length,
      checkedTombstoneCount: before.tombstones.length,
      verifiedPersistedState: false,
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
