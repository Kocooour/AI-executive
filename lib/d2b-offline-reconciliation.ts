// D2b part 2 — pure, owner-initiated offline-change rescue and reconciliation contract.
// This module NEVER reads browser storage, downloads a file, writes to a server,
// or authorizes automatic replay after a workspace partition.
// Its return value contains PRIVATE user data and must not be logged, cached,
// embedded in URLs, sent to AI services, or exported without explicit owner action.
import type { Entity, Relation } from "./db";
import { sameValue } from "./field-merge";
import { sha256Hex } from "./sha256";

type WithId = { id: string };

export type OfflineChange<T extends WithId> = Readonly<{
  id: string;
  before: T | null;
  after: T | null;
}>;

export type OfflineRecoveryInput = {
  base: { entities: readonly Entity[]; relations: readonly Relation[] };
  local: { entities: readonly Entity[]; relations: readonly Relation[] };
  pendingDeletedIds: readonly string[];
  pendingRevivedIds: readonly string[];
  // Include persisted per-tab note/context drafts, whether or not a record was changed.
  // Their exact bytes are kept for manual recovery, never automatically replayed.
  noteDrafts: readonly unknown[];
  projectContextDrafts: readonly unknown[];
  pendingSync: boolean;
  oldRestoreGeneration: number;
  newRestoreGeneration: number;
  baseRevision: number | null;
};

export type OfflineRecoveryBundle = Readonly<{
  format: "lumi-d2b-offline-recovery";
  version: 1;
  sensitiveOwnerData: true;
  automaticReplayAllowed: false;
  oldRestoreGeneration: number;
  observedRestoreGeneration: number;
  baseRevision: number | null;
  createdAt: number;
  changes: {
    entities: OfflineChange<Entity>[];
    relations: OfflineChange<Relation>[];
    pendingDeletedIds: string[];
    pendingRevivedIds: string[];
    noteDrafts: unknown[];
    projectContextDrafts: unknown[];
    pendingSync: boolean;
  };
  contentSha256: string;
}>;

export type OfflineRecoveryAssessment = {
  status: "manual-review-required" | "no-local-changes";
  automaticReplayAllowed: false;
  generationsDiffer: boolean;
  counts: { entities: number; relations: number; deletions: number; revivals: number; drafts: number };
  // ID-only diagnostics for LOCAL owner UI, not for telemetry/logs.
  candidates: Array<{ id: string; kind: "entity" | "relation"; reason:
    "remote-missing" | "workspace-changed" | "remote-diverged" | "local-change" | "already-present" | "id-collision" | "already-deleted" }>;
  requiresSeparateMembershipReview: true;
};

export class OfflineRecoveryInvalid extends Error {
  constructor() {
    super("Invalid offline recovery input");
    this.name = "OfflineRecoveryInvalid";
  }
}

/** Conservative limits for a synchronous, in-memory diagnostic tool.
 * Exceeding any limit refuses the *entire* bundle. No truncation or cleanup.
 * A future pre-adoption UI must handle failures without adopting/discarding local data.
 */
export const offlineRecoveryLimits = Object.freeze({
  maxEntitiesPerSnapshot: 20_000,
  maxRelationsPerSnapshot: 50_000,
  maxMarkersPerKind: 20_000,
  maxDraftsPerKind: 512,
  maxDraftJsonChars: 128 * 1024,
  maxStringChars: 256 * 1024,
  maxSourceChars: 32 * 1024 * 1024,
  maxBundleJsonChars: 8 * 1024 * 1024,
  maxNodes: 500_000,
  maxDepth: 32,
});

type PortableBudget = { nodes: number; chars: number };

const validCounter = (x: number) => Number.isSafeInteger(x) && x >= 0;
const validId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 240;

function index<T extends WithId>(items: readonly T[]): Map<string, T> {
  if (!Array.isArray(items)) throw new OfflineRecoveryInvalid();
  const map = new Map<string, T>();
  for (const item of items) {
    if (!item || !validId(item.id) || map.has(item.id)) throw new OfflineRecoveryInvalid();
    map.set(item.id, item);
  }
  return map;
}

// Entity and relation IDs share one namespace, as in validateSnapshotStructure.
function snapshotIds(snapshot: { entities: readonly Entity[]; relations: readonly Relation[] }): void {
  if (!snapshot || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.relations) ||
      snapshot.entities.length > offlineRecoveryLimits.maxEntitiesPerSnapshot ||
      snapshot.relations.length > offlineRecoveryLimits.maxRelationsPerSnapshot) throw new OfflineRecoveryInvalid();
  const ids = new Set<string>();
  for (const item of [...snapshot.entities, ...snapshot.relations]) {
    if (!item || !validId(item.id) || ids.has(item.id)) throw new OfflineRecoveryInvalid();
    ids.add(item.id);
  }
}

function changes<T extends WithId>(before: readonly T[], after: readonly T[]): OfflineChange<T>[] {
  const a = index(before), b = index(after);
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  return ids.flatMap((id) => {
    const previous = a.get(id) ?? null, current = b.get(id) ?? null;
    return sameValue(previous, current) ? [] : [{ id, before: previous, after: current }];
  });
}

function markers(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length > offlineRecoveryLimits.maxMarkersPerKind ||
      ids.some((id) => !validId(id))) throw new OfflineRecoveryInvalid();
  // A record can be marked more than once across tabs. Never silently drop a
  // different record; identical IDs carry the same latest semantic intent.
  return [...new Set(ids)].sort();
}

// Bound traversal *before* JSON serialization or hashing. Include keys and
// unchanged records; otherwise enormous dormant records can still freeze a tab.
function assertPortable(value: unknown, budget: PortableBudget, depth = 0,
  ancestors = new Set<object>()): void {
  budget.nodes += 1;
  if (budget.nodes > offlineRecoveryLimits.maxNodes || depth > offlineRecoveryLimits.maxDepth)
    throw new OfflineRecoveryInvalid();
  if (typeof value === "string") {
    if (value.length > offlineRecoveryLimits.maxStringChars) throw new OfflineRecoveryInvalid();
    budget.chars += value.length;
    if (budget.chars > offlineRecoveryLimits.maxSourceChars) throw new OfflineRecoveryInvalid();
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OfflineRecoveryInvalid();
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw new OfflineRecoveryInvalid();
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    throw new OfflineRecoveryInvalid();
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertPortable(item, budget, depth + 1, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertPortable(key, budget, depth + 1, ancestors);
      assertPortable(item, budget, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertDrafts(drafts: readonly unknown[], budget: PortableBudget): void {
  if (!Array.isArray(drafts) || drafts.length > offlineRecoveryLimits.maxDraftsPerKind)
    throw new OfflineRecoveryInvalid();
  for (const draft of drafts) {
    const beforeChars = budget.chars;
    assertPortable(draft, budget);
    // Conservative pre-serialization size bound; final JSON size is also capped.
    if (budget.chars - beforeChars > offlineRecoveryLimits.maxDraftJsonChars)
      throw new OfflineRecoveryInvalid();
    let encoded: string;
    try { encoded = JSON.stringify(draft); } catch { throw new OfflineRecoveryInvalid(); }
    if (typeof encoded !== "string" || encoded.length > offlineRecoveryLimits.maxDraftJsonChars)
      throw new OfflineRecoveryInvalid();
  }
}

// A checksum confirms bytes, not their meaning. An imported v1 bundle must
// satisfy this entire contract before any part reaches the classifier. In
// particular, a self-consistent rehashed file must not bypass schema checks.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length ||
      keys.some((key) => !expected.includes(key))) throw new OfflineRecoveryInvalid();
}

function validateChangeRecord(value: unknown, id: string, kind: "entity" | "relation"): void {
  if (!record(value) || value.id !== id || !validId(value.id) ||
      !validId(value.workspaceId)) throw new OfflineRecoveryInvalid();
  if (kind === "entity") {
    if (!["area", "project", "task", "note", "workspace"].includes(String(value.type)) ||
        typeof value.title !== "string" || typeof value.status !== "string" ||
        !record(value.properties) || !validCounter(value.createdAt as number) ||
        !validCounter(value.updatedAt as number) ||
        (value.content !== undefined && typeof value.content !== "string")) {
      throw new OfflineRecoveryInvalid();
    }
  } else if (!validId(value.sourceEntityId) || !validId(value.targetEntityId) ||
             typeof value.relationType !== "string" || !value.relationType ||
             !validCounter(value.createdAt as number)) {
    throw new OfflineRecoveryInvalid();
  }
}

function validateChangeEntries(value: unknown, kind: "entity" | "relation"): Set<string> {
  const max = kind === "entity" ? 2 * offlineRecoveryLimits.maxEntitiesPerSnapshot
    : 2 * offlineRecoveryLimits.maxRelationsPerSnapshot;
  if (!Array.isArray(value) || value.length > max) throw new OfflineRecoveryInvalid();
  const ids = new Set<string>();
  let last = "";
  for (const entry of value) {
    if (!record(entry)) throw new OfflineRecoveryInvalid();
    exactKeys(entry, ["id", "before", "after"]);
    const id = entry.id;
    if (!validId(id) || ids.has(id) || (last && id <= last) ||
        !Object.hasOwn(entry, "before") || !Object.hasOwn(entry, "after")) {
      throw new OfflineRecoveryInvalid();
    }
    if ((entry.before === null && entry.after === null) ||
        (entry.before !== null && !record(entry.before)) ||
        (entry.after !== null && !record(entry.after))) throw new OfflineRecoveryInvalid();
    if (entry.before !== null) validateChangeRecord(entry.before, id, kind);
    if (entry.after !== null) validateChangeRecord(entry.after, id, kind);
    if (entry.before !== null && entry.after !== null) {
      const before = entry.before as Record<string, unknown>;
      const after = entry.after as Record<string, unknown>;
      if (kind === "entity" && before.type !== after.type) throw new OfflineRecoveryInvalid();
    }
    if (sameValue(entry.before, entry.after)) throw new OfflineRecoveryInvalid();
    ids.add(id);
    last = id;
  }
  return ids;
}

function validateImportedMarkers(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length > offlineRecoveryLimits.maxMarkersPerKind)
    throw new OfflineRecoveryInvalid();
  const ids = new Set<string>();
  let last = "";
  for (const id of value) {
    if (!validId(id) || ids.has(id) || (last && id <= last)) throw new OfflineRecoveryInvalid();
    ids.add(id);
    last = id;
  }
  return ids;
}

function validateImportedBundleShape(bundle: OfflineRecoveryBundle): void {
  if (!record(bundle)) throw new OfflineRecoveryInvalid();
  exactKeys(bundle, ["format", "version", "sensitiveOwnerData", "automaticReplayAllowed",
    "oldRestoreGeneration", "observedRestoreGeneration", "baseRevision", "createdAt", "changes",
    "contentSha256"]);
  if (bundle.format !== "lumi-d2b-offline-recovery" || bundle.version !== 1 ||
      bundle.sensitiveOwnerData !== true || bundle.automaticReplayAllowed !== false ||
      !validCounter(bundle.oldRestoreGeneration) ||
      !validCounter(bundle.observedRestoreGeneration) ||
      bundle.oldRestoreGeneration >= bundle.observedRestoreGeneration ||
      !(bundle.baseRevision === null || validCounter(bundle.baseRevision)) || !validCounter(bundle.createdAt) ||
      !record(bundle.changes)) throw new OfflineRecoveryInvalid();
  const changes = bundle.changes;
  exactKeys(changes, ["entities", "relations", "pendingDeletedIds", "pendingRevivedIds",
    "noteDrafts", "projectContextDrafts", "pendingSync"]);
  if (typeof changes.pendingSync !== "boolean") throw new OfflineRecoveryInvalid();
  const entityIds = validateChangeEntries(changes.entities, "entity");
  const relationIds = validateChangeEntries(changes.relations, "relation");
  for (const id of relationIds) if (entityIds.has(id)) throw new OfflineRecoveryInvalid();
  const deleted = validateImportedMarkers(changes.pendingDeletedIds);
  const revived = validateImportedMarkers(changes.pendingRevivedIds);
  for (const id of deleted) if (revived.has(id)) throw new OfflineRecoveryInvalid();
  // Keep both per-kind draft count and per-draft serialized size bounds even
  // when the outer JSON and SHA appear perfectly valid.
  const budget: PortableBudget = { nodes: 0, chars: 0 };
  assertDrafts(changes.noteDrafts, budget);
  assertDrafts(changes.projectContextDrafts, budget);
}

export function prepareOfflineRecovery(input: OfflineRecoveryInput, now: number): OfflineRecoveryBundle {
  if (!validCounter(now) || !(input.baseRevision === null || validCounter(input.baseRevision)) ||
      !validCounter(input.oldRestoreGeneration) || !validCounter(input.newRestoreGeneration) ||
      input.newRestoreGeneration <= input.oldRestoreGeneration ||
      typeof input.pendingSync !== "boolean" ||
      !Array.isArray(input.noteDrafts) || !Array.isArray(input.projectContextDrafts)) {
    throw new OfflineRecoveryInvalid();
  }
  snapshotIds(input.base);
  snapshotIds(input.local);
  const budget: PortableBudget = { nodes: 0, chars: 0 };
  // Validate all unchanged records as well; none may block the browser or lose data.
  assertPortable(input.base, budget);
  assertPortable(input.local, budget);
  assertDrafts(input.noteDrafts, budget);
  assertDrafts(input.projectContextDrafts, budget);
  if (input.pendingDeletedIds.length > offlineRecoveryLimits.maxMarkersPerKind ||
      input.pendingRevivedIds.length > offlineRecoveryLimits.maxMarkersPerKind)
    throw new OfflineRecoveryInvalid();
  const changeset = {
    entities: changes(input.base.entities, input.local.entities),
    relations: changes(input.base.relations, input.local.relations),
    pendingDeletedIds: markers(input.pendingDeletedIds),
    pendingRevivedIds: markers(input.pendingRevivedIds),
    noteDrafts: [...input.noteDrafts],
    projectContextDrafts: [...input.projectContextDrafts],
    pendingSync: input.pendingSync,
  };
  if (changeset.pendingDeletedIds.some((id) => changeset.pendingRevivedIds.includes(id)))
    throw new OfflineRecoveryInvalid(); // contradictory pending intentions must be reconciled first
  const value = {
    format: "lumi-d2b-offline-recovery" as const, version: 1 as const,
    sensitiveOwnerData: true as const, automaticReplayAllowed: false as const,
    oldRestoreGeneration: input.oldRestoreGeneration,
    observedRestoreGeneration: input.newRestoreGeneration,
    baseRevision: input.baseRevision, createdAt: now,
    changes: changeset,
  };
  // Reject undefined, functions, NaN, cycles and non-JSON prototypes rather
  // than silently losing any part of a local draft in the rescue package.
  assertPortable(value, { nodes: 0, chars: 0 });
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new OfflineRecoveryInvalid(); }
  if (serialized.length > offlineRecoveryLimits.maxBundleJsonChars)
    throw new OfflineRecoveryInvalid();
  // Make a detached copy: another tab or caller mutating its input later must
  // not change the already fingerprinted rescue object.
  return { ...JSON.parse(serialized) as typeof value, contentSha256: sha256Hex(serialized) };
}

export function assessOfflineRecovery(
  bundle: OfflineRecoveryBundle,
  server: { restoreGeneration: number; entities: readonly Entity[]; relations: readonly Relation[] },
): OfflineRecoveryAssessment {
  validateImportedBundleShape(bundle);
  if (!server || !validCounter(server.restoreGeneration) ||
      server.restoreGeneration < bundle.observedRestoreGeneration)
    throw new OfflineRecoveryInvalid();
  // A checksum is NOT authorization and not a substitute for shape validation.
  // Bound traversal, serialization and hashing before touching server records.
  const { contentSha256, ...value } = bundle;
  const budget: PortableBudget = { nodes: 0, chars: 0 };
  assertPortable(value, budget);
  if (typeof contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(contentSha256))
    throw new OfflineRecoveryInvalid();
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new OfflineRecoveryInvalid(); }
  if (serialized.length > offlineRecoveryLimits.maxBundleJsonChars ||
      sha256Hex(serialized) !== contentSha256) throw new OfflineRecoveryInvalid();
  snapshotIds(server);
  const serverEntities = index(server.entities), serverRelations = index(server.relations);
  const classify = <T extends WithId & { workspaceId: string }>(
    entry: OfflineChange<T>, serverIndex: Map<string, T>, otherKindIndex: ReadonlyMap<string, WithId>,
  ) => {
    const remote = serverIndex.get(entry.id), edited = entry.after, before = entry.before;
    // Entity and relation IDs share one namespace. A same-ID record of another
    // kind cannot be mistaken for an absent record or an already-applied deletion.
    if (otherKindIndex.has(entry.id)) return "id-collision" as const;
    // A completed deletion is not a missing remote record; it was already applied.
    if (before && !edited && !remote) return "already-deleted" as const;
    if (!remote) return "remote-missing" as const;
    // For a newly created record, an occupied ID is a collision irrespective
    // of workspace. Existing records can still be classified as scope moves.
    if (before === null && edited)
      return sameValue(remote, edited) ? "already-present" as const : "id-collision" as const;
    if ((edited?.workspaceId ?? before?.workspaceId) !== remote.workspaceId) return "workspace-changed" as const;
    if (sameValue(remote, edited)) return "already-present" as const;
    if (before && !sameValue(before, remote)) return "remote-diverged" as const;
    return "local-change" as const;
  };
  const candidates: OfflineRecoveryAssessment["candidates"] = [
    ...bundle.changes.entities.map((x) => ({ id: x.id, kind: "entity" as const,
      reason: classify(x, serverEntities, serverRelations) })),
    ...bundle.changes.relations.map((x) => ({ id: x.id, kind: "relation" as const,
      reason: classify(x, serverRelations, serverEntities) })),
  ];
  const c = bundle.changes;
  const hasLocalChanges = c.pendingSync || c.entities.length > 0 || c.relations.length > 0 ||
    c.pendingDeletedIds.length > 0 || c.pendingRevivedIds.length > 0 ||
    c.noteDrafts.length > 0 || c.projectContextDrafts.length > 0;
  return {
    status: hasLocalChanges ? "manual-review-required" : "no-local-changes",
    automaticReplayAllowed: false,
    generationsDiffer: server.restoreGeneration !== bundle.oldRestoreGeneration,
    counts: {
      entities: c.entities.length, relations: c.relations.length,
      deletions: c.pendingDeletedIds.length, revivals: c.pendingRevivedIds.length,
      drafts: c.noteDrafts.length + c.projectContextDrafts.length,
    },
    candidates,
    requiresSeparateMembershipReview: true,
  };
}
