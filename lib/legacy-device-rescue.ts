// C13: explain historical, device-only work before unified target mode hides the
// legacy local-first editor. Pure: never writes storage, syncs or sends data.
import type { Entity, Relation } from "./db";
import { sameValue } from "./field-merge";
import { forServer } from "./sendable";
import type { RawRecoveryDraft } from "./d2b-recovery-local";

export type LocalLegacyData = {
  local: { entities: Entity[]; relations: Relation[] };
  base: { entities: Entity[]; relations: Relation[] } | null;
  markers: { pendingDeletedIds: string[]; pendingRevivedIds: string[]; pendingSync: boolean };
  drafts: { noteDrafts: RawRecoveryDraft[]; projectContextDrafts: RawRecoveryDraft[] };
};

function changedIds<T extends { id: string }>(before: readonly T[], after: readonly T[]): string[] {
  const old = new Map(before.map(item => [item.id, item]));
  const current = new Map(after.map(item => [item.id, item]));
  return [...new Set([...old.keys(), ...current.keys()])]
    .filter(id => !sameValue(old.get(id), current.get(id)));
}

export function detectLegacyPending(data: LocalLegacyData) {
  // No sync base exists on first start / an old device: local content may be
  // unique and must be treated as unsent rather than silently discarded.
  const entityIds = data.base
    ? changedIds(data.base.entities, data.local.entities)
    : data.local.entities.filter(item => item.type !== "workspace").map(item => item.id);
  const relationIds = data.base
    ? changedIds(data.base.relations, data.local.relations)
    : data.local.relations.map(item => item.id);
  const held = forServer(data.local.entities, data.local.relations, data.base).heldBack;
  const recordIds = new Set([
    ...entityIds, ...relationIds, ...held.map(item => item.id),
    ...data.markers.pendingDeletedIds, ...data.markers.pendingRevivedIds,
  ]);
  const drafts = data.drafts.noteDrafts.length + data.drafts.projectContextDrafts.length;
  // A pending marker alone indicates an interrupted operation whose affected
  // IDs may no longer be identifiable. Report at least one, never a false zero.
  const pendingMarkerOnly = data.markers.pendingSync && recordIds.size + drafts === 0;
  const count = recordIds.size + drafts + (pendingMarkerOnly ? 1 : 0);
  return { pending: count > 0, count, atLeast: pendingMarkerOnly || !data.base };
}

export function createLegacyLocalCopy(data: LocalLegacyData, createdAt: number) {
  const summary = detectLegacyPending(data);
  if (!summary.pending || !Number.isSafeInteger(createdAt)) throw new Error("NO_LOCAL_CHANGES");
  // Include full local and base snapshots, not just selected diffs, so a
  // future manual comparison can recover relationships and missing context.
  return {
    format: "lumi-legacy-device-copy" as const, version: 1 as const,
    sensitiveOwnerData: true as const, automaticReplayAllowed: false as const,
    createdAt, summary, local: data.local, base: data.base,
    pendingDeletedIds: data.markers.pendingDeletedIds,
    pendingRevivedIds: data.markers.pendingRevivedIds,
    pendingSync: data.markers.pendingSync,
    noteDrafts: data.drafts.noteDrafts,
    projectContextDrafts: data.drafts.projectContextDrafts,
  };
}
