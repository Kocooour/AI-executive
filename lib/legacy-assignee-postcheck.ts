// 2c, part 2: pure before/after entity integrity check for a future,
// separately authorized and transactionally guarded legacy assignee backfill.
// This does NOT write data, attest provenance/freshness, or enable My Plan.
import type { Entity } from "./db";
import { sameValue } from "./field-merge";
import { planLegacyOwnerAssignees, type LegacyAssigneeSource } from "./legacy-assignee-preflight";

export type LegacyAssigneePostcheckInput = Readonly<{
  before: LegacyAssigneeSource;
  after: LegacyAssigneeSource;
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneePostcheck = Readonly<{
  phase: "legacy-assignee-postcheck-only";
  sourceRevision: number;
  resultRevision: number;
  restoreGeneration: number;
  checkedEntityCount: number;
  assignedTaskCount: number;
  // These are intentionally always false: snapshots and legacy provenance
  // arrive from the caller, not from an authenticated locked store.
  verifiedPersistedState: false;
  canApply: false;
  canActivateMyPlan: false;
  canEnableSharing: false;
}>;

export class LegacyAssigneePostcheckBlocked extends Error {
  constructor() {
    super("Legacy assignee postcheck blocked");
    this.name = "LegacyAssigneePostcheckBlocked";
  }
}

const blocked = (): never => { throw new LegacyAssigneePostcheckBlocked(); };

function unchanged(expected: Entity, actual: Entity): boolean {
  try { return sameValue(expected, actual); }
  catch { return false; }
}

/**
 * Diagnose whether a supplied "after" ENTITIES snapshot differs from "before"
 * only by assigning each open, unassigned legacy owner-only task to "owner"
 * (plus a nondecreasing updatedAt on precisely those tasks). No other entity
 * content, ID, workspace, ordering field, member list or task may change.
 *
 * This does not inspect relations, tombstones, side tables, actual Home/Today/
 * Inbox read models, or authoritative ACL/lineage/CAS. Future migrations MUST
 * independently verify those under an authenticated transaction. Never treat
 * success here as proof that a real migration has been safely applied.
 */
export function checkLegacyOwnerAssigneeBackfill(input: LegacyAssigneePostcheckInput): LegacyAssigneePostcheck {
  if (!input || !input.before || !input.after) blocked();

  let beforePlan: ReturnType<typeof planLegacyOwnerAssignees>;
  let afterPlan: ReturnType<typeof planLegacyOwnerAssignees>;
  try {
    beforePlan = planLegacyOwnerAssignees({
      source: input.before, legacySharedWorkspaceIds: input.legacySharedWorkspaceIds,
    });
    afterPlan = planLegacyOwnerAssignees({
      source: input.after, legacySharedWorkspaceIds: input.legacySharedWorkspaceIds,
    });
  } catch {
    blocked();
  }

  const candidates = new Set(beforePlan.candidateTaskIds);
  const nextRevision = input.before.revision + (candidates.size === 0 ? 0 : 1);
  if (!Number.isSafeInteger(nextRevision) || input.after.revision !== nextRevision ||
      input.after.restoreGeneration !== input.before.restoreGeneration ||
      input.after.entities.length !== input.before.entities.length ||
      afterPlan.candidateTaskIds.length !== 0 ||
      afterPlan.counts.openLegacyTasks !== beforePlan.counts.openLegacyTasks ||
      afterPlan.counts.alreadyAssignedOwner !== beforePlan.counts.alreadyAssignedOwner + candidates.size ||
      afterPlan.counts.nonOpenSkipped !== beforePlan.counts.nonOpenSkipped) blocked();

  const afterById = new Map(input.after.entities.map(e => [e.id, e]));
  for (const before of input.before.entities) {
    const after = afterById.get(before.id);
    if (!after) blocked();
    if (!candidates.has(before.id)) {
      if (!unchanged(before, after)) blocked();
      continue;
    }

    // Only the missing/null assignee may become "owner". A migration is
    // allowed to bump updatedAt but not to rewrite any other timestamp/field.
    if (before.type !== "task" || after.type !== "task" ||
        (before.properties.assigneeUserId !== undefined && before.properties.assigneeUserId !== null) ||
        after.properties.assigneeUserId !== "owner" ||
        !Number.isFinite(before.updatedAt) || !Number.isFinite(after.updatedAt) ||
        after.updatedAt < before.updatedAt) blocked();
    const expected: Entity = {
      ...before,
      properties: { ...before.properties, assigneeUserId: "owner" },
      updatedAt: after.updatedAt,
    };
    if (!unchanged(expected, after)) blocked();
  }

  return Object.freeze({
    phase: "legacy-assignee-postcheck-only",
    sourceRevision: input.before.revision,
    resultRevision: input.after.revision,
    restoreGeneration: input.before.restoreGeneration,
    checkedEntityCount: input.before.entities.length,
    assignedTaskCount: candidates.size,
    verifiedPersistedState: false,
    canApply: false,
    canActivateMyPlan: false,
    canEnableSharing: false,
  });
}
