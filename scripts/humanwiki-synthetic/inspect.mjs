// Fixture-only, side-effect-free inspection. Never use for real personal exports.
import { advanceSyntheticImport } from "./ingest.mjs";

const provenanceTypes = Object.freeze([
  "owner_statement", "assistant_generated", "quoted_third_party", "unknown",
]);
const error = detail => { throw new Error(`Synthetic inspection: ${detail}`); };

/**
 * Return a deterministic NON-CONTENT inventory for already parsed synthetic data.
 * A supplied checkpoint is validated via the normal replay path before counting.
 * This is not a claim extractor, consent UI, or production security boundary.
 */
export function inspectSyntheticImport(parsed, prior = undefined) {
  if (!parsed || parsed.format !== "chatgpt-mapping-v1" &&
      parsed?.format !== "claude-chat-v1" ||
      typeof parsed.source_id !== "string" || !parsed.source_id ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) || !Array.isArray(parsed.messages)) {
    error("invalid parsed synthetic bundle");
  }
  const checkpoint = advanceSyntheticImport(parsed, prior, 0);
  const provenance_segments = Object.fromEntries(provenanceTypes.map(type => [type, 0]));
  let segments = 0;
  let processedSegments = 0;
  for (const [index, message] of parsed.messages.entries()) {
    if (!message || !Array.isArray(message.segments)) error("invalid message segments");
    for (const segment of message.segments) {
      if (!segment || !Object.hasOwn(provenance_segments, segment.provenance)) {
        error("unknown segment provenance");
      }
      provenance_segments[segment.provenance]++;
      segments++;
      if (index < checkpoint.next_message) processedSegments++;
    }
  }
  if (checkpoint.records.length !== processedSegments) error("checkpoint segment count mismatch");
  return {
    synthetic_fixture_only: true,
    source_id: parsed.source_id,
    format: parsed.format,
    bundle_sha256: parsed.digest,
    messages_total: parsed.messages.length,
    segments_total: segments,
    messages_staged: checkpoint.next_message,
    segments_staged: processedSegments,
    messages_remaining: parsed.messages.length - checkpoint.next_message,
    segments_remaining: segments - processedSegments,
    provenance_segments,
    sensitivity: "unclassified",
    review: "proposed",
    claims_created: 0,
    real_import_enabled: false,
  };
}
