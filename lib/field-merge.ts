import type { Entity, Relation } from "./db";

// Three-way merge of one record: the version this device last had in common with the server
// (`base`), the device's version (`local`) and the server's version (`server`). A field changed on
// one side only is taken from that side, so two devices that edit different fields of the same task
// both keep their change. A field changed on both sides to different values is a conflict: the
// newer record wins (owner decision 2026-10-08) and the value it replaced is kept on the record as
// a sync conflict, so it can be shown and restored.

export interface SyncConflict {
  id: string;
  // "title", "status", "content", "properties.<key>" or "relation.<relationType>".
  field: string;
  // The value that was replaced; for a relation, the target record id ("" for none).
  lostValue: unknown;
  at: number;
}

export const conflictsKey = "syncConflicts";
const maxConflicts = 20;
// The replaced values travel with the record, which the server limits in size; the oldest are
// dropped first when long notes would take too much room.
const maxConflictsSize = 60_000;

// Fields that are merged but never reported as a conflict: bookkeeping the user does not edit.
const unreported = new Set([
  "type",
  "workspaceId",
  "createdAt",
  "updatedAt",
  "properties.activity",
  "properties.planningHistory",
  "properties.planningFeedback",
  "properties.workSessionHistory",
  "properties.manualOrders",
  "properties.manualOrder",
  "properties.relationsUpdatedAt",
  "properties.completedAt",
  "properties.recurrenceSeriesId",
  "properties.members",
  "properties.kind",
  "properties.role",
  `properties.${conflictsKey}`,
]);
// Logs that only grow: entries from both sides are kept.
const logFields = new Set(["activity", "planningHistory"]);
const topLevelFields = ["title", "content", "status", "workspaceId", "type"] as const;

function same(a: unknown, b: unknown) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

type Outcome = { value: unknown; lost?: unknown; conflict: boolean };

function threeWay(base: unknown, local: unknown, server: unknown, localWins: boolean): Outcome {
  if (same(local, server)) return { value: server, conflict: false };
  if (same(local, base)) return { value: server, conflict: false };
  if (same(server, base)) return { value: local, conflict: false };
  return localWins
    ? { value: local, lost: server, conflict: true }
    : { value: server, lost: local, conflict: true };
}

function mergeLog(base: unknown, local: unknown, server: unknown) {
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const known = new Set(list(server).map(stableJson));
  const baseKeys = new Set(list(base).map(stableJson));
  const added = list(local).filter((entry) => !known.has(stableJson(entry)) && !baseKeys.has(stableJson(entry)));
  const merged = [...list(server), ...added];
  if (merged.every((entry) => entry && typeof entry === "object" && typeof (entry as { at?: unknown }).at === "number")) {
    merged.sort((a, b) => (a as { at: number }).at - (b as { at: number }).at);
  }
  return merged.slice(-50);
}

type Identified = { id: string } & Record<string, unknown>;
const identified = (value: unknown): value is Identified[] =>
  Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");

// Lists of items with ids (checklist, sync conflicts): items are merged one by one, so an item
// added on one device and an item ticked on the other are both kept. An item removed on one side
// and left alone on the other is removed. Returns null when the lists have no stable ids.
function mergeItems(base: unknown, local: unknown, server: unknown, localWins: boolean) {
  const baseList = base === undefined ? [] : base;
  if (!identified(baseList) || !identified(local ?? []) || !identified(server ?? [])) return null;
  const byId = (items: Identified[]) => new Map(items.map((item) => [item.id, item]));
  const b = byId(baseList), l = byId((local ?? []) as Identified[]), s = byId((server ?? []) as Identified[]);
  const order = [...s.keys(), ...[...l.keys()].filter((id) => !s.has(id))];
  const result: Identified[] = [];
  let conflict = false;
  for (const id of order) {
    const inBase = b.has(id), inLocal = l.has(id), inServer = s.has(id);
    if (inBase && (!inLocal || !inServer)) {
      // Removed on one side: removed, unless the other side changed it meanwhile.
      const kept = inLocal ? l.get(id) : s.get(id);
      if (!same(kept, b.get(id))) result.push(kept as Identified);
      continue;
    }
    if (inLocal && inServer) {
      const outcome = threeWay(b.get(id), l.get(id), s.get(id), localWins);
      conflict ||= outcome.conflict;
      result.push(outcome.value as Identified);
    } else {
      result.push((inServer ? s.get(id) : l.get(id)) as Identified);
    }
  }
  return { value: result, conflict };
}

function mergeObject(base: unknown, local: unknown, server: unknown, localWins: boolean) {
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const b = object(base), l = object(local), s = object(server);
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(s)])) {
    const value = threeWay(b[key], l[key], s[key], localWins).value;
    if (value !== undefined) result[key] = value;
  }
  return result;
}

let conflictCounter = 0;
function conflictId(now: number) {
  conflictCounter += 1;
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${now}-${conflictCounter}`;
}

export function entityConflicts(entity: Entity | undefined): SyncConflict[] {
  const value = entity?.properties?.[conflictsKey];
  return Array.isArray(value) ? value.filter((item): item is SyncConflict => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.field === "string")) : [];
}

export function withConflicts(entity: Entity, added: SyncConflict[]): Entity {
  if (!added.length) return entity;
  const conflicts = [...entityConflicts(entity), ...added].slice(-maxConflicts);
  while (conflicts.length > 1 && JSON.stringify(conflicts).length > maxConflictsSize) conflicts.shift();
  return { ...entity, properties: { ...entity.properties, [conflictsKey]: conflicts } };
}

export function mergeEntity(base: Entity, local: Entity, server: Entity, now = Date.now()): Entity {
  const localWins = local.updatedAt > server.updatedAt;
  const merged: Record<string, unknown> = { ...server };
  const conflicts: SyncConflict[] = [];
  const record = (field: string, outcome: Outcome) => {
    if (outcome.conflict && !unreported.has(field)) {
      conflicts.push({ id: conflictId(now), field, lostValue: outcome.lost ?? null, at: now });
    }
  };
  for (const field of topLevelFields) {
    const outcome = threeWay(base[field], local[field], server[field], localWins);
    record(field, outcome);
    if (outcome.value === undefined) delete merged[field];
    else merged[field] = outcome.value;
  }
  const properties: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base.properties || {}), ...Object.keys(local.properties || {}), ...Object.keys(server.properties || {})]);
  for (const key of keys) {
    const b = base.properties?.[key], l = local.properties?.[key], s = server.properties?.[key];
    let value: unknown;
    if (logFields.has(key)) value = mergeLog(b, l, s);
    else if (key === "relationsUpdatedAt") value = Math.max(Number(l || 0), Number(s || 0)) || undefined;
    else if (key === "manualOrders") value = mergeObject(b, l, s, localWins);
    else {
      const items = key === "checklist" || key === conflictsKey ? mergeItems(b, l, s, localWins) : null;
      if (items) {
        value = items.value;
        if (items.conflict && key === "checklist") {
          conflicts.push({ id: conflictId(now), field: "properties.checklist", lostValue: localWins ? s : l, at: now });
        }
      } else {
        const outcome = threeWay(b, l, s, localWins);
        record(`properties.${key}`, outcome);
        value = outcome.value;
      }
    }
    if (value !== undefined) properties[key] = value;
  }
  merged.properties = properties;
  merged.createdAt = Math.min(local.createdAt, server.createdAt);
  merged.updatedAt = Math.max(local.updatedAt, server.updatedAt);
  return withConflicts(merged as unknown as Entity, conflicts);
}

const relationKey = (relation: Relation) => `${relation.sourceEntityId}|${relation.relationType}`;

// Relations are single-valued per record and type (a task belongs to one project and one area;
// `relate` replaces the previous one). Each record's relation of a type is merged like a field.
// Returns the merged relations and the conflicts per source record.
export function mergeRelations(
  base: Relation[],
  local: Relation[],
  server: Relation[],
  localWinsFor: (sourceId: string) => boolean,
  now = Date.now(),
) {
  const group = (relations: Relation[]) => {
    const groups = new Map<string, Relation[]>();
    for (const relation of relations) {
      const key = relationKey(relation);
      groups.set(key, [...(groups.get(key) || []), relation]);
    }
    return groups;
  };
  const b = group(base), l = group(local), s = group(server);
  const targets = (relations: Relation[] | undefined) => (relations || []).map((relation) => relation.targetEntityId).sort();
  const result: Relation[] = [];
  const conflicts = new Map<string, SyncConflict[]>();
  for (const key of new Set([...b.keys(), ...l.keys(), ...s.keys()])) {
    const [sourceId, relationType] = key.split("|");
    const outcome = threeWay(targets(b.get(key)), targets(l.get(key)), targets(s.get(key)), localWinsFor(sourceId));
    const chosen = same(outcome.value, targets(s.get(key))) ? s.get(key) : l.get(key);
    result.push(...(chosen || []));
    if (outcome.conflict) {
      const lost = (outcome.lost as string[])[0] ?? "";
      conflicts.set(sourceId, [...(conflicts.get(sourceId) || []), { id: conflictId(now), field: `relation.${relationType}`, lostValue: lost, at: now }]);
    }
  }
  return { relations: result, conflicts };
}
