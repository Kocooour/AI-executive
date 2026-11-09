// Offline synthetic-only triage. This previews source segments, never claim review.
// Neither a fixture marker nor a provenance label authorizes use with real exports.
import { advanceSyntheticImport, parseSyntheticBundle } from "./ingest.mjs";
import { previewSyntheticOverlaps } from "./overlap.mjs";

const reasons = Object.freeze({
  owner_statement: "owner_statement_unverified",
  assistant_generated: "assistant_output_not_owner_evidence",
  quoted_third_party: "quoted_third_party_unverified",
  unknown: "unknown_speaker_unverified",
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const locatorKey = locator => JSON.stringify([
  locator.source_id, locator.conversation_id, locator.message_id, locator.segment,
]);

/**
 * Stable, content-free review preview for exactly two fictional source bundles.
 * A queue entry is an unclassified SOURCE SEGMENT, not a proposed fact or claim.
 * This function never approves, rejects, persists, or calls any model.
 */
export function previewSyntheticReviewQueue(bundles) {
  // The overlap contract checks the exact count, synthetic markers, source IDs,
  // duplicates and parser limits, even when no matching text exists.
  const overlap = previewSyntheticOverlaps(bundles);
  const matched = new Map();
  for (const group of overlap.groups) {
    for (const member of group.members) {
      const key = locatorKey(member.locator);
      if (matched.has(key)) throw new Error("Synthetic review: duplicate source locator");
      matched.set(key, { group_id: group.id, cross_source: group.cross_source });
    }
  }

  const sources = bundles.map(bundle => parseSyntheticBundle(bundle))
    .sort((a, b) => compare(a.source_id, b.source_id));
  const counts = Object.fromEntries(Object.keys(reasons).map(type => [type, 0]));
  const entries = [];
  for (const source of sources) {
    const state = advanceSyntheticImport(source);
    for (const record of state.records) {
      if (!Object.hasOwn(reasons, record.provenance) ||
          record.review !== "proposed" || record.freshness !== "current" ||
          record.disputed !== false || record.sensitivity !== "unclassified" ||
          record.scope !== "owner_private_unassigned") {
        throw new Error("Synthetic review: unexpected staging state");
      }
      const matching = matched.get(locatorKey(record.locator));
      const reason_codes = [reasons[record.provenance]];
      if (matching) reason_codes.push("repeated_text_not_independent_evidence");
      counts[record.provenance]++;
      entries.push({
        locator: { ...record.locator },
        observed_at: record.observed_at,
        speaker: record.speaker,
        enclosing_message_speaker: record.enclosing_message_speaker,
        provenance: record.provenance,
        reason_codes,
        duplicate_group_id: matching?.group_id ?? null,
        cross_source_repeat: matching?.cross_source ?? false,
        independent_evidence: false,
        review: "proposed",
        freshness: "current",
        disputed: false,
        sensitivity: "unclassified",
        scope: "owner_private_unassigned",
        requires_explicit_review: true,
        eligible_for_automatic_confirmation: false,
      });
    }
  }
  if (entries.length !== overlap.segments_total) {
    throw new Error("Synthetic review: staged segment count mismatch");
  }
  return {
    synthetic_fixture_only: true,
    sources: overlap.sources,
    segments_total: entries.length,
    duplicate_groups: overlap.duplicate_groups,
    provenance_counts: counts,
    entries,
    claims_created: 0,
    review_outcomes_written: 0,
    real_import_enabled: false,
  };
}
