// Canonical fail-closed JSON snapshot validation and comparison for 2c
// read-only diagnostics. Never use lossy serialization for preservation checks.
// These snapshots represent persisted JSON entities. Reject exotic in-memory
// values instead of letting JSON serialization hide differences (for example,
// Date objects stringify as {}, and NaN stringifies as null).
import { types as nodeTypes } from "node:util";

export function isJsonData(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  // Reject proxies (including revoked proxies) without running their handlers.
  if (typeof value !== "object" || nodeTypes.isProxy(value) || ancestors.has(value)) return false;

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
export function equalJsonData(a: unknown, b: unknown): boolean {
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

