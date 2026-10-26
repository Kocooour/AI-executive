// 2c, part 5: pure, caller-supplied metadata preservation diagnostic.
// This is neither a SQLite reader nor permission to migrate, release holds,
// activate My Plan, enable sharing, or assert persisted/attested integrity.
import {
  checkLegacyAssigneeSideTablePreservation,
  type LegacyAssigneeSideTablePostcheck,
  type LegacyAssigneeSideTableSnapshot,
} from "./legacy-assignee-side-table-postcheck";

export type LegacyAssigneeMetadataSnapshot = LegacyAssigneeSideTableSnapshot & Readonly<{
  // The complete SQLite metadata table, not filtered as in backup/export.
  // Exact schema: (key TEXT PRIMARY KEY, value TEXT NOT NULL).
  metadata: readonly Readonly<{ key: string; value: string }>[];
}>;

export type LegacyAssigneeMetadataPostcheckInput = Readonly<{
  before: LegacyAssigneeMetadataSnapshot;
  after: LegacyAssigneeMetadataSnapshot;
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneeMetadataPostcheck = Readonly<
  Omit<LegacyAssigneeSideTablePostcheck, "phase"> & {
    phase: "legacy-assignee-metadata-postcheck-only";
    comparedMetadataKeyCount: number;
  }
>;

export class LegacyAssigneeMetadataPostcheckBlocked extends Error {
  constructor() {
    super("Legacy assignee metadata postcheck blocked");
    this.name = "LegacyAssigneeMetadataPostcheckBlocked";
  }
}
const blocked = (): never => { throw new LegacyAssigneeMetadataPostcheckBlocked(); };

// Limits apply before potentially expensive work and are shared across both
// complete metadata snapshots. Never include raw keys or values in errors.
const MAX_METADATA_ROWS = 4_096;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 1_000_000;
const MAX_TOTAL_CHARS = 4_000_000;

function readRows(value: unknown, budget: { remaining: number }): Map<string, string> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_METADATA_ROWS ||
      Reflect.ownKeys(value).length !== value.length + 1) blocked();
  const map = new Map<string, string>();
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !item.enumerable || !("value" in item)) blocked();
    const row: unknown = item.value;
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) blocked();
    const keys = Reflect.ownKeys(row);
    if (keys.length !== 2 || !keys.includes("key") || !keys.includes("value")) blocked();
    const keyDescriptor = Object.getOwnPropertyDescriptor(row, "key");
    const valueDescriptor = Object.getOwnPropertyDescriptor(row, "value");
    if (!keyDescriptor || !valueDescriptor ||
        !keyDescriptor.enumerable || !valueDescriptor.enumerable ||
        !("value" in keyDescriptor) || !("value" in valueDescriptor)) blocked();
    const key: unknown = keyDescriptor.value;
    const text: unknown = valueDescriptor.value;
    if (typeof key !== "string" || typeof text !== "string" ||
        !key.trim() || key.length > MAX_KEY_LENGTH ||
        text.length > MAX_VALUE_LENGTH || map.has(key)) blocked();
    budget.remaining -= key.length + text.length;
    if (budget.remaining < 0) blocked();
    map.set(key, text);
  }
  return map;
}

function canonicalCounter(raw: string | undefined): number {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) blocked();
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 0) blocked();
  return number;
}

/**
 * Adds a key-level invariant to parts 1-4 on the *same caller-supplied*
 * before/after pair. Allowed changes: revision must agree with the separately
 * validated canonical store snapshot, and updatedAt may only advance when
 * an assignee is assigned. All remaining metadata including credentials,
 * restoreGeneration and unknown future keys is unchanged byte-for-byte.
 *
 * Matching untrusted snapshots do not attest actual SQLite state or permit
 * any operational action.
 */
export function checkLegacyAssigneeMetadataPreservation(
  input: LegacyAssigneeMetadataPostcheckInput,
): LegacyAssigneeMetadataPostcheck {
  try {
    if (!input || !input.before || !input.after) blocked();
    const budget = { remaining: MAX_TOTAL_CHARS };
    const before = readRows(input.before.metadata, budget);
    const after = readRows(input.after.metadata, budget);
    if (before.size !== after.size) blocked();
    for (const [key, value] of before) {
      if (!after.has(key)) blocked();
      if (key !== "revision" && key !== "updatedAt" && value !== after.get(key)) blocked();
    }

    // This invokes *all* preceding entity, relation, tombstone, side-table,
    // legacy selection, restore generation and revision diagnostics.
    const prior = checkLegacyAssigneeSideTablePreservation({
      before: input.before, after: input.after,
      legacySharedWorkspaceIds: input.legacySharedWorkspaceIds,
    });
    if (canonicalCounter(before.get("revision")) !== prior.sourceRevision ||
        canonicalCounter(after.get("revision")) !== prior.resultRevision) blocked();
    const beforeUpdatedAt = canonicalCounter(before.get("updatedAt"));
    const afterUpdatedAt = canonicalCounter(after.get("updatedAt"));
    if (prior.assignedTaskCount === 0
      ? afterUpdatedAt !== beforeUpdatedAt
      : afterUpdatedAt < beforeUpdatedAt) blocked();

    // The restore generation is optional in legacy databases but its presence
    // and value must be identical on both sides and agree with the snapshot.
    // An absent key represents generation zero only.
    const rawGeneration = before.get("restoreGeneration");
    if (rawGeneration === undefined) {
      if (prior.restoreGeneration !== 0) blocked();
    } else if (canonicalCounter(rawGeneration) !== prior.restoreGeneration) blocked();

    return Object.freeze({
      ...prior,
      phase: "legacy-assignee-metadata-postcheck-only" as const,
      comparedMetadataKeyCount: before.size,
      // All prior verification and authorization flags remain literal false.
    });
  } catch {
    blocked();
  }
}
