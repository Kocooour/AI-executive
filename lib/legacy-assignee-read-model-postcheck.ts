// 2c, part 6: pure, caller-supplied Home/Today/Inbox read-model preservation check.
// No SQLite reads, view queries, writes, migration authorization, hold release,
// My Plan activation, sharing or attestation of authoritative persisted state.
import {
  checkLegacyAssigneeMetadataPreservation,
  type LegacyAssigneeMetadataPostcheck,
  type LegacyAssigneeMetadataSnapshot,
} from "./legacy-assignee-metadata-postcheck";

const VIEW_NAMES = ["home", "today", "inbox"] as const;
const CONTEXT_FIELDS = ["actorUserId", "asOf", "timezone", "queryFingerprint"] as const;
type ViewName = (typeof VIEW_NAMES)[number];
type ContextField = (typeof CONTEXT_FIELDS)[number];

// These are *opaque* results of the same hypothetical reads, not query inputs.
// The caller must supply the complete ordered response for each view for the
// same actor, date/time, timezone and exact filter/sort/query configuration.
// All provenance, completeness and server ACL assertions remain unverified.
export type LegacyAssigneeReadModels = Readonly<{
  context: Readonly<Record<ContextField, string>>;
  home: unknown;
  today: unknown;
  inbox: unknown;
}>;

export type LegacyAssigneeReadModelSnapshot = LegacyAssigneeMetadataSnapshot & Readonly<{
  readModels: LegacyAssigneeReadModels;
}>;

export type LegacyAssigneeReadModelPostcheckInput = Readonly<{
  before: LegacyAssigneeReadModelSnapshot;
  after: LegacyAssigneeReadModelSnapshot;
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneeReadModelPostcheck = Readonly<
  Omit<LegacyAssigneeMetadataPostcheck, "phase"> & {
    phase: "legacy-assignee-read-model-postcheck-only";
    comparedReadModelCount: 3;
  }
>;

export class LegacyAssigneeReadModelPostcheckBlocked extends Error {
  constructor() {
    super("Legacy assignee read-model postcheck blocked");
    this.name = "LegacyAssigneeReadModelPostcheckBlocked";
  }
}
const blocked = (): never => { throw new LegacyAssigneeReadModelPostcheckBlocked(); };

// Guard *during* traversal, before allocating serialized representations.
// Limits cover all six views together, and prevent unbounded recursive walks.
const MAX_VIEW_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 8_000_000;
const MAX_NODES = 120_000;
const MAX_CONTAINER_MEMBERS = 20_000;
const MAX_DEPTH = 48;
const MAX_STRING_CHARS = 500_000;
const MAX_KEY_CHARS = 256;

function ownValues(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) blocked();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) blocked();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length ||
      keys.some(key => typeof key !== "string" || !required.includes(key))) blocked();
  const values: Record<string, unknown> = Object.create(null);
  for (const key of required) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property)) blocked();
    values[key] = property.value;
  }
  return values;
}

function readModels(value: unknown): {
  context: Record<ContextField, string>;
  views: Record<ViewName, unknown>;
} {
  const envelope = ownValues(value, ["context", ...VIEW_NAMES]);
  const rawContext = ownValues(envelope.context, CONTEXT_FIELDS);
  const context = Object.create(null) as Record<ContextField, string>;
  for (const field of CONTEXT_FIELDS) {
    const fieldValue = rawContext[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim() ||
        fieldValue.length > MAX_STRING_CHARS) blocked();
    context[field] = fieldValue;
  }
  const views = Object.create(null) as Record<ViewName, unknown>;
  for (const view of VIEW_NAMES) {
    const result = envelope[view];
    if (!result || typeof result !== "object") blocked();
    views[view] = result;
  }
  return { context, views };
}

function canonicalView(
  value: unknown,
  budget: { remainingChars: number; remainingNodes: number },
): string {
  const parts: string[] = [];
  const ancestors = new WeakSet<object>();
  let viewChars = 0;

  const append = (part: string): void => {
    viewChars += part.length;
    budget.remainingChars -= part.length;
    if (viewChars > MAX_VIEW_CHARS || budget.remainingChars < 0) blocked();
    parts.push(part);
  };

  const walk = (item: unknown, depth: number): void => {
    budget.remainingNodes--;
    if (budget.remainingNodes < 0 || depth > MAX_DEPTH) blocked();

    if (item === null) { append("null"); return; }
    if (typeof item === "string") {
      if (item.length > MAX_STRING_CHARS ||
          item.length > MAX_VIEW_CHARS - viewChars ||
          item.length > budget.remainingChars) blocked();
      append("s");
      append(JSON.stringify(item));
      return;
    }
    if (typeof item === "boolean") { append(item ? "true" : "false"); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) ||
          (Number.isInteger(item) && !Number.isSafeInteger(item))) blocked();
      append(Object.is(item, -0) ? "n-0" : "n" + JSON.stringify(item));
      return;
    }
    if (!item || typeof item !== "object") blocked();
    const object = item as object;
    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(object);
    if (isArray ? prototype !== Array.prototype :
        prototype !== Object.prototype && prototype !== null) blocked();
    if (ancestors.has(object)) blocked();
    ancestors.add(object);
    try {
      if (isArray) {
        const array = item as unknown[];
        if (array.length > MAX_CONTAINER_MEMBERS ||
            Reflect.ownKeys(array).length !== array.length + 1) blocked();
        append("a[");
        for (let i = 0; i < array.length; i++) {
          const entry = Object.getOwnPropertyDescriptor(array, String(i));
          if (!entry || !entry.enumerable || !("value" in entry)) blocked();
          if (i) append(",");
          walk(entry.value, depth + 1);
        }
        append("]");
      } else {
        const keys = Reflect.ownKeys(object);
        if (keys.length > MAX_CONTAINER_MEMBERS ||
            keys.some(key => typeof key !== "string" || key.length > MAX_KEY_CHARS)) blocked();
        const sorted = (keys as string[]).sort();
        append("o{");
        for (let i = 0; i < sorted.length; i++) {
          const key = sorted[i];
          const property = Object.getOwnPropertyDescriptor(object, key);
          if (!property || !property.enumerable || !("value" in property)) blocked();
          if (i) append(",");
          append(JSON.stringify(key));
          append(":");
          walk(property.value, depth + 1);
        }
        append("}");
      }
    } finally {
      ancestors.delete(object);
    }
  };
  walk(value, 0);
  return parts.join("");
}

/**
 * Compare complete, ordered Home/Today/Inbox outputs for an identical claimed
 * read context, on the same pair passed to all prior 2c diagnostics.
 *
 * Input is untrusted, and identical fabricated snapshots prove nothing about
 * real read models, ACLs, query completeness, materialization or production.
 */
export function checkLegacyAssigneeReadModelPreservation(
  input: LegacyAssigneeReadModelPostcheckInput,
): LegacyAssigneeReadModelPostcheck {
  try {
    if (!input || !input.before || !input.after) blocked();

    const before = readModels(input.before.readModels);
    const after = readModels(input.after.readModels);
    for (const field of CONTEXT_FIELDS) {
      if (before.context[field] !== after.context[field]) blocked();
    }

    const budget = { remainingChars: MAX_TOTAL_CHARS, remainingNodes: MAX_NODES };
    for (const name of VIEW_NAMES) {
      const original = canonicalView(before.views[name], budget);
      const result = canonicalView(after.views[name], budget);
      if (original !== result) blocked();
    }

    const prior = checkLegacyAssigneeMetadataPreservation({
      before: input.before,
      after: input.after,
      legacySharedWorkspaceIds: input.legacySharedWorkspaceIds,
    });
    return Object.freeze({
      ...prior,
      phase: "legacy-assignee-read-model-postcheck-only" as const,
      comparedReadModelCount: 3 as const,
      // All inherited verification and authorization flags remain false.
    });
  } catch {
    blocked();
  }
}
