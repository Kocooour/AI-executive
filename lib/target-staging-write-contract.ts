/**
 * R2c.3 HTTP-side write contract shared by every WRITE target-staging endpoint
 * (title PATCH, title status, delete, delete status, membership command): the
 * protocol-version header and the legacy-snapshot payload barrier. The
 * transactional parts (restore generation, Area checks) live in the writers.
 * The header name and the codes are the mechanism proposed to the owner.
 */
export const TARGET_PROTOCOL_HEADER = "x-lumi-target-protocol";
export const TARGET_PROTOCOL_VERSION = "1";

const headers = { "cache-control": "no-store" };
const LEGACY_SNAPSHOT_KEYS = ["entities", "relations", "baseRevision"];

/**
 * Exactly one header with the value "1". A repeated header arrives joined
 * ("1, 1") and is therefore rejected like any other value.
 */
export function targetProtocolRefusal(request: Request): Response | null {
  return request.headers.get(TARGET_PROTOCOL_HEADER) === TARGET_PROTOCOL_VERSION ? null
    : Response.json({ error: "Invalid request", code: "protocol_unsupported" },
      { status: 400, headers });
}

/** A snapshot-shaped (legacy /api/store style) payload is never a per-item command. */
export function legacySnapshotRefusal(input: unknown): Response | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return LEGACY_SNAPSHOT_KEYS.some(key => Object.hasOwn(input, key))
    ? Response.json({ error: "Invalid request", code: "legacy_snapshot_rejected" },
      { status: 400, headers })
    : null;
}

/** Store-level, content-free refusal: the client must re-synchronize before writing. */
export const resyncRequiredResponse = (): Response =>
  Response.json({ error: "Resync required", code: "resync_required" }, { status: 409, headers });

export const writeAreaMismatchResponse = (): Response =>
  Response.json({ error: "Revision conflict", code: "write_area_mismatch" }, { status: 409, headers });
