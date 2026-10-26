// 2c, part 7: pure, caller-supplied multi-context read-model preservation check.
// The expected context manifest is itself untrusted. Never attest completeness,
// authorize a migration, release a hold, activate My Plan or enable sharing.
import { types as nodeTypes } from "node:util";
import {
  matrixFingerprintBudget,
  matrixStoreTransitionFingerprint,
} from "./legacy-assignee-matrix-state-fingerprint";
import {
  checkLegacyAssigneeReadModelPreservation,
  type LegacyAssigneeReadModelSnapshot,
} from "./legacy-assignee-read-model-postcheck";

const CONTEXT_FIELDS = ["actorUserId", "asOf", "timezone", "queryFingerprint"] as const;
type ContextField = (typeof CONTEXT_FIELDS)[number];

export type LegacyAssigneeExpectedReadContext = Readonly<Record<ContextField, string>>;
export type LegacyAssigneeReadModelCase = Readonly<{
  before: LegacyAssigneeReadModelSnapshot;
  after: LegacyAssigneeReadModelSnapshot;
}>;
export type LegacyAssigneeReadModelMatrixInput = Readonly<{
  // A caller-supplied exact list, NOT an authoritative roster or ACL check.
  expectedContexts: readonly LegacyAssigneeExpectedReadContext[];
  cases: readonly LegacyAssigneeReadModelCase[];
  legacySharedWorkspaceIds: readonly string[];
}>;
export type LegacyAssigneeReadModelMatrixResult = Readonly<{
  phase: "legacy-assignee-read-model-matrix-postcheck-only";
  checkedContextCount: number;
  comparedReadModelCount: number;
  verifiedPersistedState: false;
  verifiedMetadata: false;
  verifiedSideTables: false;
  verifiedHomeTodayInbox: false;
  canApply: false;
  canReleaseHold: false;
  canActivateMyPlan: false;
  canEnableSharing: false;
}>;

export class LegacyAssigneeReadModelMatrixBlocked extends Error {
  constructor() {
    super("Legacy assignee read-model matrix postcheck blocked");
    this.name = "LegacyAssigneeReadModelMatrixBlocked";
  }
}
const blocked = (): never => { throw new LegacyAssigneeReadModelMatrixBlocked(); };

const MAX_CONTEXTS = 16;
const MAX_CONTEXT_FIELD_CHARS = 512;
const MAX_LEGACY_WORKSPACES = 20_000;
const MAX_LEGACY_ID_CHARS = 256;
// All view contexts in one matrix must compare the same claimed store transition.
const STABLE_REPORT_FIELDS = [
  "sourceRevision", "resultRevision", "restoreGeneration", "checkedEntityCount",
  "assignedTaskCount", "checkedRelationCount", "checkedTombstoneCount",
  "comparedSideTableCount", "comparedSideTableRowCount", "comparedMetadataKeyCount",
] as const;

function plainData(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) blocked();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) blocked();
  const keys = Reflect.ownKeys(value as object);
  if (keys.length !== fields.length ||
      keys.some(key => typeof key !== "string" || !fields.includes(key))) blocked();
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) blocked();
    result[field] = descriptor.value;
  }
  return result;
}

function denseArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) blocked();
  const array = value as unknown[];
  const entries: unknown[] = [];
  for (let i = 0; i < array.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) blocked();
    entries.push(descriptor.value);
  }
  return entries;
}

function contextSignature(value: unknown): string {
  const fields = plainData(value, CONTEXT_FIELDS);
  const parts: string[] = [];
  for (const field of CONTEXT_FIELDS) {
    const text = fields[field];
    if (typeof text !== "string" || !text.trim() ||
        text.length > MAX_CONTEXT_FIELD_CHARS) blocked();
    parts.push(text as string);
  }
  // Collision-free framing; no custom delimiter can be forged by a field.
  return JSON.stringify(parts);
}

// Validate the complete snapshot shell, not just readModels. Parts 1–6
// consume these other fields too, so never let a getter/inherited value reach
// them. Copy descriptor values into a fresh plain data object before handing
// snapshots to the older postcheck chain.
const SNAPSHOT_FIELDS = [
  "revision", "restoreGeneration", "entities", "relations", "tombstones",
  "sideTables", "metadata", "readModels",
] as const;

function validatedSnapshot(value: unknown): {
  snapshot: LegacyAssigneeReadModelSnapshot;
  signature: string;
} {
  const snapshot = plainData(value, SNAPSHOT_FIELDS);
  const readModels = plainData(snapshot.readModels, ["context", "home", "today", "inbox"]);
  const signature = contextSignature(readModels.context);
  snapshot.readModels = readModels;
  return { snapshot: snapshot as unknown as LegacyAssigneeReadModelSnapshot, signature };
}

/**
 * Enforce exact coverage of an explicitly declared (untrusted) matrix of
 * actor/time/timezone/query contexts. Case order does not matter, but every
 * expected context occurs precisely once and each matching before/after pair
 * must satisfy all six pre-existing 2c postchecks.
 *
 * Caller-provided expectedContexts cannot establish roster completeness,
 * reliable extraction, real route equivalence or server-side authorization.
 */
export function checkLegacyAssigneeReadModelMatrixPreservation(
  input: LegacyAssigneeReadModelMatrixInput,
): LegacyAssigneeReadModelMatrixResult {
  try {
    const root = plainData(input, ["expectedContexts", "cases", "legacySharedWorkspaceIds"]);
    const expected = denseArray(root.expectedContexts, MAX_CONTEXTS);
    const cases = denseArray(root.cases, MAX_CONTEXTS);
    const legacyIds = denseArray(root.legacySharedWorkspaceIds, MAX_LEGACY_WORKSPACES);
    if (!expected.length || cases.length !== expected.length ||
        legacyIds.some(id => typeof id !== "string" || id.length > MAX_LEGACY_ID_CHARS || !id.trim())) blocked();

    const expectedKeys = new Set<string>();
    for (const context of expected) {
      const signature = contextSignature(context);
      if (expectedKeys.has(signature)) blocked();
      expectedKeys.add(signature);
    }

    // Preflight all case identities before invoking potentially costly checks.
    const seen = new Set<string>();
    const pairs: LegacyAssigneeReadModelCase[] = [];
    for (const candidate of cases) {
      const pair = plainData(candidate, ["before", "after"]);
      const before = validatedSnapshot(pair.before);
      const after = validatedSnapshot(pair.after);
      if (before.signature !== after.signature ||
          !expectedKeys.has(before.signature) || seen.has(before.signature)) blocked();
      seen.add(before.signature);
      pairs.push({ before: before.snapshot, after: after.snapshot });
    }
    if (seen.size !== expectedKeys.size) blocked();

    let baseline: ReturnType<typeof checkLegacyAssigneeReadModelPreservation> | undefined;
    let baselineStateFingerprint: string | undefined;
    const stateBudget = matrixFingerprintBudget();
    for (const pair of pairs) {
      const report = checkLegacyAssigneeReadModelPreservation({
        before: pair.before, after: pair.after,
        legacySharedWorkspaceIds: legacyIds as string[],
      });
      // Prior stages prove pairwise preservation on caller assertions. Also
      // require every actor/time/query case to describe the *same* claimed
      // persisted before/after transition, not merely matching row counts.
      const stateFingerprint = matrixStoreTransitionFingerprint(
        pair.before, pair.after, stateBudget,
      );
      if (baseline) {
        for (const field of STABLE_REPORT_FIELDS) {
          if (baseline[field] !== report[field]) blocked();
        }
        if (stateFingerprint !== baselineStateFingerprint) blocked();
      } else {
        baseline = report;
        baselineStateFingerprint = stateFingerprint;
      }
    }
    return Object.freeze({
      phase: "legacy-assignee-read-model-matrix-postcheck-only" as const,
      checkedContextCount: pairs.length,
      comparedReadModelCount: pairs.length * 3,
      verifiedPersistedState: false as const,
      verifiedMetadata: false as const,
      verifiedSideTables: false as const,
      verifiedHomeTodayInbox: false as const,
      canApply: false as const,
      canReleaseHold: false as const,
      canActivateMyPlan: false as const,
      canEnableSharing: false as const,
    });
  } catch {
    blocked();
  }
}
