// The store's restore generation is an integer, not by itself permission to
// discard local data. Its origin is certified by server metadata bound to
// *that exact generation*. Importing a backup cannot import this metadata.
export const ownerRestoreKind = "owner_restore" as const;
export type RestoreKind = typeof ownerRestoreKind;

export function ownerRestoreOrigin(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation <= 0)
    throw new Error("Invalid restore generation");
  return JSON.stringify({ version: 1, generation, kind: ownerRestoreKind });
}

// Missing, stale, malformed or future unknown origins are NOT evidence of an
// owner restore. A future partition-recovery writer must use another origin;
// changing the generation alone intentionally leaves this decision closed.
export function restoreKindForGeneration(generation: number, raw: string): RestoreKind | undefined {
  if (!Number.isSafeInteger(generation) || generation <= 0) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || item.version !== 1 ||
        item.generation !== generation || item.kind !== ownerRestoreKind) return undefined;
    return ownerRestoreKind;
  } catch { return undefined; }
}

export function restoredSinceKnownGeneration(
  known: number | undefined, observed: number | undefined, previouslySynced: boolean,
): boolean {
  if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0) return false;
  if (known !== undefined) return observed !== known;
  return observed > 0 && previouslySynced;
}

// The only automatic destructive adoption is a server-certified owner restore.
// An ordinary newer revision never discards local edits. An existing D2b rescue
// hold always wins and is not silently cleared by this decision.
export function restoreGenerationDecision(
  generationChanged: boolean, kind: unknown, recoveryHeld: boolean,
): "normal" | "adopt" | "hold" {
  if (recoveryHeld) return "hold";
  if (!generationChanged) return "normal";
  return kind === ownerRestoreKind ? "adopt" : "hold";
}
