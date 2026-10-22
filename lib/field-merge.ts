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
  // The value that was replaced; for a relation, the target record id ("" for none); for a
  // checklist, the items whose other version was replaced.
  lostValue: unknown;
  at: number;
  // The value was too long to travel with the record: only its beginning is kept, for reading.
  truncated?: boolean;
}

export const conflictsKey = "syncConflicts";
const maxConflicts = 20;
// The replaced values travel with the record, which the server limits in size (250 000 characters
// of properties per record, lib/server-store.ts; 5 MB per save). The oldest are dropped first, a
// value that does not fit is kept only as a short beginning, and all records together keep at most
// `maxConflictsTotal`.
const maxConflictsSize = 60_000;
const serverPropertiesLimit = 250_000;
const propertiesMargin = 10_000;
const truncatedLength = 300;
export const maxConflictsTotal = 1_000_000;

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
  "properties.waitingSince",
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
// Fields that together say where a task sits; see mergeEntity.
export const placementFields = ["when", "today", "someday", "inbox", "evening"] as const;
// Logs that only grow: entries from both sides are kept.
const logFields = new Set(["activity", "planningHistory"]);
const topLevelFields = ["title", "content", "status", "workspaceId", "type"] as const;

// Equal content (objects compared by their keys and values, not by identity).
export function sameValue(a: unknown, b: unknown) {
  return same(a, b);
}

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
  const lost: Identified[] = [];
  let conflict = false;
  for (const id of order) {
    const inBase = b.has(id), inLocal = l.has(id), inServer = s.has(id);
    if (inBase && (!inLocal || !inServer)) {
      // Removed on one side: removed. If the other side changed it meanwhile, the removal still
      // wins and the changed item is kept as the replaced value, so it can be restored.
      const kept = inLocal ? l.get(id) : s.get(id);
      if (!same(kept, b.get(id))) {
        conflict = true;
        lost.push(kept as Identified);
      }
      continue;
    }
    if (inLocal && inServer) {
      const outcome = threeWay(b.get(id), l.get(id), s.get(id), localWins);
      conflict ||= outcome.conflict;
      if (outcome.conflict) lost.push(outcome.lost as Identified);
      result.push(outcome.value as Identified);
    } else {
      result.push((inServer ? s.get(id) : l.get(id)) as Identified);
    }
  }
  return { value: result, conflict, lost };
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

function shortened(conflict: SyncConflict): SyncConflict {
  const value = conflict.lostValue;
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return { ...conflict, lostValue: text.slice(0, truncatedLength), truncated: true };
}

export function withConflicts(entity: Entity, added: SyncConflict[]): Entity {
  if (!added.length) return entity;
  const { [conflictsKey]: _previous, ...rest } = entity.properties || {};
  const room = Math.min(maxConflictsSize, serverPropertiesLimit - propertiesMargin - JSON.stringify(rest).length);
  let conflicts = [...entityConflicts(entity), ...added].slice(-maxConflicts);
  const size = () => JSON.stringify(conflicts).length;
  // Long values are shortened first (newest last, so the newest keeps its full value longest),
  // then the oldest notices go.
  for (let index = 0; index < conflicts.length && size() > room; index += 1) {
    if (!conflicts[index].truncated && JSON.stringify(conflicts[index].lostValue ?? null).length > truncatedLength) conflicts[index] = shortened(conflicts[index]);
  }
  while (conflicts.length && size() > room) conflicts = conflicts.slice(1);
  const properties: Record<string, unknown> = { ...rest };
  if (conflicts.length) properties[conflictsKey] = conflicts;
  return { ...entity, properties };
}

// All records together keep at most `limit` characters of notices, so that many unresolved ones
// cannot make the whole save too large for the server; the oldest notices go first.
export function limitConflicts(entities: Entity[], limit = maxConflictsTotal): Entity[] {
  const all = entities.flatMap((entity) => entityConflicts(entity).map((conflict) => ({ entityId: entity.id, conflict, size: JSON.stringify(conflict).length })));
  let total = all.reduce((sum, item) => sum + item.size, 0);
  if (total <= limit) return entities;
  const dropped = new Set<string>();
  for (const item of [...all].sort((a, b) => a.conflict.at - b.conflict.at)) {
    if (total <= limit) break;
    dropped.add(item.conflict.id);
    total -= item.size;
  }
  return entities.map((entity) => {
    const conflicts = entityConflicts(entity);
    if (!conflicts.some((conflict) => dropped.has(conflict.id))) return entity;
    const kept = conflicts.filter((conflict) => !dropped.has(conflict.id));
    const { [conflictsKey]: _previous, ...rest } = entity.properties;
    return { ...entity, properties: kept.length ? { ...rest, [conflictsKey]: kept } : rest };
  });
}

export function mergeEntity(base: Entity, local: Entity, server: Entity, now = Date.now()): Entity {
  // A side that did not change the record takes the other as it is. This compares content: a
  // merged record keeps the larger of the two timestamps, so an equal updatedAt does not prove
  // that nothing changed.
  if (same(local, base)) return server;
  if (same(server, base)) return local;
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
  // Where the task sits (date, Today, Someday, Inbox) is one choice: its fields are merged together,
  // or two moves to different lists would leave the task in both. Sides are compared with `false`,
  // "" and a missing field meaning the same (code paths write either); the fields themselves are
  // taken as the chosen side wrote them.
  const raw = (entity: Entity) => {
    const value: Record<string, unknown> = {};
    for (const key of placementFields) if (entity.properties?.[key] !== undefined) value[key] = entity.properties[key];
    return value;
  };
  const meaning = (entity: Entity) => {
    const value: Record<string, unknown> = {};
    for (const key of placementFields) {
      const field = entity.properties?.[key];
      if (field !== undefined && field !== null && field !== false && field !== "") value[key] = field;
    }
    return value;
  };
  const [pb, pl, ps] = [meaning(base), meaning(local), meaning(server)];
  let chosen: Entity = server;
  if (!same(pl, ps) && !same(pl, pb)) {
    if (same(ps, pb)) chosen = local;
    else {
      chosen = localWins ? local : server;
      record("properties.placement", { value: undefined, lost: raw(localWins ? server : local), conflict: true });
    }
  }
  Object.assign(properties, raw(chosen));
  const keys = new Set([...Object.keys(base.properties || {}), ...Object.keys(local.properties || {}), ...Object.keys(server.properties || {})]);
  for (const key of placementFields) keys.delete(key);
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
          conflicts.push({ id: conflictId(now), field: "properties.checklist", lostValue: items.lost, at: now });
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
