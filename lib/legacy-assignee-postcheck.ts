// 2c, part 2: pure before/after entity integrity check for a future,
// separately authorized and transactionally guarded legacy assignee backfill.
// This does NOT write data, attest provenance/freshness, or enable My Plan.
import type { Entity } from "./db";
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

// These snapshots represent persisted JSON entities. Reject exotic in-memory
// values instead of letting JSON serialization hide differences (for example,
// Date objects stringify as {}, and NaN stringifies as null).
function isJsonData(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array) {
      // A JSON array must contain exactly its length own index properties, with
      // no holes, extra fields, symbols or accessors.
      if (keys.length !== value.length + 1) return false;
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
            !isJsonData(descriptor.value, ancestors)) return false;
      }
      return true;
    }

    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          !isJsonData(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

// Object property order is immaterial; all keys and JSON-safe values must match.
// This deliberately does not use field-merge's lenient sameValue comparator.
function equalJsonData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equalJsonData(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) &&
    equalJsonData(left[key], right[key]));
}

function unchanged(expected: Entity, actual: Entity): boolean {
  try { return equalJsonData(expected, actual); }
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
    // Validate both complete entity collections before calculating any plan.
    // Missing/undefined properties, non-finite numbers, exotic objects, array
    // holes, getters and cycles are not valid canonical persisted JSON.
    if (!Array.isArray(input.before.entities) || !Array.isArray(input.after.entities) ||
        input.before.entities.length > 20_000 || input.after.entities.length > 20_000 ||
        !isJsonData(input.before.entities) || !isJsonData(input.after.entities)) blocked();
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
