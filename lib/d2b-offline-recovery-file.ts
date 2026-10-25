// D2b (part 3): local-only, owner-controlled transport for an offline rescue package.
// Never creates a download, reads a file, sends a request, stores data or replays it.
// Recovery packages contain PRIVATE owner data: never log, cache, send to AI or put in URLs.
import {
  assessOfflineRecovery,
  OfflineRecoveryInvalid,
  type OfflineRecoveryAssessment,
  type OfflineRecoveryBundle,
} from "./d2b-offline-reconciliation";
import type { Entity, Relation } from "./db";

// A character-count cap in the reconciliation contract is NOT a UTF-8 byte cap.
// Bound the actual byte array before handing it to a browser download or JSON parser.
export const offlineRecoveryFile = Object.freeze({
  filename: "lumi-offline-recovery.json", // no entity/user names in file names
  unverifiedFilename: "lumi-offline-recovery-unverified.json", // no fresh server verification; same strict v1 schema
  mimeType: "application/json;charset=utf-8",
  maxUtf8Bytes: 12 * 1024 * 1024,
});

export type OfflineRecoveryServer = {
  restoreGeneration: number;
  entities: readonly Entity[];
  relations: readonly Relation[];
};

function checkByteSize(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > offlineRecoveryFile.maxUtf8Bytes) {
    throw new OfflineRecoveryInvalid();
  }
}

/** Serialize a PREPARED, integrity-checked bundle to a private in-memory byte array.
 * The caller must obtain explicit owner consent before initiating any download.
 * This function is deliberately not connected to the browser, UI or useSync.
 */
export function encodeOfflineRecoveryFile(bundle: OfflineRecoveryBundle): Uint8Array {
  if (!bundle || typeof bundle !== "object" ||
      !Number.isSafeInteger(bundle.observedRestoreGeneration)) {
    throw new OfflineRecoveryInvalid();
  }
  // The same fail-closed schema, limits and SHA validator used on import.
  // No real server data or network access is involved in this export check.
  assessOfflineRecovery(bundle, {
    restoreGeneration: bundle.observedRestoreGeneration,
    entities: [],
    relations: [],
  });
  let serialized: string;
  try { serialized = JSON.stringify(bundle); }
  catch { throw new OfflineRecoveryInvalid(); }
  const bytes = new TextEncoder().encode(serialized);
  checkByteSize(bytes);
  return bytes;
}

/** Parse a user-supplied rescue file against an explicitly provided CURRENT server snapshot.
 * Import performs diagnosis ONLY; no changes are applied, even for 'already-present'.
 * Workspace membership and Area permissions require an independent authorization review.
 * Callers must not log the bytes, bundle or diagnostic IDs.
 */
export function decodeOfflineRecoveryFile(
  bytes: Uint8Array,
  server: OfflineRecoveryServer,
): { bundle: OfflineRecoveryBundle; assessment: OfflineRecoveryAssessment } {
  checkByteSize(bytes); // bound BEFORE decoding or JSON.parse
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    throw new OfflineRecoveryInvalid();
  }
  // SHA-256 checks accidental corruption only. assessOfflineRecovery separately
  // validates the full v1 schema, generation bounds and current server IDs.
  const bundle = parsed as OfflineRecoveryBundle;
  const assessment = assessOfflineRecovery(bundle, server);
  return { bundle, assessment };
}
