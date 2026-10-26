// 2c, part 8: collision-resistant, bounded state consistency fingerprints.
// Only run after parts 1–6 validate the caller-supplied snapshots. Fingerprints
// are internal comparisons, never attestation of actual SQLite state or ACLs.
import { createHash, type Hash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { LegacyAssigneeReadModelSnapshot } from "./legacy-assignee-read-model-postcheck";

export type MatrixFingerprintBudget = {
  remainingNodes: number;
  remainingStringChars: number;
};

export const matrixFingerprintBudget = (): MatrixFingerprintBudget => ({
  // Across *all* before/after snapshots and contexts, not per row or case.
  remainingNodes: 1_000_000,
  remainingStringChars: 64_000_000,
});

const MAX_DEPTH = 96;
const MAX_MEMBERS = 100_000;
const invalid = (): never => { throw new Error("Invalid matrix state fingerprint input"); };

function spend(budget: MatrixFingerprintBudget, nodes: number, chars = 0): void {
  budget.remainingNodes -= nodes;
  budget.remainingStringChars -= chars;
  if (budget.remainingNodes < 0 || budget.remainingStringChars < 0) invalid();
}

function stringPart(hash: Hash, value: string, budget: MatrixFingerprintBudget): void {
  spend(budget, 0, value.length);
  // UTF-16LE deliberately distinguishes unpaired surrogate code units, unlike
  // a UTF-8 replacement encoder. Framing uses the exact number of code units.
  hash.update("s" + value.length + ":");
  hash.update(value, "utf16le");
}

function valueFingerprint(value: unknown, budget: MatrixFingerprintBudget): string {
  const hash = createHash("sha256");
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) invalid();
    spend(budget, 1);
    if (item === null) { hash.update("n"); return; }
    if (typeof item === "string") { stringPart(hash, item, budget); return; }
    if (typeof item === "boolean") { hash.update(item ? "t" : "f"); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid();
      hash.update("d" + (Object.is(item, -0) ? "-0" : String(item)) + ";");
      return;
    }
    if (!item || typeof item !== "object" || nodeTypes.isProxy(item)) invalid();
    const object = item as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    if (ancestors.has(object)) invalid();
    ancestors.add(object);
    try {
      const keys = Reflect.ownKeys(object);
      if (keys.length > MAX_MEMBERS || keys.some(key => typeof key !== "string")) invalid();
      if (array) {
        const values = item as unknown[];
        if (values.length > MAX_MEMBERS || keys.length !== values.length + 1) invalid();
        hash.update("a" + values.length + ":");
        for (let i = 0; i < values.length; i++) {
          const entry = Object.getOwnPropertyDescriptor(values, String(i));
          if (!entry || !entry.enumerable || !("value" in entry)) invalid();
          visit(entry.value, depth + 1);
        }
        hash.update("]");
      } else {
        const ordered = (keys as string[]).sort();
        hash.update("o" + ordered.length + ":");
        for (const key of ordered) {
          const entry = Object.getOwnPropertyDescriptor(object, key);
          if (!entry || !entry.enumerable || !("value" in entry)) invalid();
          stringPart(hash, key, budget);
          visit(entry.value, depth + 1);
        }
        hash.update("}");
      }
    } finally {
      ancestors.delete(object);
    }
  };
  visit(value, 0);
  return hash.digest("hex");
}

// Canonical store collections and SQLite side tables have no row order;
// preserve every duplicate by sorting all per-row digests (a multiset).
function rowMultisetFingerprint(rows: unknown, budget: MatrixFingerprintBudget): string {
  if (nodeTypes.isProxy(rows) || !Array.isArray(rows)) invalid();
  const array = rows as unknown[];
  if (Object.getPrototypeOf(array) !== Array.prototype ||
      array.length > MAX_MEMBERS || Reflect.ownKeys(array).length !== array.length + 1) invalid();
  const digests: string[] = [];
  for (let i = 0; i < array.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(array, String(i));
    if (!entry || !entry.enumerable || !("value" in entry)) invalid();
    digests.push(valueFingerprint(entry.value, budget));
  }
  digests.sort();
  const hash = createHash("sha256");
  hash.update("row-multiset-v1:" + digests.length + ":");
  for (const digest of digests) hash.update(digest);
  return hash.digest("hex");
}

function storeFingerprint(
  snapshot: LegacyAssigneeReadModelSnapshot,
  budget: MatrixFingerprintBudget,
): string {
  const hash = createHash("sha256");
  hash.update("2c-store-v1:");
  hash.update(valueFingerprint(snapshot.revision, budget));
  hash.update(valueFingerprint(snapshot.restoreGeneration, budget));
  for (const rows of [snapshot.entities, snapshot.relations, snapshot.tombstones, snapshot.metadata]) {
    hash.update(rowMultisetFingerprint(rows, budget));
  }

  const tables = snapshot.sideTables;
  if (!tables || typeof tables !== "object" || nodeTypes.isProxy(tables) || Array.isArray(tables)) invalid();
  const prototype = Object.getPrototypeOf(tables);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(tables);
  if (keys.length > MAX_MEMBERS || keys.some(key => typeof key !== "string")) invalid();
  const names = (keys as string[]).sort();
  hash.update("tables:" + names.length + ":");
  for (const name of names) {
    const entry = Object.getOwnPropertyDescriptor(tables, name);
    if (!entry || !entry.enumerable || !("value" in entry)) invalid();
    hash.update(valueFingerprint(name, budget));
    hash.update(rowMultisetFingerprint(entry.value, budget));
  }
  return hash.digest("hex");
}

/** Compare one claimed shared persisted transition, excluding actor-specific views. */
export function matrixStoreTransitionFingerprint(
  before: LegacyAssigneeReadModelSnapshot,
  after: LegacyAssigneeReadModelSnapshot,
  budget: MatrixFingerprintBudget,
): string {
  const hash = createHash("sha256");
  hash.update("2c-transition-v1:");
  hash.update(storeFingerprint(before, budget));
  hash.update(storeFingerprint(after, budget));
  return hash.digest("hex");
}
