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
  baseRevision: number;
};

export type OfflineRecoveryBundle = Readonly<{
  format: "lumi-d2b-offline-recovery";
  version: 1;
  sensitiveOwnerData: true;
  automaticReplayAllowed: false;
  oldRestoreGeneration: number;
  observedRestoreGeneration: number;
  baseRevision: number;
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
    "remote-missing" | "workspace-changed" | "remote-diverged" | "local-change" | "already-present" }>;
  requiresSeparateMembershipReview: true;
};

export class OfflineRecoveryInvalid extends Error {
  constructor() {
    super("Invalid offline recovery input");
    this.name = "OfflineRecoveryInvalid";
  }
}

const byId = <T extends WithId>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

function changes<T extends WithId>(before: readonly T[], after: readonly T[]): OfflineChange<T>[] {
  const a = index(before), b = index(after);
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  return ids.flatMap((id) => {
    const previous = a.get(id) ?? null, current = b.get(id) ?? null;
    return sameValue(previous, current) ? [] : [{ id, before: previous, after: current }];
  });
}

function markers(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.some((id) => !validId(id))) throw new OfflineRecoveryInvalid();
  // A record can be marked more than once across tabs. Never silently drop a
  // different record; identical IDs carry the same latest semantic intent.
  return [...new Set(ids)].sort();
}

export function prepareOfflineRecovery(input: OfflineRecoveryInput, now: number): OfflineRecoveryBundle {
  if (!validCounter(now) || !validCounter(input.baseRevision) ||
      !validCounter(input.oldRestoreGeneration) || !validCounter(input.newRestoreGeneration) ||
      input.newRestoreGeneration <= input.oldRestoreGeneration ||
      typeof input.pendingSync !== "boolean" ||
      !Array.isArray(input.noteDrafts) || !Array.isArray(input.projectContextDrafts)) {
    throw new OfflineRecoveryInvalid();
  }
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
  // JSON serialization also fails closed on cycles, BigInt, or non-serializable
  // bytes. Reject instead of exporting an incomplete/damaged draft silently.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    if (JSON.stringify(JSON.parse(serialized)) !== serialized) throw new Error("Non-portable JSON");
  } catch {
    throw new OfflineRecoveryInvalid();
  }
  return { ...value, contentSha256: sha256Hex(serialized) };
}

export function assessOfflineRecovery(
  bundle: OfflineRecoveryBundle,
  server: { restoreGeneration: number; entities: readonly Entity[]; relations: readonly Relation[] },
): OfflineRecoveryAssessment {
  if (bundle.format !== "lumi-d2b-offline-recovery" || bundle.version !== 1 ||
      bundle.automaticReplayAllowed !== false || bundle.sensitiveOwnerData !== true ||
      !validCounter(server.restoreGeneration) ||
      server.restoreGeneration < bundle.observedRestoreGeneration ||
      bundle.oldRestoreGeneration >= bundle.observedRestoreGeneration) throw new OfflineRecoveryInvalid();
  // Tampered/exported bundles must never be accepted as trusted input.
  const { contentSha256, ...value } = bundle;
  if (typeof contentSha256 !== "string" || sha256Hex(JSON.stringify(value)) !== contentSha256)
    throw new OfflineRecoveryInvalid();
  const serverEntities = index(server.entities), serverRelations = index(server.relations);
  const classify = <T extends WithId & { workspaceId: string }>(entry: OfflineChange<T>, serverIndex: Map<string, T>) => {
    const remote = serverIndex.get(entry.id), edited = entry.after, before = entry.before;
    if (!remote) return "remote-missing" as const;
    if ((edited?.workspaceId ?? before?.workspaceId) !== remote.workspaceId) return "workspace-changed" as const;
    if (sameValue(remote, edited)) return "already-present" as const;
    if (before && !sameValue(before, remote)) return "remote-diverged" as const;
    return "local-change" as const;
  };
  const candidates: OfflineRecoveryAssessment["candidates"] = [
    ...bundle.changes.entities.map((x) => ({ id: x.id, kind: "entity" as const, reason: classify(x, serverEntities) })),
    ...bundle.changes.relations.map((x) => ({ id: x.id, kind: "relation" as const, reason: classify(x, serverRelations) })),
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
